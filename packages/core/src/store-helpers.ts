import { createNextRecurringTask } from './recurrence';
import { getUsedTaskTokens } from './task-token-usage';
import { rescheduleTask } from './task-utils';
import { filterNotDeleted } from './sync-helpers';
import { nextRevision, normalizeRevision } from './sync-revision';
import type { AiSettings, AppData, Area, Project, Section, Task, TaskStatus } from './types';
import { generateUUID as uuidv4 } from './uuid';
import type { DerivedState, SaveBaseState } from './store-types';

export { MAX_SYNC_REVISION, normalizeRevision, nextRevision } from './sync-revision';

type EntityWithId = { id: string };
type EntityWithRevision = EntityWithId & {
    updatedAt?: string;
    rev?: number;
    revBy?: string;
    deletedAt?: string;
    purgedAt?: string;
};

let projectOrderCacheRef: Task[] | null = null;
let projectOrderCacheValue: Map<string, number> | null = null;
let reservedProjectOrdersRef: Task[] | null = null;
let reservedProjectOrdersValue: Map<string, number> | null = null;

export const getNextDataChangeAt = (previous: number, now = Date.now()): number => (
    Math.max(now, previous + 1)
);

export const ensureDeviceId = (settings: AppData['settings']): { settings: AppData['settings']; deviceId: string; updated: boolean } => {
    if (settings.deviceId) {
        return { settings, deviceId: settings.deviceId, updated: false };
    }
    const deviceId = uuidv4();
    return { settings: { ...settings, deviceId }, deviceId, updated: true };
};

export const getReferenceTaskFieldClears = (): Partial<Task> => ({
    status: 'reference',
    startTime: undefined,
    dueDate: undefined,
    reviewAt: undefined,
    recurrence: undefined,
    priority: undefined,
    timeEstimate: undefined,
    checklist: undefined,
    isFocusedToday: false,
    pushCount: 0,
});

export function applyTaskUpdates(oldTask: Task, updates: Partial<Task>, now: string): { updatedTask: Task; nextRecurringTask: Task | null } {
    let normalizedUpdates = updates;
    if (Object.prototype.hasOwnProperty.call(updates, 'textDirection') && updates.textDirection === undefined) {
        normalizedUpdates = { ...updates };
        delete normalizedUpdates.textDirection;
    }
    const updatesToApply = normalizedUpdates;
    const incomingStatus = updates.status ?? oldTask.status;
    const statusChanged = incomingStatus !== oldTask.status;

    let finalUpdates: Partial<Task> = updatesToApply;
    let nextRecurringTask: Task | null = null;
    const isCompleteStatus = (status: TaskStatus) => status === 'done' || status === 'archived';

    if (statusChanged && incomingStatus === 'done') {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: now,
            isFocusedToday: false,
        };
        nextRecurringTask = createNextRecurringTask(oldTask, now, oldTask.status);
    } else if (statusChanged && incomingStatus === 'archived') {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: oldTask.completedAt || now,
            isFocusedToday: false,
        };
    } else if (statusChanged && isCompleteStatus(oldTask.status) && !isCompleteStatus(incomingStatus)) {
        finalUpdates = {
            ...updatesToApply,
            status: incomingStatus,
            completedAt: undefined,
        };
    }

    if (Object.prototype.hasOwnProperty.call(updatesToApply, 'dueDate') && incomingStatus !== 'reference') {
        const rescheduled = rescheduleTask(oldTask, updatesToApply.dueDate);
        finalUpdates = {
            ...finalUpdates,
            dueDate: rescheduled.dueDate,
            pushCount: rescheduled.pushCount,
        };
    }

    // Reference tasks should be non-actionable; clear scheduling/priority fields.
    if (incomingStatus === 'reference') {
        finalUpdates = {
            ...finalUpdates,
            ...getReferenceTaskFieldClears(),
        };
    }

    return {
        updatedTask: { ...oldTask, ...finalUpdates, updatedAt: now },
        nextRecurringTask,
    };
}

