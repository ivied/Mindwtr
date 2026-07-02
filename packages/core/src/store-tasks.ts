import type { AppData, PendingRemoteAttachmentDelete, Task, TaskStatus } from './types';
import type { StorageAdapter, TaskQueryOptions } from './storage';
import type { StoreActionResult, TaskStore } from './store-types';
import {
    applyTaskUpdates,
    buildSaveSnapshot,
    createProjectOrderReserver,
    ensureDeviceId,
    getNextDataChangeAt,
    getTaskOrder,
    getReferenceTaskFieldClears,
    isTaskVisible,
    nextRevision,
    replaceEntitiesInArray,
    replaceEntitiesInMap,
    replaceEntityInArray,
    replaceEntityInMap,
    type ProjectOrderReserver,
    toVisibleTask,
    updateVisibleTasks,
} from './store-helpers';
import { logWarn } from './logger';
import { generateUUID as uuidv4 } from './uuid';
import { normalizeRecurrenceForLoad } from './recurrence';
import { normalizeRepeatReminderMinutes } from './schedule-utils';
import { normalizeFocusTaskLimit } from './focus-utils';
import { getTaskFocusEligibility, isTaskFutureStart } from './task-utils';
import { resolveTaskContainerHierarchy } from './task-container-rules';
import { resolveDefaultNewTaskAreaId } from './area-utils';
import { findSelectableProjectByTitleAndArea } from './project-utils';
import { buildNewProject } from './store-projects/project-actions';

const stripAttachmentRemoteMetadata = (attachments: Task['attachments']): Task['attachments'] =>
    attachments?.map((attachment) => (
        attachment.kind === 'file'
            ? {
                ...attachment,
                cloudKey: undefined,
                localStatus: undefined,
            }
            : attachment
    ));

const collectAttachmentCloudKeysForTasks = (tasks: readonly Task[]): Set<string> => {
    const cloudKeys = new Set<string>();
    for (const task of tasks) {
        if (task.purgedAt) continue;
        for (const attachment of task.attachments || []) {
            if (attachment.kind === 'file' && attachment.cloudKey) {
                cloudKeys.add(attachment.cloudKey);
            }
        }
    }
    return cloudKeys;
};

const collectPendingRemoteDeletesForTasks = (
    tasks: readonly Task[],
    remainingTasks: readonly Task[] = [],
): PendingRemoteAttachmentDelete[] => {
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    const retainedCloudKeys = collectAttachmentCloudKeysForTasks(remainingTasks);
    for (const task of tasks) {
        for (const attachment of task.attachments || []) {
            if (attachment.kind !== 'file' || !attachment.cloudKey) continue;
            if (retainedCloudKeys.has(attachment.cloudKey)) continue;
            if (byCloudKey.has(attachment.cloudKey)) continue;
            byCloudKey.set(attachment.cloudKey, {
                cloudKey: attachment.cloudKey,
                title: attachment.title || attachment.cloudKey,
            });
        }
    }
    return Array.from(byCloudKey.values());
};

const appendPendingRemoteDeletes = (
    settings: TaskStore['settings'],
    pendingDeletes: readonly PendingRemoteAttachmentDelete[],
): TaskStore['settings'] => {
    if (pendingDeletes.length === 0) return settings;
    const byCloudKey = new Map<string, PendingRemoteAttachmentDelete>();
    for (const existing of settings.attachments?.pendingRemoteDeletes || []) {
        byCloudKey.set(existing.cloudKey, existing);
    }
    for (const pending of pendingDeletes) {
        if (byCloudKey.has(pending.cloudKey)) continue;
        byCloudKey.set(pending.cloudKey, pending);
    }
    return {
        ...settings,
        attachments: {
            ...settings.attachments,
            pendingRemoteDeletes: Array.from(byCloudKey.values()),
        },
    };
};

const normalizeOptionalTaskField = (value: string | undefined): string => value ?? '';

const recurrenceKeyForDuplicateCheck = (task: Task): string => (
    JSON.stringify(normalizeRecurrenceForLoad(task.recurrence) ?? null)
);

const isExistingRecurringFollowUp = (existing: Task, candidate: Task): boolean => {
    if (existing.id === candidate.id) return false;
    if (existing.deletedAt) return false;
    if (existing.status === 'done' || existing.status === 'archived') return false;
    if (existing.status !== candidate.status) return false;
    if (existing.title.trim() !== candidate.title.trim()) return false;
    if (normalizeOptionalTaskField(existing.projectId) !== normalizeOptionalTaskField(candidate.projectId)) return false;
    if (normalizeOptionalTaskField(existing.sectionId) !== normalizeOptionalTaskField(candidate.sectionId)) return false;
    if (normalizeOptionalTaskField(existing.areaId) !== normalizeOptionalTaskField(candidate.areaId)) return false;
    if (normalizeOptionalTaskField(existing.startTime) !== normalizeOptionalTaskField(candidate.startTime)) return false;
    if (normalizeOptionalTaskField(existing.dueDate) !== normalizeOptionalTaskField(candidate.dueDate)) return false;
    if (normalizeOptionalTaskField(existing.reviewAt) !== normalizeOptionalTaskField(candidate.reviewAt)) return false;
    return recurrenceKeyForDuplicateCheck(existing) === recurrenceKeyForDuplicateCheck(candidate);
};

const findExistingRecurringFollowUp = (tasks: readonly Task[], candidate: Task | null): Task | null => {
    if (!candidate) return null;
    return tasks.find((task) => isExistingRecurringFollowUp(task, candidate)) ?? null;
};

const stampNewRecurringFollowUp = (task: Task | null, deviceId: string): Task | null => {
    if (!task) return null;
    return {
        ...task,
        rev: nextRevision(undefined),
        revBy: deviceId,
    };
};

type TaskActions = Pick<
    TaskStore,
    | 'addTask'
    | 'addTasks'
    | 'updateTask'
    | 'deleteTask'
    | 'restoreTask'
    | 'purgeTask'
    | 'purgeDeletedTasks'
    | 'duplicateTask'
    | 'promoteTaskToProject'
    | 'resetTaskChecklist'
    | 'moveTask'
    | 'batchUpdateTasks'
    | 'batchMoveTasks'
    | 'batchDeleteTasks'
    | 'queryTasks'
