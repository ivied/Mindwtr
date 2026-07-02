import { buildSaveSnapshot, ensureDeviceId, getNextDataChangeAt, getTaskOrder, nextRevision, selectVisibleTasks } from '../store-helpers';
import type { OrderingActions, Project, ProjectActionContext, Section, Task, TaskStatus } from './shared';

const ORDER_STEP = 1024;
const ORDER_EPSILON = 0.000001;

type SparseOrderPlan =
    | { kind: 'single'; id: string; order: number }
    | { kind: 'rebalance'; orderById: Map<string, number> };

const finiteOrder = (value: number | null | undefined): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

const sameOrder = (left: string[], right: string[]): boolean => (
    left.length === right.length && left.every((id, index) => id === right[index])
);

const uniqueValidIds = (orderedIds: string[], validIds: Set<string>): string[] => {
    const seen = new Set<string>();
    return orderedIds.filter((id) => {
        if (!validIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
    });
};

const finalOrderedIds = (currentIds: string[], orderedIds: string[]): string[] => {
    const orderedSet = new Set(orderedIds);
    return [...orderedIds, ...currentIds.filter((id) => !orderedSet.has(id))];
};

const findSingleMovedId = (currentIds: string[], nextIds: string[]): string | null => {
    if (currentIds.length !== nextIds.length || sameOrder(currentIds, nextIds)) return null;
    if (new Set(currentIds).size !== currentIds.length || new Set(nextIds).size !== nextIds.length) return null;

    const changedIds = new Set<string>();
    nextIds.forEach((id, index) => {
        if (currentIds[index] !== id) {
            changedIds.add(id);
            const currentId = currentIds[index];
            if (currentId) changedIds.add(currentId);
        }
    });

    for (const id of changedIds) {
        const fromIndex = currentIds.indexOf(id);
        const toIndex = nextIds.indexOf(id);
        if (fromIndex === -1 || toIndex === -1) continue;
        const candidate = currentIds.slice();
        candidate.splice(fromIndex, 1);
        candidate.splice(toIndex, 0, id);
        if (sameOrder(candidate, nextIds)) return id;
    }
    return null;
};

const sparseOrderForMove = (
    nextIds: string[],
    movedId: string,
    orderById: Map<string, number | undefined>,
): number | null => {
    const index = nextIds.indexOf(movedId);
    if (index === -1) return null;

    const previousId = nextIds[index - 1];
    const nextId = nextIds[index + 1];
    const previousOrder = previousId ? finiteOrder(orderById.get(previousId)) : undefined;
    const nextOrder = nextId ? finiteOrder(orderById.get(nextId)) : undefined;

    if (!previousId && !nextId) return finiteOrder(orderById.get(movedId)) ?? 0;
    if (!previousId) return nextOrder === undefined ? 0 : nextOrder - ORDER_STEP;
    if (previousOrder === undefined) return null;
    if (!nextId) return previousOrder + ORDER_STEP;
    if (nextOrder === undefined) return previousOrder + ORDER_STEP;
    if (nextOrder - previousOrder <= ORDER_EPSILON) return null;
    return (previousOrder + nextOrder) / 2;
};

const createSparseOrderPlan = (
    currentIds: string[],
    nextIds: string[],
    orderById: Map<string, number | undefined>,
): SparseOrderPlan | null => {
    if (sameOrder(currentIds, nextIds)) return null;

    const movedId = findSingleMovedId(currentIds, nextIds);
    if (movedId) {
        const order = sparseOrderForMove(nextIds, movedId, orderById);
        if (order !== null && Number.isFinite(order)) {
            return { kind: 'single', id: movedId, order };
        }
    }

    const rebalanceOrderById = new Map<string, number>();
    nextIds.forEach((id, index) => {
        rebalanceOrderById.set(id, index * ORDER_STEP);
    });
    return { kind: 'rebalance', orderById: rebalanceOrderById };
};

const orderFromPlan = (plan: SparseOrderPlan, id: string): number | undefined => (
    plan.kind === 'single' ? (plan.id === id ? plan.order : undefined) : plan.orderById.get(id)
);

export const createOrderingActions = ({
    set,
    debouncedSave,
}: ProjectActionContext): OrderingActions => ({
    reorderProjects: async (orderedIds: string[], areaId?: string) => {
        if (orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const targetAreaId = areaId ?? undefined;
        let snapshot = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const allProjects = state._allProjects;
            const isInArea = (project: Project) => (project.areaId ?? undefined) === targetAreaId && !project.deletedAt;

            const areaProjects = allProjects.filter(isInArea);
            const currentIds = areaProjects
                .sort((a, b) => (Number.isFinite(a.order) ? a.order : 0) - (Number.isFinite(b.order) ? b.order : 0))
                .map((project) => project.id);
            const validOrderedIds = uniqueValidIds(orderedIds, new Set(currentIds));
            if (validOrderedIds.length === 0) return state;
            const nextIds = finalOrderedIds(currentIds, validOrderedIds);
            const orderById = new Map(areaProjects.map((project) => [project.id, finiteOrder(project.order)]));
            const orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
            if (!orderPlan) return state;

            const newAllProjects = allProjects.map((project) => {
                if (!isInArea(project)) return project;
                const nextOrder = orderFromPlan(orderPlan, project.id);
                if (!Number.isFinite(nextOrder)) return project;
                if (project.order === nextOrder) return project;
                return {
                    ...project,
                    order: nextOrder as number,
                    updatedAt: now,
                    rev: nextRevision(project.rev),
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleProjects = newAllProjects.filter((p) => !p.deletedAt);
            snapshot = buildSaveSnapshot(state, {
                projects: newAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                projects: newVisibleProjects,
                _allProjects: newAllProjects,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    reorderSections: async (projectId: string, orderedIds: string[]) => {
        if (!projectId || orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        set((state) => {
            const projectExists = state._allProjects.some((project) => project.id === projectId && !project.deletedAt);
            if (!projectExists) return state;

            const deviceState = ensureDeviceId(state.settings);
            const allSections = state._allSections;
            const isInProject = (section: Section) => section.projectId === projectId && !section.deletedAt;
            const projectSections = allSections.filter(isInProject);
            const projectSectionIds = new Set(projectSections.map((section) => section.id));
            const validOrderedIds = orderedIds.filter((id) => projectSectionIds.has(id));
            if (validOrderedIds.length === 0) return state;

            const currentIds = projectSections
                .sort((a, b) => {
                    const aOrder = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
                    const bOrder = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return a.title.localeCompare(b.title);
                })
                .map((section) => section.id);
            const nextIds = finalOrderedIds(currentIds, uniqueValidIds(validOrderedIds, projectSectionIds));
            const orderById = new Map(projectSections.map((section) => [section.id, finiteOrder(section.order)]));
            const orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
            if (!orderPlan) return state;

            const newAllSections = allSections.map((section) => {
                if (!isInProject(section)) return section;
                const nextOrder = orderFromPlan(orderPlan, section.id);
                if (!Number.isFinite(nextOrder)) return section;
                if (section.order === nextOrder) return section;
                return {
                    ...section,
                    order: nextOrder as number,
                    updatedAt: now,
                    rev: nextRevision(section.rev),
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleSections = newAllSections.filter((section) => !section.deletedAt);
            snapshot = buildSaveSnapshot(state, {
                sections: newAllSections,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                sections: newVisibleSections,
                _allSections: newAllSections,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    reorderProjectTasks: async (projectId: string, orderedIds: string[], sectionId?: string | null) => {
        if (!projectId || orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const allTasks = state._allTasks;
            const hasSectionFilter = sectionId !== undefined;
            const isInProject = (task: Task) => {
                if (task.projectId !== projectId || task.deletedAt) return false;
                if (!hasSectionFilter) return true;
                if (!sectionId) {
                    return !task.sectionId;
                }
                return task.sectionId === sectionId;
            };

            const projectTasks = allTasks.filter(isInProject);
            const projectTaskIds = new Set(projectTasks.map((task) => task.id));
            const validOrderedIds = uniqueValidIds(orderedIds, projectTaskIds);
            if (validOrderedIds.length === 0) return state;
            const currentIds = projectTasks
                .sort((a, b) => {
                    const aOrder = getTaskOrder(a) ?? Number.POSITIVE_INFINITY;
                    const bOrder = getTaskOrder(b) ?? Number.POSITIVE_INFINITY;
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                })
                .map((task) => task.id);
            const nextIds = finalOrderedIds(currentIds, validOrderedIds);
            const orderById = new Map(projectTasks.map((task) => [task.id, getTaskOrder(task)]));
            const orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
            if (!orderPlan) return state;

            const newAllTasks = allTasks.map((task) => {
                if (!isInProject(task)) return task;
                const nextOrder = orderFromPlan(orderPlan, task.id);
                if (!Number.isFinite(nextOrder)) return task;
                if (getTaskOrder(task) === nextOrder && task.order === nextOrder && task.orderNum === nextOrder) return task;
                return {
                    ...task,
                    order: nextOrder as number,
                    orderNum: nextOrder as number,
                    updatedAt: now,
                    rev: nextRevision(task.rev),
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    reorderBoardTasks: async (status: TaskStatus, orderedIds: string[]) => {
        if (!status || orderedIds.length === 0) return;
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const allTasks = state._allTasks;
            const isInColumn = (task: Task) => task.status === status && !task.deletedAt;

            const columnTasks = allTasks.filter(isInColumn);
            const columnTaskIds = new Set(columnTasks.map((task) => task.id));
            const validOrderedIds = uniqueValidIds(orderedIds, columnTaskIds);
            if (validOrderedIds.length === 0) return state;

            const currentIds = columnTasks
                .sort((a, b) => {
                    const aOrder = Number.isFinite(a.boardOrder) ? (a.boardOrder as number) : Number.POSITIVE_INFINITY;
                    const bOrder = Number.isFinite(b.boardOrder) ? (b.boardOrder as number) : Number.POSITIVE_INFINITY;
                    if (aOrder !== bOrder) return aOrder - bOrder;
                    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
                })
                .map((task) => task.id);
            const nextIds = finalOrderedIds(currentIds, validOrderedIds);
            const orderById = new Map(columnTasks.map((task) => [task.id, finiteOrder(task.boardOrder)]));
            const orderPlan = createSparseOrderPlan(currentIds, nextIds, orderById);
            if (!orderPlan) return state;

            const newAllTasks = allTasks.map((task) => {
                if (!isInColumn(task)) return task;
                const nextOrder = orderFromPlan(orderPlan, task.id);
                if (!Number.isFinite(nextOrder)) return task;
                if (task.boardOrder === nextOrder) return task;
                return {
                    ...task,
                    boardOrder: nextOrder as number,
                    updatedAt: now,
                    rev: nextRevision(task.rev),
                    revBy: deviceState.deviceId,
                };
            });

            const newVisibleTasks = selectVisibleTasks(newAllTasks);
            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },
});