export type TaskVisibilityOptions = {
    includeArchived?: boolean;
    includeDeleted?: boolean;
};

export const isTaskVisible = (task?: Task | null, options?: TaskVisibilityOptions): boolean => {
    if (!task) return false;
    const includeArchived = options?.includeArchived === true;
    const includeDeleted = options?.includeDeleted === true;
    if (!includeDeleted && task.deletedAt) return false;
    if (!includeArchived && task.status === 'archived') return false;
    return true;
};

export const toVisibleTask = (task: Task): Task => {
    const attachments = task.attachments;
    if (!attachments || attachments.length === 0) return task;
    const visibleAttachments = filterNotDeleted(attachments);
    return visibleAttachments.length === attachments.length
        ? task
        : { ...task, attachments: visibleAttachments };
};

export const selectVisibleTasks = (tasks: Task[]): Task[] =>
    tasks.filter((task) => isTaskVisible(task)).map(toVisibleTask);

export const selectVisibleProjects = (projects: Project[]): Project[] =>
    filterNotDeleted(projects);

export const selectVisibleSections = (sections: Section[]): Section[] =>
    filterNotDeleted(sections);

export const selectVisibleAreas = (areas: Area[]): Area[] =>
    filterNotDeleted(areas);

export const completeTaskForProjectArchive = (task: Task, archivedAt: string, deviceId?: string): Task => ({
    ...task,
    status: 'done',
    completedAt: archivedAt,
    isFocusedToday: false,
    statusBeforeProjectArchive: task.status,
    completedAtBeforeProjectArchive: task.completedAt ?? null,
    isFocusedTodayBeforeProjectArchive: task.isFocusedToday ?? null,
    projectArchivedAt: archivedAt,
    updatedAt: archivedAt,
    rev: nextRevision(task.rev),
    revBy: deviceId,
});

export const restoreTaskFromProjectArchive = (task: Task, restoredAt: string, deviceId?: string): Task => {
    const previousStatus = task.statusBeforeProjectArchive;
    const archivedAt = task.projectArchivedAt;
    const shouldRestore =
        !task.deletedAt &&
        Boolean(previousStatus) &&
        previousStatus !== 'done' &&
        previousStatus !== 'archived' &&
        task.status === 'done' &&
        Boolean(archivedAt) &&
        task.completedAt === archivedAt;

    if (!shouldRestore) {
        return task;
    }

    return {
        ...task,
        status: previousStatus!,
        completedAt: task.completedAtBeforeProjectArchive ?? undefined,
        isFocusedToday: task.isFocusedTodayBeforeProjectArchive ?? false,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: restoredAt,
        rev: nextRevision(task.rev),
        revBy: deviceId,
    };
};

const hasTaskProjectArchiveMetadata = (task: Task): boolean => (
    task.projectArchivedAt !== undefined
    || task.statusBeforeProjectArchive !== undefined
    || task.completedAtBeforeProjectArchive !== undefined
    || task.isFocusedTodayBeforeProjectArchive !== undefined
);

export const clearDeletedTaskProjectArchiveMetadata = (task: Task): Task => {
    if (!task.deletedAt || !hasTaskProjectArchiveMetadata(task)) return task;
    return {
        ...task,
        statusBeforeProjectArchive: undefined,
        completedAtBeforeProjectArchive: undefined,
        isFocusedTodayBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
    };
};

export const archiveSectionForProjectArchive = (section: Section, archivedAt: string, deviceId?: string): Section => ({
    ...section,
    deletedAt: archivedAt,
    deletedAtBeforeProjectArchive: section.deletedAt ?? null,
    projectArchivedAt: archivedAt,
    updatedAt: archivedAt,
    rev: nextRevision(section.rev),
    revBy: deviceId,
});