>;

type TaskActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    getStorage: () => StorageAdapter;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    trackImmediateSave: (save: Promise<void>) => Promise<void>;
};

const actionOk = (extra?: Omit<StoreActionResult, 'success'>): StoreActionResult => ({ success: true, ...extra });
const actionFail = (error: string): StoreActionResult => ({ success: false, error });
const hasOwnField = (value: object, field: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, field);
const normalizeOptionalReferenceId = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);
const normalizeProjectIdInput = normalizeOptionalReferenceId;

const applyVisibleTaskChanges = (
    visibleTasks: Task[],
    changedTasks: readonly Task[],
    addedTasks: readonly Task[] = []
): Task[] => {
    if (changedTasks.length === 0 && addedTasks.length === 0) return visibleTasks;
    const changedById = new Map(changedTasks.map((task) => [task.id, task]));
    const emittedIds = new Set<string>();
    let changed = false;
    const nextVisibleTasks: Task[] = [];

    for (const visibleTask of visibleTasks) {
        const updatedTask = changedById.get(visibleTask.id);
        if (!updatedTask) {
            nextVisibleTasks.push(visibleTask);
            emittedIds.add(visibleTask.id);
            continue;
        }
        changed = true;
        emittedIds.add(visibleTask.id);
        if (isTaskVisible(updatedTask)) {
            nextVisibleTasks.push(toVisibleTask(updatedTask));
        }
    }

    for (const task of [...changedTasks, ...addedTasks]) {
        if (emittedIds.has(task.id) || !isTaskVisible(task)) continue;
        nextVisibleTasks.push(toVisibleTask(task));
        emittedIds.add(task.id);
        changed = true;
    }

    return changed ? nextVisibleTasks : visibleTasks;
};

type MutateTasksOptions = {
    selectTasks: (state: TaskStore) => Task[];
    buildUpdates: (task: Task, context: { now: string; state: TaskStore }) => Partial<Task>;
    buildSettings?: (state: TaskStore, selectedTasks: readonly Task[], context: { now: string; settings: TaskStore['settings'] }) => TaskStore['settings'] | undefined;
    updateVisible?: boolean;
    missingMessage?: string;
    ensureDeviceIdWhenEmpty?: boolean;
};

const mutateTasks = async (
    { set, debouncedSave }: Pick<TaskActionContext, 'set' | 'debouncedSave'>,
    options: MutateTasksOptions
): Promise<StoreActionResult> => {
    const changeAt = Date.now();
    const now = new Date().toISOString();
    let snapshot: AppData | null = null;
    let missing = false;
    set((state) => {
        const selectedTasks = options.selectTasks(state);
        if (selectedTasks.length === 0 && !options.ensureDeviceIdWhenEmpty) {
            missing = Boolean(options.missingMessage);
            return state;
        }
        const deviceState = ensureDeviceId(state.settings);
        if (selectedTasks.length === 0 && !deviceState.updated) {
            return state;
        }
        const changedTasks = selectedTasks.map((task) => {
            const updatedTask: Task = {
                ...task,
                ...options.buildUpdates(task, { now, state }),
                updatedAt: now,
                rev: nextRevision(task.rev),
                revBy: deviceState.deviceId,
            };
            return updatedTask;
        });
        const nextVisibleTasks = options.updateVisible !== false
            ? applyVisibleTaskChanges(state.tasks, changedTasks)
            : state.tasks;
        const nextAllTasks = changedTasks.length > 0
            ? replaceEntitiesInArray(state._allTasks, changedTasks)
            : state._allTasks;
        const updatedSettings = options.buildSettings?.(state, selectedTasks, {
            now,
            settings: deviceState.settings,
        });
        const nextSettings = updatedSettings ?? deviceState.settings;
        const settingsChanged = Boolean(updatedSettings) || deviceState.updated;
        snapshot = buildSaveSnapshot(state, {
            tasks: nextAllTasks,
            ...(settingsChanged ? { settings: nextSettings } : {}),
        });
        return {
            tasks: nextVisibleTasks,
            _allTasks: nextAllTasks,
            _tasksById: changedTasks.length > 0
                ? replaceEntitiesInMap(state._tasksById, changedTasks)
                : state._tasksById,
            lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
            ...(settingsChanged ? { settings: nextSettings } : {}),
        };
    });
    if (snapshot) {
        debouncedSave(snapshot, (msg) => set({ error: msg }));
    }
    return missing ? actionFail(options.missingMessage ?? 'Task not found') : actionOk();
};

const validateExistingProjectId = (
    projectId: unknown,
    allProjects: AppData['projects']
): { ok: true; projectId?: string } | { ok: false; error: string } => {
    const normalizedProjectId = normalizeProjectIdInput(projectId);
    if (!normalizedProjectId) {
        return { ok: true, projectId: undefined };
    }
    const exists = allProjects.some((project) => project.id === normalizedProjectId && !project.deletedAt);
    if (exists) {
        return { ok: true, projectId: normalizedProjectId };
    }
    return { ok: false, error: 'Project not found' };
};

const validateExistingAreaId = (
    areaId: unknown,
    allAreas: AppData['areas']
): { ok: true; areaId?: string } | { ok: false; error: string } => {
    const normalizedAreaId = normalizeOptionalReferenceId(areaId);
    if (!normalizedAreaId) {
        return { ok: true, areaId: undefined };
    }
    const exists = allAreas.some((area) => area.id === normalizedAreaId && !area.deletedAt);
    if (exists) {
        return { ok: true, areaId: normalizedAreaId };
    }
    return { ok: false, error: 'Area not found' };
};