export const restoreSectionFromProjectArchive = (section: Section, restoredAt: string, deviceId?: string): Section => {
    const archivedAt = section.projectArchivedAt;
    const shouldRestore =
        Boolean(archivedAt) &&
        section.deletedAt === archivedAt &&
        section.deletedAtBeforeProjectArchive === null;

    if (!shouldRestore) {
        return section;
    }

    return {
        ...section,
        deletedAt: undefined,
        deletedAtBeforeProjectArchive: undefined,
        projectArchivedAt: undefined,
        updatedAt: restoredAt,
        rev: nextRevision(section.rev),
        revBy: deviceId,
    };
};

export const buildEntityMap = <T extends EntityWithId>(items: readonly T[]): Map<string, T> =>
    new Map(items.map((item) => [item.id, item] as const));

export const replaceEntityInArray = <T extends EntityWithId>(items: readonly T[], id: string, nextItem: T): T[] => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return items as T[];
    if (items[index] === nextItem) return items as T[];
    const nextItems = items.slice();
    nextItems[index] = nextItem;
    return nextItems;
};

export const replaceEntitiesInArray = <T extends EntityWithId>(
    items: readonly T[],
    nextItems: readonly T[]
): T[] => {
    if (nextItems.length === 0) return items as T[];
    const replacementsById = new Map(nextItems.map((item) => [item.id, item] as const));
    let patchedItems: T[] | null = null;
    for (let index = 0; index < items.length; index += 1) {
        const currentItem = items[index];
        const nextItem = replacementsById.get(currentItem.id);
        if (!nextItem || nextItem === currentItem) continue;
        if (!patchedItems) patchedItems = items.slice();
        patchedItems[index] = nextItem;
    }
    return patchedItems ?? items as T[];
};

export const replaceEntityInMap = <T extends EntityWithId>(
    itemsById: Map<string, T>,
    nextItem: T
): Map<string, T> => {
    if (itemsById.get(nextItem.id) === nextItem) return itemsById;
    const nextItemsById = new Map(itemsById);
    nextItemsById.set(nextItem.id, nextItem);
    return nextItemsById;
};

export const replaceEntitiesInMap = <T extends EntityWithId>(
    itemsById: Map<string, T>,
    nextItems: readonly T[]
): Map<string, T> => {
    if (nextItems.length === 0) return itemsById;
    let nextItemsById: Map<string, T> | null = null;
    for (const nextItem of nextItems) {
        if (itemsById.get(nextItem.id) === nextItem) continue;
        if (!nextItemsById) nextItemsById = new Map(itemsById);
        nextItemsById.set(nextItem.id, nextItem);
    }
    return nextItemsById ?? itemsById;
};

export const reuseArrayIfShallowEqual = <T>(previous: T[], next: T[]): T[] => (
    previous.length === next.length && previous.every((item, index) => item === next[index])
        ? previous
        : next
);

export const hasSameEntityIdentity = <T extends EntityWithRevision>(existing: T, incoming: T): boolean => (
    existing.updatedAt === incoming.updatedAt
    && normalizeRevision(existing.rev) === normalizeRevision(incoming.rev)
    && existing.revBy === incoming.revBy
    && existing.deletedAt === incoming.deletedAt
    && existing.purgedAt === incoming.purgedAt
);

export const reconcileEntityCollection = <T extends EntityWithRevision>(
    previousItems: readonly T[],
    previousById: Map<string, T>,
    incomingItems: readonly T[]
): { items: T[]; byId: Map<string, T> } => {
    let changed = previousItems.length !== incomingItems.length;
    const nextItems = incomingItems.map((incoming, index) => {
        const existing = previousById.get(incoming.id);
        const resolved = existing && hasSameEntityIdentity(existing, incoming) ? existing : incoming;
        if (!changed && previousItems[index] !== resolved) {
            changed = true;
        }
        return resolved;
    });

    if (!changed) {
        return {
            items: previousItems as T[],
            byId: previousById,
        };
    }

    return {
        items: nextItems,
        byId: buildEntityMap(nextItems),
    };
};

export const updateVisibleTasks = (visible: Task[], previous?: Task | null, next?: Task | null): Task[] => {
    const wasVisible = isTaskVisible(previous);
    const isVisible = isTaskVisible(next);
    const visibleNext = next && isVisible ? toVisibleTask(next) : next;
    if (wasVisible && isVisible && next) {
        return replaceEntityInArray(visible, visibleNext!.id, visibleNext!);
    }
    if (wasVisible && !isVisible && previous) {
        const index = visible.findIndex((task) => task.id === previous.id);
        if (index < 0) return visible;
        const nextVisible = visible.slice();
        nextVisible.splice(index, 1);
        return nextVisible;
    }
    if (!wasVisible && isVisible && next) {
        return [...visible, visibleNext!];
    }
    return visible;
};

const assertCollectionSnapshotIncludesExistingItems = <T extends EntityWithId>(
    label: string,
    nextItems: T[],
    previousItems: T[]
): void => {
    if (nextItems.length >= previousItems.length) return;
    const nextIds = new Set(nextItems.map((item) => item.id));
    const missingIds = previousItems
        .filter((item) => !nextIds.has(item.id))
        .slice(0, 10)
        .map((item) => item.id);
    if (missingIds.length === 0) return;
    throw new Error(
        `Refusing to save a partial ${label} snapshot; missing existing ids: ${missingIds.join(', ')}`
    );
};

export const buildSaveSnapshot = (state: SaveBaseState, overrides?: Partial<AppData>): AppData => {
    const tasks = overrides?.tasks ?? state._allTasks;
    const projects = overrides?.projects ?? state._allProjects;
    const sections = overrides?.sections ?? state._allSections;
    const areas = overrides?.areas ?? state._allAreas;
    if (overrides?.tasks) {
        assertCollectionSnapshotIncludesExistingItems<Task>('task', tasks, state._allTasks);
    }
    if (overrides?.projects) {
        assertCollectionSnapshotIncludesExistingItems<Project>('project', projects, state._allProjects);
    }
    if (overrides?.sections) {
        assertCollectionSnapshotIncludesExistingItems<Section>('section', sections, state._allSections);
    }
    if (overrides?.areas) {
        assertCollectionSnapshotIncludesExistingItems<Area>('area', areas, state._allAreas);
    }
    return {
        tasks,
        projects,
        sections,
        areas,
        settings: overrides?.settings ?? state.settings,
    };
};

export const computeDerivedState = (tasks: Task[], projects: Project[]): DerivedState => {
    const projectDerived = computeProjectDerivedState(projects);
    const taskDerived = computeTaskDerivedState(tasks);

    return {
        ...projectDerived,
        ...taskDerived,
    };
};

export const computeProjectDerivedState = (
    projects: Iterable<Project>,
    projectMap?: Map<string, Project>
): Pick<DerivedState, 'projectMap' | 'sequentialProjectIds' | 'focusedProjectCount'> => {
    const resolvedProjectMap = projectMap ?? new Map<string, Project>();
    const sequentialProjectIds = new Set<string>();
    let focusedProjectCount = 0;

    for (const project of projects) {
        if (!projectMap) {
            resolvedProjectMap.set(project.id, project);
        }
        if (project.deletedAt) continue;
        if (project.isSequential) {
            sequentialProjectIds.add(project.id);
        }
        if (project.isFocused) {
            focusedProjectCount += 1;
        }
    }

    return {
        projectMap: resolvedProjectMap,
        sequentialProjectIds,
        focusedProjectCount,
    };
};