const resolveTaskContainerAssignment = ({
    projectId,
    sectionId,
    areaId,
    allProjects,
    allSections,
    allAreas,
}: {
    projectId: unknown;
    sectionId: unknown;
    areaId: unknown;
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];
}):
    | { ok: true; projectId?: string; sectionId?: string; areaId?: string }
    | { ok: false; error: string } => {
    const projectValidation = validateExistingProjectId(projectId, allProjects);
    if (!projectValidation.ok) return projectValidation;

    let resolvedProjectId = projectValidation.projectId;
    const resolvedSectionId = normalizeOptionalReferenceId(sectionId);
    if (resolvedSectionId) {
        const section = allSections.find((candidate) => candidate.id === resolvedSectionId && !candidate.deletedAt);
        if (!section) {
            return { ok: false, error: 'Section not found' };
        }
        const liveProjectExists = allProjects.some((candidate) => candidate.id === section.projectId && !candidate.deletedAt);
        if (!liveProjectExists) {
            return { ok: false, error: 'Section not found' };
        }
        if (resolvedProjectId && section.projectId !== resolvedProjectId) {
            return { ok: false, error: 'Section does not belong to project' };
        }
        const resolved = resolveTaskContainerHierarchy({
            projectId: resolvedProjectId,
            sectionId: resolvedSectionId,
            areaId: areaId === undefined ? undefined : normalizeOptionalReferenceId(areaId),
            sectionProjectId: section.projectId,
        });
        return {
            ok: true,
            projectId: resolved.projectId,
            sectionId: resolved.sectionId,
            areaId: resolved.areaId,
        };
    }

    if (resolvedProjectId) {
        const resolved = resolveTaskContainerHierarchy({
            projectId: resolvedProjectId,
            sectionId: undefined,
            areaId: areaId === undefined ? undefined : normalizeOptionalReferenceId(areaId),
        });
        return {
            ok: true,
            projectId: resolved.projectId,
            sectionId: resolved.sectionId,
            areaId: resolved.areaId,
        };
    }

    const areaValidation = validateExistingAreaId(areaId, allAreas);
    if (!areaValidation.ok) return areaValidation;
    const resolved = resolveTaskContainerHierarchy({
        projectId: undefined,
        sectionId: undefined,
        areaId: areaValidation.areaId,
    });
    return {
        ok: true,
        projectId: resolved.projectId,
        sectionId: resolved.sectionId,
        areaId: resolved.areaId,
    };
};

const sanitizeRestoredTaskContainerReferences = (
    task: Task,
    state: TaskStore,
): Pick<Task, 'projectId' | 'sectionId' | 'areaId'> => {
    let projectId = normalizeOptionalReferenceId(task.projectId);
    let sectionId = normalizeOptionalReferenceId(task.sectionId);
    let areaId = normalizeOptionalReferenceId(task.areaId);

    const liveProjectIds = new Set(
        state._allProjects
            .filter((project) => !project.deletedAt && !project.purgedAt)
            .map((project) => project.id),
    );
    const liveSection = sectionId
        ? state._allSections.find((section) => section.id === sectionId && !section.deletedAt)
        : undefined;
    const sectionProjectId = liveSection && liveProjectIds.has(liveSection.projectId)
        ? liveSection.projectId
        : undefined;

    if (projectId && !liveProjectIds.has(projectId)) {
        projectId = undefined;
    }
    if (sectionId && !sectionProjectId) {
        sectionId = undefined;
    }

    const resolved = resolveTaskContainerHierarchy({
        projectId,
        sectionId,
        areaId,
        sectionProjectId,
    });

    if (resolved.areaId && !state._allAreas.some((area) => area.id === resolved.areaId && !area.deletedAt)) {
        resolved.areaId = undefined;
    }

    return resolved;
};

const prepareTaskUpdatesForStore = ({
    task,
    updates,
    allTasks,
    allProjects,
    allSections,
    allAreas,
    reserveProjectOrder,
    projectOrderReserver,
}: {
    task: Task;
    updates: Partial<Task>;
    allTasks: Task[];
    allProjects: AppData['projects'];
    allSections: AppData['sections'];
    allAreas: AppData['areas'];
    reserveProjectOrder?: boolean;
    projectOrderReserver?: ProjectOrderReserver;
}): { ok: true; updates: Partial<Task> } | { ok: false; error: string } => {
    const hasProjectUpdate = hasOwnField(updates, 'projectId');
    const nextProjectId = hasProjectUpdate
        ? normalizeProjectIdInput(updates.projectId)
        : task.projectId;
    const projectChanged = (task.projectId ?? undefined) !== (nextProjectId ?? undefined);
    const candidateSectionId = hasOwnField(updates, 'sectionId')
        ? updates.sectionId
        : hasProjectUpdate && projectChanged
            ? undefined
            : task.sectionId;
    const candidateAreaId = hasOwnField(updates, 'areaId')
        ? updates.areaId
        : hasProjectUpdate && projectChanged && nextProjectId
            ? undefined
            : task.areaId;
    const containerResolution = resolveTaskContainerAssignment({
        projectId: nextProjectId,
        sectionId: candidateSectionId,
        areaId: candidateAreaId,
        allProjects,
        allSections,
        allAreas,
    });
    if (!containerResolution.ok) return containerResolution;

    const adjustedUpdates = normalizeTaskUpdateForStore({
        task,
        updates: {
            ...updates,
            projectId: containerResolution.projectId,
            sectionId: containerResolution.sectionId,
            areaId: containerResolution.areaId,
        },
        allTasks,
        reserveProjectOrder,
        projectOrderReserver,
    });

    return {
        ok: true,
        updates: {
            ...adjustedUpdates,
            projectId: containerResolution.projectId,
            sectionId: containerResolution.sectionId,
            areaId: containerResolution.areaId,
        },
    };
};