export const computeTaskDerivedState = (
    tasks: Task[],
    tasksById?: Map<string, Task>
): Pick<DerivedState, 'tasksById' | 'activeTasksByStatus' | 'allContexts' | 'allTags' | 'focusedCount'> => {
    const resolvedTasksById = tasksById ?? new Map<string, Task>();
    const activeTasksByStatus = new Map<TaskStatus, Task[]>();
    let focusedCount = 0;

    tasks.forEach((task) => {
        if (!tasksById) {
            resolvedTasksById.set(task.id, task);
        }
        if (task.deletedAt) return;
        const list = activeTasksByStatus.get(task.status) ?? [];
        list.push(task);
        activeTasksByStatus.set(task.status, list);
        // Done/reference tasks keep their historical focus flag but should not consume today's focus limit.
        if (task.isFocusedToday && task.status !== 'done' && task.status !== 'reference') {
            focusedCount += 1;
        }
    });

    return {
        tasksById: resolvedTasksById,
        activeTasksByStatus,
        allContexts: getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' }),
        allTags: getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' }),
        focusedCount,
    };
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

export const normalizeTagId = (value: string): string => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const withPrefix = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    return withPrefix.toLowerCase();
};

export const stripSensitiveSettings = (settings: AppData['settings']): AppData['settings'] => {
    if (!settings?.ai || !settings.ai.apiKey) return settings;
    return {
        ...settings,
        ai: {
            ...settings.ai,
            apiKey: undefined,
        },
    };
};

export const normalizeAiSettingsForSync = (ai?: AiSettings): AiSettings | undefined => {
    if (!ai) return ai;
    const { apiKey, ...rest } = ai;
    if (!rest.speechToText) return rest;
    return {
        ...rest,
        speechToText: {
            ...rest.speechToText,
            offlineModelPath: undefined,
        },
    };
};

export const cloneSettings = (settings: AppData['settings']): AppData['settings'] => {
    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(settings);
        }
    } catch {
        // Fallback below
    }
    return JSON.parse(JSON.stringify(settings)) as AppData['settings'];
};

export const sanitizeAppDataForStorage = (data: AppData): AppData => ({
    ...data,
    settings: stripSensitiveSettings(cloneSettings(data.settings)),
});

export const getTaskOrder = (task: Pick<Task, 'order' | 'orderNum'>): number | undefined => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return undefined;
};

const getProjectOrderIndex = (tasks: Task[]): Map<string, number> => {
    if (projectOrderCacheRef === tasks && projectOrderCacheValue) {
        return projectOrderCacheValue;
    }
    const nextCache = new Map<string, number>();
    for (const task of tasks) {
        if (task.deletedAt || !task.projectId) continue;
        const order = getTaskOrder(task) ?? -1;
        const previous = nextCache.get(task.projectId) ?? -1;
        if (order > previous) {
            nextCache.set(task.projectId, order);
        }
    }
    projectOrderCacheRef = tasks;
    projectOrderCacheValue = nextCache;
    if (reservedProjectOrdersRef !== tasks) {
        reservedProjectOrdersRef = tasks;
        reservedProjectOrdersValue = null;
    }
    return nextCache;
};

export const getNextProjectOrder = (
    projectId: string | undefined,
    tasks: Task[]
): number | undefined => {
    if (!projectId) return undefined;
    return (getProjectOrderIndex(tasks).get(projectId) ?? -1) + 1;
};

export const reserveNextProjectOrder = (
    projectId: string | undefined,
    tasks: Task[]
): number | undefined => {
    if (!projectId) return undefined;
    if (reservedProjectOrdersRef !== tasks || !reservedProjectOrdersValue) {
        reservedProjectOrdersRef = tasks;
        reservedProjectOrdersValue = new Map<string, number>();
    }
    const snapshotReservations = reservedProjectOrdersValue;
    const reserved = snapshotReservations.get(projectId);
    if (typeof reserved === 'number') {
        snapshotReservations.set(projectId, reserved + 1);
        return reserved;
    }
    const nextOrder = getNextProjectOrder(projectId, tasks);
    if (typeof nextOrder !== 'number') return undefined;
    snapshotReservations.set(projectId, nextOrder + 1);
    return nextOrder;
};