const normalizeTaskUpdateForStore = ({
    task,
    updates,
    allTasks,
    reserveProjectOrder,
    projectOrderReserver,
}: {
    task: Task;
    updates: Partial<Task>;
    allTasks: Task[];
    reserveProjectOrder?: boolean;
    projectOrderReserver?: ProjectOrderReserver;
}): Partial<Task> => {
    const shouldReserveProjectOrder = reserveProjectOrder !== false;
    let adjustedUpdates = updates;
    if (hasOwnField(updates, 'recurrence')) {
        adjustedUpdates = {
            ...adjustedUpdates,
            recurrence: normalizeRecurrenceForLoad(updates.recurrence),
        };
    }
    const hasOrder = Object.prototype.hasOwnProperty.call(updates, 'order');
    const hasOrderNum = Object.prototype.hasOwnProperty.call(updates, 'orderNum');
    if (hasOrder || hasOrderNum) {
        const normalizedOrder = getTaskOrder(updates);
        adjustedUpdates = {
            ...adjustedUpdates,
            order: normalizedOrder,
            orderNum: normalizedOrder,
        };
    }
    if (hasOwnField(updates, 'startTime') && isTaskFutureStart({ startTime: adjustedUpdates.startTime })) {
        adjustedUpdates = {
            ...adjustedUpdates,
            isFocusedToday: false,
        };
    }
    if (
        hasOwnField(updates, 'status')
        && updates.status !== task.status
        && !hasOwnField(updates, 'boardOrder')
    ) {
        adjustedUpdates = {
            ...adjustedUpdates,
            boardOrder: undefined,
        };
    }
    if (!Object.prototype.hasOwnProperty.call(updates, 'projectId')) {
        return adjustedUpdates;
    }

    const rawProjectId = updates.projectId;
    const normalizedProjectId =
        typeof rawProjectId === 'string' && rawProjectId.trim().length > 0
            ? rawProjectId
            : undefined;
    const nextProjectId = normalizedProjectId ?? undefined;
    const projectChanged = (task.projectId ?? undefined) !== nextProjectId;
    if (projectChanged) {
        const shouldClearSection = !Object.prototype.hasOwnProperty.call(updates, 'sectionId');
        const hasTaskOrderOverride = hasOrder || hasOrderNum;
        if (nextProjectId) {
            if (shouldReserveProjectOrder && !hasTaskOrderOverride) {
                const nextOrder = (projectOrderReserver ?? createProjectOrderReserver(allTasks))(nextProjectId);
                adjustedUpdates = {
                    ...adjustedUpdates,
                    order: nextOrder,
                    orderNum: nextOrder,
                };
            }
            if (!Object.prototype.hasOwnProperty.call(updates, 'areaId')) {
                adjustedUpdates = {
                    ...adjustedUpdates,
                    areaId: undefined,
                };
            }
            if (shouldClearSection) {
                adjustedUpdates = {
                    ...adjustedUpdates,
                    sectionId: undefined,
                };
            }
        } else {
            adjustedUpdates = {
                ...adjustedUpdates,
                projectId: undefined,
                order: undefined,
                orderNum: undefined,
                sectionId: undefined,
            };
        }
    } else if (normalizedProjectId !== updates.projectId) {
        adjustedUpdates = {
            ...adjustedUpdates,
            projectId: normalizedProjectId,
        };
    }

    return adjustedUpdates;
};

const reserveProjectOrderForPreparedUpdates = ({
    task,
    updates,
    projectOrderReserver,
}: {
    task: Task;
    updates: Partial<Task>;
    projectOrderReserver: ProjectOrderReserver;
}): Partial<Task> => {
    if (!hasOwnField(updates, 'projectId')) return updates;
    if (hasOwnField(updates, 'order') || hasOwnField(updates, 'orderNum')) return updates;
    const nextProjectId = typeof updates.projectId === 'string' && updates.projectId.trim().length > 0
        ? updates.projectId
        : undefined;
    if (!nextProjectId || (task.projectId ?? undefined) === nextProjectId) return updates;
    const nextOrder = projectOrderReserver(nextProjectId);
    return {
        ...updates,
        order: nextOrder,
        orderNum: nextOrder,
    };
};

const createTaskQueryMatcher = (
    options: TaskQueryOptions,
    { checkVisibility }: { checkVisibility: boolean }
): ((task: Task) => boolean) => {
    const statusFilter = options.status;
    const excludeStatuses = options.excludeStatuses ?? [];
    const includeArchived = options.includeArchived === true;
    const includeDeleted = options.includeDeleted === true;
    const projectId = options.projectId;

    return (task) => {
        if (checkVisibility && !isTaskVisible(task, { includeArchived, includeDeleted })) return false;
        if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
        if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
        if (projectId && task.projectId !== projectId) return false;
        return true;
    };
};

export const createTaskActions = ({ set, get, getStorage, debouncedSave, trackImmediateSave }: TaskActionContext): TaskActions => ({
    /**
     * Add a new task to the store and persist to storage.
     * @param title Task title
     * @param initialProps Optional initial properties
     */
    addTask: async (title: string, initialProps?: Partial<Task>) => {
        const trimmedTitle = typeof title === 'string' ? title.trim() : '';
        if (!trimmedTitle) {
            const message = 'Task title is required';
            set({ error: message });
            return actionFail(message);
        }
        const result = await get().addTasks([{ title: trimmedTitle, initialProps }]);
        if (!result.success) return result;
        return actionOk({ id: result.ids?.[0] });
    },

    /**
     * Add multiple tasks in one store update and persistence snapshot.
     */
    addTasks: async (items: Array<{ title: string; initialProps?: Partial<Task> }>) => {
        const changeAt = Date.now();
        const normalizedItems = items.map((item) => ({
            title: typeof item.title === 'string' ? item.title.trim() : '',
            initialProps: item.initialProps ?? {},
        })).filter((item) => item.title.length > 0);
        if (normalizedItems.length === 0) return actionOk({ ids: [] });

        const currentState = get();
        const deviceState = ensureDeviceId(currentState.settings);
        const deviceId = deviceState.deviceId;
        const now = new Date().toISOString();
        const projectOrderReserver = createProjectOrderReserver(currentState._allTasks);
        const focusTaskLimit = normalizeFocusTaskLimit(currentState.settings.gtd?.focusTaskLimit);
        let focusedCount = currentState.getDerivedState().focusedCount;
        const nextAllTasks = [...currentState._allTasks];
        const newTasks: Task[] = [];

        for (const item of normalizedItems) {
            const initialTaskProps = item.initialProps;
            const hasExplicitAreaId = hasOwnField(initialTaskProps, 'areaId');
            const shouldApplyDefaultArea = !hasExplicitAreaId
                && !normalizeProjectIdInput(initialTaskProps.projectId)
                && !normalizeOptionalReferenceId(initialTaskProps.sectionId);
            const defaultAreaId = shouldApplyDefaultArea
                ? resolveDefaultNewTaskAreaId(currentState.settings, currentState._allAreas)
                : undefined;
            const containerResolution = resolveTaskContainerAssignment({
                projectId: initialTaskProps.projectId,
                sectionId: initialTaskProps.sectionId,
                areaId: defaultAreaId ?? initialTaskProps.areaId,
                allProjects: currentState._allProjects,
                allSections: currentState._allSections,
                allAreas: currentState._allAreas,
            });
            if (!containerResolution.ok) {
                set({ error: containerResolution.error });
                return actionFail(containerResolution.error);
            }

            const resolvedStatus = (initialTaskProps.status ?? 'inbox') as TaskStatus;
            const hasTaskOrder = hasOwnField(initialTaskProps, 'order') || hasOwnField(initialTaskProps, 'orderNum');
            const resolvedProjectId = containerResolution.projectId;
            const resolvedSectionId = containerResolution.sectionId;
            const resolvedAreaId = containerResolution.areaId;
            const referenceClears = resolvedStatus === 'reference'
                ? getReferenceTaskFieldClears()
                : {};
            const explicitOrder = getTaskOrder(initialTaskProps);
            const resolvedOrder = !hasTaskOrder && resolvedProjectId
                ? projectOrderReserver(resolvedProjectId)
                : explicitOrder;
            const newTask: Task = {
                ...initialTaskProps,
                id: uuidv4(),
                title: item.title,
                status: resolvedStatus,
                taskMode: initialTaskProps.taskMode ?? 'task',
                tags: initialTaskProps.tags ?? [],
                contexts: initialTaskProps.contexts ?? [],
                pushCount: initialTaskProps.pushCount ?? 0,
                recurrence: normalizeRecurrenceForLoad(initialTaskProps.recurrence),
                repeatReminderMinutes: normalizeRepeatReminderMinutes(initialTaskProps.repeatReminderMinutes),
                rev: 1,
                revBy: deviceId,
                createdAt: now,
                updatedAt: now,
                deletedAt: undefined,
                purgedAt: undefined,
                ...referenceClears,
                areaId: resolvedAreaId,
                projectId: resolvedProjectId,
                sectionId: resolvedSectionId,
                order: resolvedOrder,
                orderNum: resolvedOrder,
            };

            if (newTask.isFocusedToday === true) {
                // Starring at capture is an explicit "this is an actionable next action I'm
                // doing today" decision, which is incompatible with the unprocessed Inbox
                // default. Evaluate (and, if focus sticks, commit) the task as Next so the
                // star can take effect — focus eligibility requires status 'next'. The
                // promotion is committed only when focus actually lands, so a refused star
                // (cap full / ineligible) never silently reclassifies an Inbox task.
                const promotedStatus: TaskStatus = newTask.status === 'inbox' ? 'next' : newTask.status;
                const focusCandidate: Task = { ...newTask, status: promotedStatus, isFocusedToday: false };
                const focusEligibility = getTaskFocusEligibility(focusCandidate, {
                    tasks: [...nextAllTasks, focusCandidate],
                    projects: currentState._allProjects,
                    showFutureStarts: currentState.settings.appearance?.showFutureStarts,
                });
                if (!focusEligibility.eligible || focusedCount >= focusTaskLimit) {
                    newTask.isFocusedToday = false;
                } else {
                    newTask.status = promotedStatus;
                    focusedCount += 1;
                }
            }

            newTasks.push(newTask);
            nextAllTasks.push(newTask);
        }

        let snapshot: AppData | null = null;
        set((state) => {
            snapshot = buildSaveSnapshot(state, {
                tasks: nextAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                _allTasks: nextAllTasks,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk({ id: newTasks[0]?.id, ids: newTasks.map((task) => task.id) });
    },

    /**
     * Update an existing task.
     * @param id Task ID
     * @param updates Properties to update
     */
    updateTask: async (id: string, updates: Partial<Task>) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        const currentState = get();
        const existingTask = currentState._tasksById.get(id);
        if (!existingTask) {
            const message = 'Task not found';
            logWarn('updateTask skipped: task not found', {
                scope: 'store',
                category: 'validation',
                context: { id },
            });
            set({ error: message });
            return actionFail(message);
        }
        const preparedUpdates = prepareTaskUpdatesForStore({
            task: existingTask,
            updates,
            allTasks: currentState._allTasks,
            allProjects: currentState._allProjects,
            allSections: currentState._allSections,
            allAreas: currentState._allAreas,
        });
        if (!preparedUpdates.ok) {
            set({ error: preparedUpdates.error });
            return actionFail(preparedUpdates.error);
        }
        const isPromotingTaskFocus = preparedUpdates.updates.isFocusedToday === true && existingTask.isFocusedToday !== true;
        if (isPromotingTaskFocus) {
            const focusTaskLimit = normalizeFocusTaskLimit(currentState.settings.gtd?.focusTaskLimit);
            const focusedCount = currentState.getDerivedState().focusedCount;
            if (focusedCount >= focusTaskLimit) {
                const message = `Maximum of ${focusTaskLimit} focused tasks allowed`;
                set({ error: message });
                return actionFail(message);
            }
        }
        let snapshot: AppData | null = null;
        const incrementalPersistence: { task?: Task; hasRecurringFollowUp: boolean } = {
            hasRecurringFollowUp: false,
        };
        set((state) => {
            const oldTask = state._tasksById.get(id);
            if (!oldTask) {
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);
            const revisionPatch = {
                rev: nextRevision(oldTask.rev),
                revBy: deviceState.deviceId,
            };

            const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                oldTask,
                { ...preparedUpdates.updates, ...revisionPatch },
                now
            );
            const stampedNextRecurringTask = stampNewRecurringFollowUp(nextRecurringTask, deviceState.deviceId);
            const recurringFollowUpTask = findExistingRecurringFollowUp(state._allTasks, stampedNextRecurringTask)
                ? null
                : stampedNextRecurringTask;
            incrementalPersistence.task = updatedTask;
            incrementalPersistence.hasRecurringFollowUp = recurringFollowUpTask !== null;

            // DIAGNOSTIC: trace any client-side promotion of a task into 'next'.
            // Captures the call stack so we can see which UI action / code path
            // moved a someday/inbox task back into Next. Remove once the source
            // of the unwanted promotion is identified.
            if (updatedTask.status === 'next' && oldTask.status !== 'next') {
                const promotedProject = oldTask.projectId
                    ? state._allProjects.find((candidate) => candidate.id === oldTask.projectId)
                    : undefined;
                logWarn('[status-trace] updateTask promoted task to next', {
                    scope: 'store',
                    category: 'sync',
                    context: {
                        taskId: updatedTask.id,
                        title: updatedTask.title?.slice(0, 60),
                        from: oldTask.status,
                        projectId: oldTask.projectId ?? null,
                        inSequentialProject: promotedProject?.isSequential === true,
                        stack: new Error('status-trace').stack?.split('\n').slice(2, 8).join(' | '),
                    },
                });
            }

            const updatedAllTasksBase = replaceEntityInArray(state._allTasks, id, updatedTask);
            const updatedAllTasks = recurringFollowUpTask
                ? [...updatedAllTasksBase, recurringFollowUpTask]
                : updatedAllTasksBase;
            const updatedTasksById = replaceEntityInMap(state._tasksById, updatedTask);

            let updatedVisibleTasks = updateVisibleTasks(state.tasks, oldTask, updatedTask);
            if (recurringFollowUpTask) {
                updatedVisibleTasks = updateVisibleTasks(updatedVisibleTasks, null, recurringFollowUpTask);
            }
            snapshot = buildSaveSnapshot(state, {
                tasks: updatedAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: updatedVisibleTasks,
                _allTasks: updatedAllTasks,
                _tasksById: recurringFollowUpTask
                    ? replaceEntityInMap(updatedTasksById, recurringFollowUpTask)
                    : updatedTasksById,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        const storage = getStorage();
        if (incrementalPersistence.task && !incrementalPersistence.hasRecurringFollowUp && storage.saveTask) {
            const taskToPersist = incrementalPersistence.task;
            void trackImmediateSave(storage.saveTask(taskToPersist, snapshot ?? undefined)).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                logWarn('Incremental task save failed', {
                    scope: 'store',
                    category: 'storage',
                    context: { taskId: taskToPersist.id },
                    error,
                });
                set({ error: `Failed to save task: ${message}` });
            });
        } else if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    /**
     * Soft-delete a task by setting deletedAt.
     * @param id Task ID
     */
    deleteTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task ? [task] : [];
            },
            buildUpdates: (_task, { now }) => ({ deletedAt: now }),
            missingMessage: 'Task not found',
        });
    },

    /**
     * Restore a soft-deleted task.
     */
    restoreTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task ? [task] : [];
            },
            buildUpdates: (task, { state }) => ({
                deletedAt: undefined,
                purgedAt: undefined,
                ...sanitizeRestoredTaskContainerReferences(task, state),
            }),
            missingMessage: 'Task not found',
        });
    },

    /**
     * Permanently delete a task (removes from storage).
     */
    purgeTask: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task ? [task] : [];
            },
            buildUpdates: (task, { now }) => ({
                deletedAt: task.deletedAt ?? now,
                purgedAt: now,
                attachments: stripAttachmentRemoteMetadata(task.attachments),
            }),
            buildSettings: (state, selectedTasks, { settings }) => {
                const selectedIds = new Set(selectedTasks.map((task) => task.id));
                const remainingTasks = state._allTasks.filter((task) => !selectedIds.has(task.id));
                const pendingDeletes = collectPendingRemoteDeletesForTasks(selectedTasks, remainingTasks);
                return pendingDeletes.length > 0
                    ? appendPendingRemoteDeletes(settings, pendingDeletes)
                    : undefined;
            },
            missingMessage: 'Task not found',
        });
    },

    /**
     * Permanently delete all soft-deleted tasks.
     */
    purgeDeletedTasks: async () => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => task.deletedAt && !task.purgedAt),
            buildUpdates: (task, { now }) => ({
                purgedAt: now,
                attachments: stripAttachmentRemoteMetadata(task.attachments),
            }),
            buildSettings: (state, selectedTasks, { settings }) => {
                const selectedIds = new Set(selectedTasks.map((task) => task.id));
                const remainingTasks = state._allTasks.filter((task) => !selectedIds.has(task.id));
                const pendingDeletes = collectPendingRemoteDeletesForTasks(selectedTasks, remainingTasks);
                return pendingDeletes.length > 0
                    ? appendPendingRemoteDeletes(settings, pendingDeletes)
                    : undefined;
            },
            updateVisible: false,
            ensureDeviceIdWhenEmpty: true,
        });
    },

    /**
     * Duplicate a task as a fresh, re-doable copy: clones the details (title, dates,
     * recurrence, tags, project) but resets completion — unchecks the checklist, clears
     * completedAt, and reactivates done/archived tasks so the copy is always actionable.
     */
    duplicateTask: async (id: string, asNextAction?: boolean) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        let duplicatedTaskId: string | undefined;
        set((state) => {
            const sourceTask = state._tasksById.get(id);
            if (!sourceTask || sourceTask.deletedAt) {
                missingTask = true;
                return state;
            }
            const deviceState = ensureDeviceId(state.settings);

            const duplicatedChecklist = (sourceTask.checklist || []).map((item) => ({
                ...item,
                id: uuidv4(),
                isCompleted: false,
            }));
            const duplicatedAttachments = (sourceTask.attachments || []).flatMap((attachment) => {
                if (attachment.kind === 'file') {
                    return [];
                }
                return [{
                    ...attachment,
                    id: uuidv4(),
                    createdAt: now,
                    updatedAt: now,
                    deletedAt: undefined,
                    cloudKey: undefined,
                    fileHash: undefined,
                    localStatus: undefined,
                }];
            });
            const projectOrderReserver = createProjectOrderReserver(state._allTasks);
            const duplicatedOrder = sourceTask.projectId
                ? projectOrderReserver(sourceTask.projectId)
                : undefined;
            duplicatedTaskId = uuidv4();

            const newTask: Task = {
                ...sourceTask,
                id: duplicatedTaskId,
                title: sourceTask.title,
                status: asNextAction || sourceTask.status === 'done' || sourceTask.status === 'archived' ? 'next' : sourceTask.status,
                checklist: duplicatedChecklist.length > 0 ? duplicatedChecklist : undefined,
                attachments: duplicatedAttachments.length > 0 ? duplicatedAttachments : undefined,
                completedAt: undefined,
                isFocusedToday: false,
                deletedAt: undefined,
                purgedAt: undefined,
                createdAt: now,
                updatedAt: now,
                rev: 1,
                revBy: deviceState.deviceId,
                order: duplicatedOrder,
                orderNum: duplicatedOrder,
            };

            const newAllTasks = [...state._allTasks, newTask];
            const newVisibleTasks = updateVisibleTasks(state.tasks, null, newTask);
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
        return missingTask ? actionFail('Task not found') : actionOk({ id: duplicatedTaskId });
    },

    /**
     * Create or reuse a project from a task while keeping the task as the first action.
     */
    promoteTaskToProject: async (id: string, options?: { title?: string; color?: string; areaId?: string }) => {
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;
        let missingTask = false;
        let errorMessage: string | undefined;
        let promotedProjectId: string | undefined;
        let reusedExistingProject = false;
        set((state) => {
            const sourceTask = state._tasksById.get(id);
            if (!sourceTask || sourceTask.deletedAt) {
                missingTask = true;
                return state;
            }

            const trimmedTitle = (typeof options?.title === 'string' ? options.title : sourceTask.title).trim();
            if (!trimmedTitle) {
                errorMessage = 'Project title is required';
                return { error: errorMessage };
            }

            const explicitAreaId = normalizeOptionalReferenceId(options?.areaId);
            const sourceProject = sourceTask.projectId ? state._projectsById.get(sourceTask.projectId) : undefined;
            const inheritedAreaId = explicitAreaId ?? sourceTask.areaId ?? sourceProject?.areaId;
            const targetAreaId = inheritedAreaId && state._allAreas.some((area) => area.id === inheritedAreaId && !area.deletedAt)
                ? inheritedAreaId
                : undefined;
            if (explicitAreaId && !targetAreaId) {
                errorMessage = 'Area not found';
                return { error: errorMessage };
            }

            const existingProject = findSelectableProjectByTitleAndArea(
                state._allProjects,
                trimmedTitle,
                targetAreaId
            );
            reusedExistingProject = Boolean(existingProject);
            const projectSupportNotes = typeof sourceTask.description === 'string' && sourceTask.description.trim()
                ? sourceTask.description.trim()
                : undefined;
            const projectTagIds = Array.from(new Set((sourceTask.tags || [])
                .map((tag) => typeof tag === 'string' ? tag.trim() : '')
                .filter(Boolean)));
            const deviceState = ensureDeviceId(state.settings);
            let targetProject = existingProject;
            let nextAllProjects = state._allProjects;
            if (!targetProject) {
                const newProject = buildNewProject({
                    title: trimmedTitle,
                    color: options?.color,
                    initialProps: {
                        ...(targetAreaId ? { areaId: targetAreaId } : {}),
                        ...(projectSupportNotes ? { supportNotes: projectSupportNotes } : {}),
                        tagIds: projectTagIds,
                    },
                    existingProjects: state._allProjects,
                    settings: state.settings,
                    deviceId: deviceState.deviceId,
                    now,
                });
                targetProject = newProject;
                nextAllProjects = [...state._allProjects, newProject];
            }

            promotedProjectId = targetProject.id;
            const projectOrderReserver = createProjectOrderReserver(state._allTasks);
            const preparedUpdates = prepareTaskUpdatesForStore({
                task: sourceTask,
                updates: {
                    projectId: targetProject.id,
                    sectionId: undefined,
                    areaId: undefined,
                },
                allTasks: state._allTasks,
                allProjects: nextAllProjects,
                allSections: state._allSections,
                allAreas: state._allAreas,
                projectOrderReserver,
            });
            if (!preparedUpdates.ok) {
                errorMessage = preparedUpdates.error;
                return { error: errorMessage };
            }

            const { updatedTask } = applyTaskUpdates(
                sourceTask,
                {
                    ...preparedUpdates.updates,
                    rev: nextRevision(sourceTask.rev),
                    revBy: deviceState.deviceId,
                },
                now
            );
            const nextAllTasks = replaceEntityInArray(state._allTasks, id, updatedTask);
            const nextVisibleTasks = updateVisibleTasks(state.tasks, sourceTask, updatedTask);
            snapshot = buildSaveSnapshot(state, {
                tasks: nextAllTasks,
                projects: nextAllProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });
            return {
                tasks: nextVisibleTasks,
                _allTasks: nextAllTasks,
                _allProjects: nextAllProjects,
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        if (missingTask) return actionFail('Task not found');
        if (errorMessage) return actionFail(errorMessage);
        return actionOk({ id: promotedProjectId, reused: reusedExistingProject });
    },

    /**
     * Reset checklist items to unchecked (useful for reusable lists).
     */
    resetTaskChecklist: async (id: string) => {
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => {
                const task = state._tasksById.get(id);
                return task && !task.deletedAt && task.checklist && task.checklist.length > 0 ? [task] : [];
            },
            buildUpdates: (task) => {
                const wasDone = task.status === 'done';
                return {
                    checklist: task.checklist?.map((item) => ({
                        ...item,
                        isCompleted: false,
                    })),
                    status: wasDone ? 'next' : task.status,
                    completedAt: wasDone ? undefined : task.completedAt,
                    isFocusedToday: wasDone ? false : task.isFocusedToday,
                };
            },
            missingMessage: 'Task not found',
        });
    },

    /**
     * Move a task to a different status.
     * @param id Task ID
     * @param newStatus New status
     */
    moveTask: async (id: string, newStatus: TaskStatus) => {
        // Delegate to updateTask to ensure recurrence/metadata logic is applied
        return get().updateTask(id, { status: newStatus });
    },

    /**
     * Batch update tasks in a single save cycle.
     */
    batchUpdateTasks: async (updatesList: Array<{ id: string; updates: Partial<Task> }>) => {
        if (updatesList.length === 0) return actionOk();
        const state = get();
        const seenIds = new Set<string>();
        const duplicateIds = new Set<string>();
        for (const { id } of updatesList) {
            if (seenIds.has(id)) {
                duplicateIds.add(id);
                continue;
            }
            seenIds.add(id);
        }
        const duplicateTaskIds = Array.from(duplicateIds);
        if (duplicateTaskIds.length > 0) {
            const message = `Duplicate task ids in batch update: ${duplicateTaskIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const existingTaskIds = new Set(state._tasksById.keys());
        const missingIds = updatesList
            .map((update) => update.id)
            .filter((id, index, ids) => !existingTaskIds.has(id) && ids.indexOf(id) === index);
        if (missingIds.length > 0) {
            const message = `Tasks not found: ${missingIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const preparedUpdatesById = new Map<string, Partial<Task>>();
        for (const { id, updates } of updatesList) {
            const task = state._tasksById.get(id);
            if (!task) continue;
            const preparedUpdates = prepareTaskUpdatesForStore({
                task,
                updates,
                allTasks: state._allTasks,
                allProjects: state._allProjects,
                allSections: state._allSections,
                allAreas: state._allAreas,
                reserveProjectOrder: false,
            });
            if (!preparedUpdates.ok) {
                set({ error: preparedUpdates.error });
                return actionFail(preparedUpdates.error);
            }
            preparedUpdatesById.set(id, preparedUpdates.updates);
        }
        const changeAt = Date.now();
        const now = new Date().toISOString();
        let snapshot: AppData | null = null;

        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            let nextRecurringTasks: Task[] = [];
            const changedTasks: Task[] = [];
            const newAllTasksBase = [...state._allTasks];
            const projectOrderReserver = createProjectOrderReserver(newAllTasksBase);
            for (let index = 0; index < state._allTasks.length; index += 1) {
                const task = newAllTasksBase[index];
                const preparedUpdates = preparedUpdatesById.get(task.id);
                if (!preparedUpdates) continue;
                const adjustedUpdates = reserveProjectOrderForPreparedUpdates({
                    task,
                    updates: preparedUpdates,
                    projectOrderReserver,
                });
                const { updatedTask, nextRecurringTask } = applyTaskUpdates(
                    task,
                    {
                        ...adjustedUpdates,
                        rev: nextRevision(task.rev),
                        revBy: deviceState.deviceId,
                    },
                    now
                );
                const stampedNextRecurringTask = stampNewRecurringFollowUp(nextRecurringTask, deviceState.deviceId);
                const duplicateFollowUp = findExistingRecurringFollowUp(
                    [...newAllTasksBase, ...nextRecurringTasks],
                    stampedNextRecurringTask
                );
                if (stampedNextRecurringTask && !duplicateFollowUp) {
                    nextRecurringTasks = [...nextRecurringTasks, stampedNextRecurringTask];
                }
                newAllTasksBase[index] = updatedTask;
                changedTasks.push(updatedTask);
            }

            const newAllTasks = nextRecurringTasks.length > 0
                ? [...newAllTasksBase, ...nextRecurringTasks]
                : newAllTasksBase;
            const newVisibleTasks = applyVisibleTaskChanges(state.tasks, changedTasks, nextRecurringTasks);

            snapshot = buildSaveSnapshot(state, {
                tasks: newAllTasks,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });

            return {
                tasks: newVisibleTasks,
                _allTasks: newAllTasks,
                _tasksById: replaceEntitiesInMap(state._tasksById, [...changedTasks, ...nextRecurringTasks]),
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return actionOk();
    },

    batchMoveTasks: async (ids: string[], newStatus: TaskStatus) => {
        return get().batchUpdateTasks(ids.map((id) => ({ id, updates: { status: newStatus } })));
    },

    batchDeleteTasks: async (ids: string[]) => {
        if (ids.length === 0) return actionOk();
        const state = get();
        const existingTaskIds = new Set(
            state._allTasks
                .filter((task) => !task.deletedAt)
                .map((task) => task.id)
        );
        const missingIds = ids.filter((id, index) => !existingTaskIds.has(id) && ids.indexOf(id) === index);
        if (missingIds.length > 0) {
            const message = `Tasks not found: ${missingIds.join(', ')}`;
            set({ error: message });
            return actionFail(message);
        }
        const idSet = new Set(ids);
        return mutateTasks({ set, debouncedSave }, {
            selectTasks: (state) => state._allTasks.filter((task) => idSet.has(task.id)),
            buildUpdates: (_task, { now }) => ({ deletedAt: now }),
        });
    },

    queryTasks: async (options: TaskQueryOptions) => {
        const storage = getStorage();
        if (storage.queryTasks) {
            return storage.queryTasks(options);
        }
        const includeArchived = options.includeArchived === true;
        const includeDeleted = options.includeDeleted === true;
        if (!includeArchived && !includeDeleted) {
            const statusFilter = options.status;
            const state = get();
            const derived = state.getDerivedState();
            const indexedTasks = options.projectId
                ? derived.tasksByProjectId.get(options.projectId) ?? []
                : statusFilter && statusFilter !== 'all'
                    ? derived.activeTasksByStatus.get(statusFilter) ?? []
                    : state.tasks;
            return indexedTasks.filter(createTaskQueryMatcher(options, { checkVisibility: false }));
        }
        return get()._allTasks.filter(createTaskQueryMatcher(options, { checkVisibility: true }));
    },
});
