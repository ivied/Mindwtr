import { safeParseDate } from './date';
import { logWarn } from './logger';
import { purgeExpiredTombstones } from './sync';
import { markCoreStartupPhase, measureCoreStartupPhase } from './startup-profiler';
import { normalizeTaskForLoad } from './task-status';
import { dedupeLiveAreasByName } from './area-utils';
import type { StorageAdapter } from './storage';
import type { AppData, Area, MigrationSettings, Project, Task, TaskEditorFieldId } from './types';
import { normalizePeopleForLoad } from './people';
import type { DerivedCache, StoreActionResult, TaskStore } from './store-types';
import {
    buildSaveSnapshot,
    archiveSectionForProjectArchive,
    clearDeletedTaskProjectArchiveMetadata,
    completeTaskForProjectArchive,
    computeProjectDerivedState,
    computeTaskDerivedState,
    ensureDeviceId,
    getNextDataChangeAt,
    normalizeAiSettingsForSync,
    nextRevision,
    reconcileEntityCollection,
    reuseArrayIfShallowEqual,
    selectVisibleAreas,
    selectVisiblePeople,
    selectVisibleProjects,
    selectVisibleSections,
    selectVisibleTasks,
    stripSensitiveSettings,
    withTimeout,
} from './store-helpers';
import { generateUUID as uuidv4 } from './uuid';

const MIGRATION_VERSION = 1;
// Run auto-archive at most twice a day to keep background work bounded.
const AUTO_ARCHIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const TOMBSTONE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TASK_EDITOR_DEFAULTS_VERSION = 5;
const FOCUS_GROUP_BY_DEFAULTS_VERSION = 1;
const TASK_EDITOR_LEAN_DEFAULT_HIDDEN: TaskEditorFieldId[] = [
    'section',
    'priority',
    'energyLevel',
    'timeEstimate',
    'assignedTo',
    'location',
];
const STORAGE_TIMEOUT_MS = 15_000;
const getFetchDataErrorMessage = (error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = detail.trim();
    if (!trimmed) return 'Failed to fetch data';
    if (/timed out/i.test(trimmed)) return 'Storage request timed out. Try again.';
    return `Failed to fetch data: ${trimmed}`;
};
const NON_MUTATING_SETTINGS_KEYS = new Set<keyof AppData['settings']>([
    'network',
    'lastSyncAt',
    'lastSyncStatus',
    'lastSyncError',
    'pendingRemoteWriteAt',
    'pendingRemoteWriteRetryAt',
    'pendingRemoteWriteAttempts',
    'lastSyncStats',
    'lastSyncHistory',
]);

let derivedCache: DerivedCache | null = null;

export const clearDerivedCache = () => {
    derivedCache = null;
};

const settingsValueChanged = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);

const getAutoArchiveDays = (settings: AppData['settings']): number => {
    const configuredArchiveDays = settings.gtd?.autoArchiveDays;
    return Number.isFinite(configuredArchiveDays)
        ? Math.max(0, Math.floor(configuredArchiveDays as number))
        : 7;
};

const autoArchiveStaleCompletedTasks = (
    tasks: Task[],
    settings: AppData['settings'],
    context: { nowIso: string; nowMs: number; deviceId: string; enabled?: boolean }
): { tasks: Task[]; didAutoArchive: boolean } => {
    const archiveDays = getAutoArchiveDays(settings);
    if (context.enabled === false || archiveDays <= 0) {
        return { tasks, didAutoArchive: false };
    }

    const cutoffMs = context.nowMs - archiveDays * 24 * 60 * 60 * 1000;
    let didAutoArchive = false;
    const archivedTasks = tasks.map((task): Task => {
        if (task.deletedAt) return task;
        if (task.status !== 'done') return task;
        const completedAt = safeParseDate(task.completedAt)?.getTime() ?? NaN;
        const updatedAt = safeParseDate(task.updatedAt)?.getTime() ?? NaN;
        const resolvedCompletedAt = Number.isFinite(completedAt) ? completedAt : updatedAt;
        if (!Number.isFinite(resolvedCompletedAt) || resolvedCompletedAt <= 0) return task;
        if (resolvedCompletedAt >= cutoffMs) return task;
        didAutoArchive = true;
        return {
            ...task,
            status: 'archived' as const,
            completedAt: Number.isFinite(completedAt) ? task.completedAt : task.updatedAt || context.nowIso,
            isFocusedToday: false,
            updatedAt: context.nowIso,
            rev: nextRevision(task.rev),
            revBy: context.deviceId,
        };
    });

    return {
        tasks: didAutoArchive ? archivedTasks : tasks,
        didAutoArchive,
    };
};

const runAutoArchive = (
    tasks: Task[],
    settings: AppData['settings'],
    context: { nowIso: string; nowMs: number; deviceId: string; enabled?: boolean }
): { allTasks: Task[]; visibleTasks?: Task[]; didAutoArchive: boolean } => {
    const result = autoArchiveStaleCompletedTasks(tasks, settings, context);
    return {
        allTasks: result.tasks,
        visibleTasks: result.didAutoArchive ? selectVisibleTasks(result.tasks) : undefined,
        didAutoArchive: result.didAutoArchive,
    };
};

const mergeSettingsUpdates = (
    settings: AppData['settings'],
    updates: Partial<AppData['settings']>
): AppData['settings'] => {
    const nextSettings = { ...settings, ...updates };
    if (Object.prototype.hasOwnProperty.call(updates, 'appearance')) {
        const appearanceUpdate = updates.appearance;
        nextSettings.appearance = appearanceUpdate && typeof appearanceUpdate === 'object'
            ? { ...(settings.appearance ?? {}), ...appearanceUpdate }
            : appearanceUpdate;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'network')) {
        const networkUpdate = updates.network;
        nextSettings.network = networkUpdate && typeof networkUpdate === 'object'
            ? { ...(settings.network ?? {}), ...networkUpdate }
            : networkUpdate;
    }
    return nextSettings;
};

const shouldTrackSettingsChange = (
    previous: AppData['settings'],
    next: AppData['settings'],
    updates: Partial<AppData['settings']>
): boolean => {
    const trackedKeys = Object.keys(updates)
        .filter((key) => !NON_MUTATING_SETTINGS_KEYS.has(key as keyof AppData['settings'])) as Array<keyof AppData['settings']>;
    if (trackedKeys.length === 0) return false;
    return trackedKeys.some((key) => settingsValueChanged(previous[key], next[key]));
};

function shouldPromoteScheduledTask(task: AppData['tasks'][number], nowMs: number): boolean {
    if (task.deletedAt || task.purgedAt) return false;
    // Explicit Waiting should remain stable even when dated items become due.
    // Waiting represents a handoff/follow-up decision, not a transient scheduling bucket.
    if (
        task.status === 'next'
        || task.status === 'waiting'
        || task.status === 'done'
        || task.status === 'archived'
        || task.status === 'reference'
    ) {
        return false;
    }
    // Respect deliberate user decisions: if the task was edited AFTER its
    // scheduled date had already passed (e.g. the user moved it back to
    // 'someday' despite an old startTime), do not auto-promote it again.
    // Only promote when the scheduled date passes after the last edit.
    const updatedMs = safeParseDate(task.updatedAt)?.getTime() ?? NaN;
    const isFreshTrigger = (dateMs: number): boolean => {
        if (!Number.isFinite(dateMs) || dateMs > nowMs) return false;
        if (Number.isFinite(updatedMs) && dateMs < updatedMs) return false;
        return true;
    };
    const startMs = safeParseDate(task.startTime)?.getTime() ?? NaN;
    if (isFreshTrigger(startMs)) return true;
    const dueMs = safeParseDate(task.dueDate)?.getTime() ?? NaN;
    if (isFreshTrigger(dueMs)) return true;
    return false;
}

const normalizeAreaForLoad = (area: Area, fallbackOrder: number, nowIso: string): Area => {
    const createdAt = typeof area?.createdAt === 'string' && area.createdAt.trim().length > 0
        ? area.createdAt
        : (typeof area?.updatedAt === 'string' && area.updatedAt.trim().length > 0 ? area.updatedAt : nowIso);
    const updatedAt = typeof area?.updatedAt === 'string' && area.updatedAt.trim().length > 0
        ? area.updatedAt
        : createdAt;
    return {
        ...area,
        order: Number.isFinite(area?.order) ? area.order : fallbackOrder,
        createdAt,
        updatedAt,
    };
};

type StarterTaskTemplate = {
    key: StarterTaskKey;
    title: string;
    description: string;
    checklist: string[];
    contexts?: string[];
    tags?: string[];
    isFocusedToday?: boolean;
};

type StarterTaskKey =
    | 'process-inbox'
    | 'quick-capture'
    | 'focus'
    | 'weekly-review'
    | 'sync'
    | 'import';

const normalizeStarterTaskTitle = (title: string): string => title.trim().toLowerCase();

const STARTER_TASK_TEMPLATES: StarterTaskTemplate[] = [
    {
        key: 'process-inbox',
        title: 'Start here: process your first inbox item',
        description: 'Turn one loose thought into a clear next action, project, or someday item.',
        checklist: [
            'Open Inbox',
            'Tap Process Inbox',
            'Clarify one sample item into a next action or project',
        ],
    },
    {
        key: 'quick-capture',
        title: 'Try quick capture with a context and date',
        description: 'Capture a task and light structure in one line.',
        checklist: [
            'Tap the capture button',
            'Try: Call Alex @phone /due:tomorrow',
            'Keep dates for real deadlines or ticklers',
        ],
        contexts: ['@computer'],
    },
    {
        key: 'focus',
        title: "Star up to 3 tasks for Today's Focus",
        description: 'Pick the few actions you can commit to now.',
        checklist: [
            'Open Focus',
            'Use the star to pick your top actions',
            'Defer an action when it should hide until later',
        ],
        contexts: ['@computer'],
        isFocusedToday: true,
    },
    {
        key: 'sync',
        title: 'Set up sync across your devices',
        description: 'Choose one sync method when you want desktop and mobile to share data.',
        checklist: [
            'Open Settings -> Sync',
            'Choose Dropbox, iCloud, WebDAV, File Sync, or self-hosted',
            'Run Test connection when available, then Sync now',
        ],
    },
    {
        key: 'import',
        title: 'Import tasks from another app',
        description: 'Bring in existing tasks before you reorganize them in Mindwtr.',
        checklist: [
            'Open Settings -> Data',
            'Import Todoist, DGT GTD, OmniFocus, or a backup file',
            'Review imported items from Inbox',
        ],
    },
    {
        key: 'weekly-review',
        title: 'Run your first weekly review',
        description: 'Refresh your lists so the system stays trustworthy.',
        checklist: [
            'Open Review',
            'Clarify Inbox items',
            'Promote the next few actions and leave the rest quiet',
        ],
    },
];

const STARTER_TASK_KEY_BY_TITLE = new Map<string, StarterTaskKey>([
    ...STARTER_TASK_TEMPLATES.map((template): [string, StarterTaskKey] => [
        normalizeStarterTaskTitle(template.title),
        template.key,
    ]),
    ['process your first inbox item', 'process-inbox'],
]);

const getStarterTaskKey = (task: Task): StarterTaskKey | null =>
    STARTER_TASK_KEY_BY_TITLE.get(normalizeStarterTaskTitle(task.title)) ?? null;

const getStarterTaskSortValue = (task: Task): number => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return Number.MAX_SAFE_INTEGER;
};

const buildStarterChecklist = (
    template: StarterTaskTemplate,
    existingChecklist: Task['checklist']
): Task['checklist'] => {
    if (template.checklist.length === 0) return undefined;
    const existingByTitle = new Map(
        (existingChecklist ?? []).map((item) => [normalizeStarterTaskTitle(item.title), item])
    );
    return template.checklist.map((title, index) => {
        const existingItem = existingByTitle.get(normalizeStarterTaskTitle(title)) ?? existingChecklist?.[index];
        return {
            id: existingItem?.id ?? uuidv4(),
            title,
            isCompleted: existingItem?.isCompleted ?? false,
        };
    });
};

const arrayShallowEqual = (left: readonly string[] = [], right: readonly string[] = []): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);

const checklistShallowEqual = (left: Task['checklist'], right: Task['checklist']): boolean => {
    const leftItems = left ?? [];
    const rightItems = right ?? [];
    return leftItems.length === rightItems.length && leftItems.every((item, index) => {
        const other = rightItems[index];
        return Boolean(other)
            && item.id === other.id
            && item.title === other.title
            && item.isCompleted === other.isCompleted;
    });
};

const normalizeExistingStarterTask = (
    task: Task,
    template: StarterTaskTemplate,
    order: number,
    nowIso: string,
    deviceId?: string
): Task => {
    const nextChecklist = buildStarterChecklist(template, task.checklist);
    const nextTaskMode = template.checklist.length > 0 ? 'list' : 'task';
    const nextIsFocusedToday = task.isFocusedToday === undefined ? template.isFocusedToday : task.isFocusedToday;
    const changed =
        task.title !== template.title
        || task.taskMode !== nextTaskMode
        || task.description !== template.description
        || task.order !== order
        || task.orderNum !== order
        || task.isFocusedToday !== nextIsFocusedToday
        || !arrayShallowEqual(task.tags, template.tags ?? [])
        || !arrayShallowEqual(task.contexts, template.contexts ?? [])
        || !checklistShallowEqual(task.checklist, nextChecklist);

    if (!changed) return task;

    return {
        ...task,
        title: template.title,
        taskMode: nextTaskMode,
        tags: template.tags ?? [],
        contexts: template.contexts ?? [],
        checklist: nextChecklist,
        description: template.description,
        order,
        orderNum: order,
        isFocusedToday: nextIsFocusedToday,
        updatedAt: nowIso,
        rev: nextRevision(task.rev),
        ...(deviceId ? { revBy: deviceId } : {}),
    };
};

const buildFreshInstallGettingStartedData = (nowIso: string, deviceId?: string): Pick<AppData, 'projects' | 'tasks'> => {
    const projectId = uuidv4();
    const revisionMeta = deviceId ? { revBy: deviceId } : {};
    const project: Project = {
        id: projectId,
        title: 'Getting Started',
        status: 'active',
        color: '#3B82F6',
        order: 0,
        tagIds: [],
        supportNotes: 'These getting-started tasks are optional. Delete this project anytime when Mindwtr feels set up.',
        rev: 1,
        ...revisionMeta,
        createdAt: nowIso,
        updatedAt: nowIso,
    };
    const tasks: Task[] = STARTER_TASK_TEMPLATES.map((template, index) => ({
        id: uuidv4(),
        title: template.title,
        status: 'next',
        taskMode: template.checklist.length > 0 ? 'list' : 'task',
        tags: template.tags ?? [],
        contexts: template.contexts ?? [],
        ...(template.checklist.length > 0 ? {
            checklist: template.checklist.map((title) => ({
                id: uuidv4(),
                title,
                isCompleted: false,
            })),
        } : {}),
        description: template.description,
        projectId,
        order: index,
        orderNum: index,
        isFocusedToday: template.isFocusedToday,
        rev: 1,
        ...revisionMeta,
        createdAt: nowIso,
        updatedAt: nowIso,
    }));

    const sampleInboxTasks: Task[] = [
        {
            id: uuidv4(),
            title: 'Buy milk',
            status: 'inbox',
            taskMode: 'task',
            tags: [],
            contexts: [],
            rev: 1,
            ...revisionMeta,
            createdAt: nowIso,
            updatedAt: nowIso,
        },
        {
            id: uuidv4(),
            title: 'Reply to Sam',
            status: 'inbox',
            taskMode: 'task',
            tags: [],
            contexts: [],
            rev: 1,
            ...revisionMeta,
            createdAt: nowIso,
            updatedAt: nowIso,
        },
    ];

    return { projects: [project], tasks: [...tasks, ...sampleInboxTasks] };
};

type SettingsActionContext = {
    set: (partial: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore> | TaskStore)) => void;
    get: () => TaskStore;
    debouncedSave: (data: AppData, onError?: (msg: string) => void) => void;
    flushPendingSave: () => Promise<void>;
    hasPendingSaveWork: () => boolean;
    getStorage: () => StorageAdapter;
};

type SettingsActions = Pick<TaskStore, 'fetchData' | 'seedGettingStarted' | 'updateSettings' | 'persistSnapshot' | 'getDerivedState' | 'setHighlightTask'>;

export const createSettingsActions = ({
    set,
    get,
    debouncedSave,
    flushPendingSave,
    hasPendingSaveWork,
    getStorage,
}: SettingsActionContext): SettingsActions => ({
    seedGettingStarted: async (): Promise<StoreActionResult> => {
        const changeAt = Date.now();
        const nowIso = new Date().toISOString();
        let snapshot: AppData | null = null;
        let projectId: string | undefined;

        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const starterData = buildFreshInstallGettingStartedData(nowIso, deviceState.deviceId);
            const starterTemplateProject = starterData.projects[0];
            if (!starterTemplateProject) return state;
            const existingProject = state._allProjects.find((project) =>
                !project.deletedAt &&
                typeof project.title === 'string' &&
                project.title.trim().toLowerCase() === 'getting started'
            );
            const maxProjectOrder = state._allProjects.reduce(
                (max, project) => Math.max(max, Number.isFinite(project.order) ? project.order : -1),
                -1
            );
            const starterProject = existingProject ?? {
                ...starterTemplateProject,
                order: maxProjectOrder + 1,
            };
            const starterTasksByKey = new Map<StarterTaskKey, Task[]>();
            for (const task of state._allTasks) {
                if (task.deletedAt || task.projectId !== starterProject.id) continue;
                const starterKey = getStarterTaskKey(task);
                if (!starterKey) continue;
                const tasksForKey = starterTasksByKey.get(starterKey) ?? [];
                tasksForKey.push(task);
                starterTasksByKey.set(starterKey, tasksForKey);
            }
            const starterTaskUpdates = new Map<string, Task>();
            const existingStarterKeys = new Set<StarterTaskKey>();
            for (const [index, template] of STARTER_TASK_TEMPLATES.entries()) {
                const candidates = (starterTasksByKey.get(template.key) ?? [])
                    .slice()
                    .sort((left, right) => getStarterTaskSortValue(left) - getStarterTaskSortValue(right));
                if (candidates.length === 0) continue;

                existingStarterKeys.add(template.key);
                const currentTitle = normalizeStarterTaskTitle(template.title);
                const preferredCandidate = candidates.find((task) => normalizeStarterTaskTitle(task.title) === currentTitle)
                    ?? candidates[0];
                const normalizedTask = normalizeExistingStarterTask(preferredCandidate, template, index, nowIso, deviceState.deviceId);
                if (normalizedTask !== preferredCandidate) {
                    starterTaskUpdates.set(preferredCandidate.id, normalizedTask);
                }
                for (const duplicate of candidates) {
                    if (duplicate.id === preferredCandidate.id) continue;
                    starterTaskUpdates.set(duplicate.id, {
                        ...duplicate,
                        deletedAt: duplicate.deletedAt ?? nowIso,
                        updatedAt: nowIso,
                        rev: nextRevision(duplicate.rev),
                        ...(deviceState.deviceId ? { revBy: deviceState.deviceId } : {}),
                    });
                }
            }
            const activeTaskTitleKey = (task: Task) => `${task.status}:${task.projectId ?? ''}:${task.title.trim().toLowerCase()}`;
            const existingActiveTaskKeys = new Set(
                state._allTasks
                    .filter((task) => !task.deletedAt)
                    .map(activeTaskTitleKey)
            );
            const tasksToAdd = starterData.tasks
                .map((task) => ({
                    ...task,
                    projectId: task.projectId === starterTemplateProject.id ? starterProject.id : task.projectId,
                }))
                .filter((task) => {
                    const starterKey = task.projectId === starterProject.id ? getStarterTaskKey(task) : null;
                    if (starterKey && existingStarterKeys.has(starterKey)) return false;
                    return !existingActiveTaskKeys.has(activeTaskTitleKey(task));
                });

            projectId = starterProject.id;
            if (existingProject && tasksToAdd.length === 0 && starterTaskUpdates.size === 0 && !deviceState.updated) {
                return state;
            }

            const nextProjects = existingProject ? state._allProjects : [...state._allProjects, starterProject];
            const repairedTasks = starterTaskUpdates.size > 0
                ? state._allTasks.map((task) => starterTaskUpdates.get(task.id) ?? task)
                : state._allTasks;
            const nextTasks = tasksToAdd.length > 0 ? [...repairedTasks, ...tasksToAdd] : repairedTasks;

            snapshot = buildSaveSnapshot(state, {
                tasks: nextTasks,
                projects: nextProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
            });

            return {
                tasks: selectVisibleTasks(nextTasks),
                projects: selectVisibleProjects(nextProjects),
                _allTasks: nextTasks,
                _allProjects: nextProjects,
                ...(deviceState.updated ? { settings: deviceState.settings } : {}),
                lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt, changeAt),
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
        return { success: true, id: projectId };
    },

    /**
     * Fetch all data from the configured storage adapter.
     * Stores full data internally, filters for UI display.
     */
    fetchData: async (options) => {
        markCoreStartupPhase('core.fetch_data.start');
        if (hasPendingSaveWork()) {
            await measureCoreStartupPhase('core.fetch_data.flush_pending_save', async () => {
                await flushPendingSave();
            });
        } else {
            markCoreStartupPhase('core.fetch_data.flush_pending_save.skipped', { reason: 'no_pending_work' });
        }
        if (options?.silent) {
            set({ error: null });
        } else {
            set({ isLoading: true, error: null });
        }
        if (get().editLockCount > 0) {
            if (!options?.silent) {
                set({ isLoading: false });
            }
            logWarn('Skipped fetch while edits are in progress', {
                scope: 'store',
                category: 'storage',
                context: { editLockCount: get().editLockCount },
            });
            return;
        }
        const fetchStartedAt = get().lastDataChangeAt;
        try {
            const storage = getStorage();
            const data = await measureCoreStartupPhase('core.fetch_data.storage_get_data', async () =>
                withTimeout(storage.getData(), STORAGE_TIMEOUT_MS, 'Storage request timed out')
            );
            const postProcessStartedAt = Date.now();
            markCoreStartupPhase('core.fetch_data.post_process:start');
            const rawTasks = Array.isArray(data.tasks) ? data.tasks : [];
            const rawProjects = Array.isArray(data.projects) ? data.projects : [];
            const rawSettings = data.settings && typeof data.settings === 'object' ? data.settings : {};
            const rawSections = Array.isArray((data as AppData).sections) ? (data as AppData).sections : [];
            const rawPeople = Array.isArray((data as AppData).people) ? (data as AppData).people ?? [] : [];
            // Store ALL data including tombstones for persistence
            const nowIso = new Date().toISOString();
            let didNormalizeAreaTimestamps = false;
            const sourceAreas = Array.isArray((data as AppData).areas) ? (data as AppData).areas : [];
            const rawAreas = sourceAreas.map((area, index) => {
                const normalized = normalizeAreaForLoad(area, index, nowIso);
                if (normalized.createdAt !== area.createdAt || normalized.updatedAt !== area.updatedAt || normalized.order !== area.order) {
                    didNormalizeAreaTimestamps = true;
                }
                return normalized;
            });
            const settings = stripSensitiveSettings(rawSettings as AppData['settings']);
            const isFreshInstall =
                rawTasks.length === 0 &&
                rawProjects.length === 0 &&
                rawSections.length === 0 &&
                rawAreas.length === 0 &&
                rawPeople.length === 0 &&
                Object.keys(settings).length === 0;
            const migrations: MigrationSettings = settings.migrations ?? {};
            const shouldRunMigrations = (migrations.version ?? 0) < MIGRATION_VERSION;
            const lastAutoArchiveAt = safeParseDate(migrations.lastAutoArchiveAt)?.getTime() ?? 0;
            const shouldRunAutoArchive = Date.now() - lastAutoArchiveAt > AUTO_ARCHIVE_INTERVAL_MS;
            const lastTombstoneCleanupAt = safeParseDate(migrations.lastTombstoneCleanupAt)?.getTime() ?? 0;
            const shouldRunTombstoneCleanup = Date.now() - lastTombstoneCleanupAt > TOMBSTONE_CLEANUP_INTERVAL_MS;
            const nextMigrationState: MigrationSettings = { ...migrations };
            let didSettingsUpdate = false;

            if (shouldRunMigrations) {
                nextMigrationState.version = MIGRATION_VERSION;
                didSettingsUpdate = true;
            }
            if (shouldRunAutoArchive) {
                nextMigrationState.lastAutoArchiveAt = nowIso;
                didSettingsUpdate = true;
            }
            if (shouldRunTombstoneCleanup) {
                nextMigrationState.lastTombstoneCleanupAt = nowIso;
                didSettingsUpdate = true;
            }

            let nextSettings = didSettingsUpdate
                ? { ...settings, migrations: nextMigrationState }
                : settings;
            const deviceState = ensureDeviceId(nextSettings);
            nextSettings = deviceState.settings;
            if (deviceState.updated) {
                didSettingsUpdate = true;
            }
            if (isFreshInstall && nextSettings.notificationsEnabled === undefined) {
                nextSettings = { ...nextSettings, notificationsEnabled: false };
                didSettingsUpdate = true;
            }

            const existingTaskEditorSettings = nextSettings.gtd?.taskEditor;
            const taskEditorDefaultsVersion = existingTaskEditorSettings?.defaultsVersion ?? 0;
            if (taskEditorDefaultsVersion < TASK_EDITOR_DEFAULTS_VERSION) {
                const legacyHidden = (existingTaskEditorSettings?.hidden ?? []).filter((fieldId) => fieldId !== 'textDirection');
                const legacyOrder = existingTaskEditorSettings?.order?.filter((fieldId) => fieldId !== 'textDirection');
                const hasCustomLayout = Boolean(
                    legacyHidden.length > 0
                    || (legacyOrder && legacyOrder.length > 0)
                    || Object.keys(existingTaskEditorSettings?.sections ?? {}).length > 0
                    || Object.keys(existingTaskEditorSettings?.sectionOpen ?? {}).length > 0
                );
                const hidden = new Set<TaskEditorFieldId>(
                    hasCustomLayout ? legacyHidden : TASK_EDITOR_LEAN_DEFAULT_HIDDEN
                );
                if (taskEditorDefaultsVersion < 4) {
                    hidden.delete('textDirection');
                }
                nextSettings = {
                    ...nextSettings,
                    gtd: {
                        ...(nextSettings.gtd ?? {}),
                        taskEditor: {
                            ...(existingTaskEditorSettings ?? {}),
                            ...(legacyOrder ? { order: legacyOrder } : {}),
                            hidden: Array.from(hidden),
                            defaultsVersion: TASK_EDITOR_DEFAULTS_VERSION,
                        },
                    },
                };
                didSettingsUpdate = true;
            }

            const focusGroupByDefaultsVersion = nextSettings.gtd?.focusGroupByDefaultsVersion ?? 0;
            if (focusGroupByDefaultsVersion < FOCUS_GROUP_BY_DEFAULTS_VERSION) {
                const nextGtd = {
                    ...(nextSettings.gtd ?? {}),
                    focusGroupByDefaultsVersion: FOCUS_GROUP_BY_DEFAULTS_VERSION,
                };
                const didMigrateLegacyContextDefault = nextGtd.focusGroupBy === 'context';
                if (didMigrateLegacyContextDefault) {
                    nextGtd.focusGroupBy = 'none';
                }
                nextSettings = {
                    ...nextSettings,
                    gtd: nextGtd,
                    ...(didMigrateLegacyContextDefault
                        ? {
                            syncPreferencesUpdatedAt: {
                                ...(nextSettings.syncPreferencesUpdatedAt ?? {}),
                                gtd: nowIso,
                            },
                        }
                        : {}),
                };
                didSettingsUpdate = true;
            }

            let didClearDeletedProjectArchiveMetadata = false;
            let allTasks = rawTasks
                .map((task) => normalizeTaskForLoad(task, nowIso))
                .map((task) => {
                    const nextTask = clearDeletedTaskProjectArchiveMetadata(task);
                    if (nextTask !== task) {
                        didClearDeletedProjectArchiveMetadata = true;
                    }
                    return nextTask;
                });
            const nowMs = Date.now();
            let didPromoteScheduled = false;
            allTasks = allTasks.map((task) => {
                if (!shouldPromoteScheduledTask(task, nowMs)) return task;
                didPromoteScheduled = true;
                return {
                    ...task,
                    status: 'next',
                    updatedAt: nowIso,
                    rev: nextRevision(task.rev),
                    revBy: nextSettings.deviceId,
                };
            });

            // Auto-archive stale completed items to keep day-to-day UI fast/clean.
            const autoArchiveResult = runAutoArchive(allTasks, settings, {
                nowIso,
                nowMs,
                deviceId: deviceState.deviceId,
                enabled: shouldRunAutoArchive,
            });
            allTasks = autoArchiveResult.allTasks;
            const didAutoArchive = autoArchiveResult.didAutoArchive;
            const peopleLoadResult = normalizePeopleForLoad(rawPeople, allTasks, nowIso, nextSettings.deviceId);
            let allPeople = peopleLoadResult.people;
            const didPeopleMigration = peopleLoadResult.didChange;
            let didProjectOrderMigration = false;
            let didAreaMigration = didNormalizeAreaTimestamps;
            let allProjects = rawProjects;
            let allSections = rawSections;
            let allAreas = rawAreas;

            const remapAreaReferences = (areaIdRemap: Map<string, string>) => {
                if (areaIdRemap.size === 0) return;
                const liveAreaById = new Map(
                    allAreas
                        .filter((area) => !area.deletedAt)
                        .map((area) => [area.id, area] as const)
                );
                allProjects = allProjects.map((project) => {
                    const remappedAreaId = project.areaId ? areaIdRemap.get(project.areaId) : undefined;
                    if (!remappedAreaId || remappedAreaId === project.areaId) return project;
                    const remappedArea = liveAreaById.get(remappedAreaId);
                    didAreaMigration = true;
                    return {
                        ...project,
                        areaId: remappedAreaId,
                        areaTitle: remappedArea?.name ?? project.areaTitle,
                        updatedAt: nowIso,
                        rev: nextRevision(project.rev),
                        revBy: nextSettings.deviceId,
                    };
                });
                allTasks = allTasks.map((task) => {
                    const remappedAreaId = task.areaId ? areaIdRemap.get(task.areaId) : undefined;
                    if (!remappedAreaId || remappedAreaId === task.areaId) return task;
                    didAreaMigration = true;
                    return {
                        ...task,
                        areaId: task.projectId ? undefined : remappedAreaId,
                        updatedAt: nowIso,
                        rev: nextRevision(task.rev),
                        revBy: nextSettings.deviceId,
                    };
                });
                const configuredDefaultAreaId = nextSettings.gtd?.defaultAreaId;
                const remappedDefaultAreaId = typeof configuredDefaultAreaId === 'string'
                    ? areaIdRemap.get(configuredDefaultAreaId)
                    : undefined;
                if (remappedDefaultAreaId && remappedDefaultAreaId !== configuredDefaultAreaId) {
                    nextSettings = {
                        ...nextSettings,
                        gtd: {
                            ...(nextSettings.gtd ?? {}),
                            defaultAreaId: remappedDefaultAreaId,
                        },
                        syncPreferencesUpdatedAt: {
                            ...(nextSettings.syncPreferencesUpdatedAt ?? {}),
                            gtd: nowIso,
                        },
                    };
                    didAreaMigration = true;
                    didSettingsUpdate = true;
                }
            };

            if (shouldRunMigrations) {
                allProjects = rawProjects.map((project) => {
                    const status = project.status;
                    const normalizedStatus =
                        status === 'active' || status === 'someday' || status === 'waiting' || status === 'archived'
                            ? status
                            : status === 'completed'
                                ? 'archived'
                                : 'active';
                    const tagIds = Array.isArray((project as Project).tagIds) ? (project as Project).tagIds : [];
                    const normalizedProject =
                        normalizedStatus === status
                            ? { ...project, tagIds }
                            : { ...project, status: normalizedStatus, tagIds };
                    return normalizedProject;
                });
                const projectOrderCounters = new Map<string, number>();
                allProjects = allProjects.map((project) => {
                    const areaKey = project.areaId ?? '__none__';
                    const nextIndex = projectOrderCounters.get(areaKey) ?? 0;
                    const existingOrder = Number.isFinite((project as Project).order) ? (project as Project).order : undefined;
                    if (!Number.isFinite(existingOrder)) {
                        didProjectOrderMigration = true;
                    }
                    const order = Number.isFinite(existingOrder) ? (existingOrder as number) : nextIndex;
                    projectOrderCounters.set(areaKey, Math.max(nextIndex, order + 1));
                    return { ...project, order } as Project;
                });
                allAreas = rawAreas
                    .map((area, index) => ({
                        ...area,
                        order: Number.isFinite(area.order) ? area.order : index,
                    }))
                    .sort((a, b) => a.order - b.order);
                const areaIds = new Set(allAreas.map((area) => area.id));
                let hasLegacyAreaTitle = false;
                let hasMissingAreaId = false;
                for (const project of rawProjects) {
                    if (!hasLegacyAreaTitle && typeof project.areaTitle === 'string' && project.areaTitle.trim() && !project.areaId) {
                        hasLegacyAreaTitle = true;
                    }
                    if (!hasMissingAreaId && project.areaId && !areaIds.has(project.areaId)) {
                        hasMissingAreaId = true;
                    }
                    if (hasLegacyAreaTitle && hasMissingAreaId) break;
                }
                const shouldRunAreaMigration = hasLegacyAreaTitle || hasMissingAreaId;
                if (shouldRunAreaMigration) {
                    const areaByName = new Map<string, string>();
                    allAreas.forEach((area) => {
                        if (area.deletedAt) return;
                        const normalizedName = typeof area?.name === 'string' ? area.name.trim().toLowerCase() : '';
                        if (normalizedName && !areaByName.has(normalizedName)) areaByName.set(normalizedName, area.id);
                    });
                    const ensureAreaForTitle = (title: string) => {
                        const trimmed = title.trim();
                        if (!trimmed) return undefined;
                        const key = trimmed.toLowerCase();
                        const existing = areaByName.get(key);
                        if (existing) return existing;
                        const now = new Date().toISOString();
                        const id = uuidv4();
                        const order = allAreas.reduce((max, area) => Math.max(max, Number.isFinite(area.order) ? area.order : -1), -1) + 1;
                        allAreas = [...allAreas, { id, name: trimmed, order, createdAt: now, updatedAt: now }];
                        areaByName.set(key, id);
                        didAreaMigration = true;
                        return id;
                    };
                    const areaIdExists = (areaId?: string) =>
                        Boolean(areaId && allAreas.some((area) => area.id === areaId && !area.deletedAt));
                    allProjects = allProjects.map((project) => {
                        if (areaIdExists(project.areaId)) return project;
                        const areaTitle = typeof project.areaTitle === 'string' ? project.areaTitle : '';
                        if (!areaTitle) return project;
                        const derivedId = ensureAreaForTitle(areaTitle);
                        if (!derivedId) return project;
                        didAreaMigration = true;
                        return { ...project, areaId: derivedId };
                    });
                    allAreas = allAreas
                        .map((area, index) => ({
                            ...area,
                            order: Number.isFinite(area.order) ? area.order : index,
                        }))
                        .sort((a, b) => a.order - b.order);
                }
            }
            const dedupedAreas = dedupeLiveAreasByName(allAreas, {
                nowIso,
                revBy: nextSettings.deviceId,
            });
            if (dedupedAreas.changed) {
                allAreas = dedupedAreas.areas
                    .map((area, index) => ({
                        ...area,
                        order: Number.isFinite(area.order) ? area.order : index,
                    }))
                    .sort((a, b) => a.order - b.order);
                didAreaMigration = true;
                remapAreaReferences(dedupedAreas.areaIdRemap);
            }
            let didCompleteTasksForArchivedProjects = false;
            let didArchiveSectionsForArchivedProjects = false;
            const archivedProjectIds = new Set(
                allProjects
                    .filter((project) => !project.deletedAt && project.status === 'archived')
                    .map((project) => project.id)
            );
            if (archivedProjectIds.size > 0) {
                allTasks = allTasks.map((task) => {
                    if (task.deletedAt || task.status === 'done' || task.status === 'archived') return task;
                    if (!task.projectId || !archivedProjectIds.has(task.projectId)) return task;
                    didCompleteTasksForArchivedProjects = true;
                    return completeTaskForProjectArchive(task, nowIso, nextSettings.deviceId);
                });
                allSections = allSections.map((section) => {
                    if (section.deletedAt) return section;
                    if (!archivedProjectIds.has(section.projectId)) return section;
                    didArchiveSectionsForArchivedProjects = true;
                    return archiveSectionForProjectArchive(section, nowIso, nextSettings.deviceId);
                });
            }
            let didRepairEntityReferences = false;
            const activeAreaIds = new Set(
                allAreas
                    .filter((area) => !area.deletedAt)
                    .map((area) => area.id)
            );
            allProjects = allProjects.map((project) => {
                if (project.deletedAt || !project.areaId || activeAreaIds.has(project.areaId)) return project;
                didRepairEntityReferences = true;
                return {
                    ...project,
                    areaId: undefined,
                    updatedAt: nowIso,
                    rev: nextRevision(project.rev),
                    revBy: nextSettings.deviceId,
                };
            });
            const activeProjectIds = new Set(
                allProjects
                    .filter((project) => !project.deletedAt)
                    .map((project) => project.id)
            );
            allSections = allSections.map((section) => {
                if (section.deletedAt || activeProjectIds.has(section.projectId)) return section;
                didRepairEntityReferences = true;
                return {
                    ...section,
                    deletedAt: nowIso,
                    updatedAt: nowIso,
                    rev: nextRevision(section.rev),
                    revBy: nextSettings.deviceId,
                };
            });
            const activeSectionProjectIds = new Map(
                allSections
                    .filter((section) => !section.deletedAt)
                    .map((section) => [section.id, section.projectId])
            );
            allTasks = allTasks.map((task) => {
                if (task.deletedAt) return task;
                let nextTask = task;
                let changed = false;
                if (nextTask.projectId && !activeProjectIds.has(nextTask.projectId)) {
                    nextTask = {
                        ...nextTask,
                        projectId: undefined,
                        sectionId: undefined,
                    };
                    changed = true;
                }
                const sectionProjectId = nextTask.sectionId ? activeSectionProjectIds.get(nextTask.sectionId) : undefined;
                if (nextTask.sectionId && (!sectionProjectId || (nextTask.projectId && sectionProjectId !== nextTask.projectId))) {
                    nextTask = {
                        ...nextTask,
                        sectionId: undefined,
                    };
                    changed = true;
                }
                if (nextTask.areaId && !activeAreaIds.has(nextTask.areaId)) {
                    nextTask = {
                        ...nextTask,
                        areaId: undefined,
                    };
                    changed = true;
                }
                if (!changed) return task;
                didRepairEntityReferences = true;
                return {
                    ...nextTask,
                    updatedAt: nowIso,
                    rev: nextRevision(task.rev),
                    revBy: nextSettings.deviceId,
                };
            });
            let didTombstoneCleanup = false;
            if (shouldRunTombstoneCleanup) {
                const cleanup = purgeExpiredTombstones(
                    {
                        tasks: allTasks,
                        projects: allProjects,
                        sections: allSections,
                        areas: allAreas,
                        people: allPeople,
                        settings: nextSettings,
                    },
                    nowIso
                );
                allTasks = cleanup.data.tasks;
                allProjects = cleanup.data.projects;
                allSections = cleanup.data.sections;
                allAreas = cleanup.data.areas;
                allPeople = cleanup.data.people ?? [];
                nextSettings = cleanup.data.settings;
                if (
                    cleanup.removedTaskTombstones > 0
                    || cleanup.removedProjectTombstones > 0
                    || cleanup.removedSectionTombstones > 0
                    || cleanup.removedAreaTombstones > 0
                    || cleanup.removedPersonTombstones > 0
                    || cleanup.removedAttachmentTombstones > 0
                    || cleanup.removedSavedFilterTombstones > 0
                ) {
                    didTombstoneCleanup = true;
                    logWarn('Purged expired tombstones during data fetch', {
                        scope: 'store',
                        category: 'storage',
                        context: {
                            removedTaskTombstones: cleanup.removedTaskTombstones,
                            removedProjectTombstones: cleanup.removedProjectTombstones,
                            removedSectionTombstones: cleanup.removedSectionTombstones,
                            removedAreaTombstones: cleanup.removedAreaTombstones,
                            removedPersonTombstones: cleanup.removedPersonTombstones,
                            removedAttachmentTombstones: cleanup.removedAttachmentTombstones,
                            removedSavedFilterTombstones: cleanup.removedSavedFilterTombstones,
                        },
                    });
                }
            }
            markCoreStartupPhase('core.fetch_data.post_process:end', { durationMs: Date.now() - postProcessStartedAt });
            let skippedDueToConcurrentLocalChange = false;
            await measureCoreStartupPhase('core.fetch_data.zustand_set_state', async () => {
                set((state) => {
                    if (state.lastDataChangeAt > fetchStartedAt) {
                        skippedDueToConcurrentLocalChange = true;
                        return options?.silent ? {} : { isLoading: false };
                    }
                    const nextTasks = reconcileEntityCollection(state._allTasks, state._tasksById, allTasks);
                    const nextProjects = reconcileEntityCollection(state._allProjects, state._projectsById, allProjects);
                    const nextSections = reconcileEntityCollection(state._allSections, state._sectionsById, allSections);
                    const nextAreas = reconcileEntityCollection(state._allAreas, state._areasById, allAreas);
                    const nextPeople = reconcileEntityCollection(state._allPeople, state._peopleById, allPeople);
                    const visibleTasks = reuseArrayIfShallowEqual(state.tasks, selectVisibleTasks(nextTasks.items));
                    const visibleProjects = reuseArrayIfShallowEqual(state.projects, selectVisibleProjects(nextProjects.items));
                    const visibleSections = reuseArrayIfShallowEqual(state.sections, selectVisibleSections(nextSections.items));
                    const visibleAreas = reuseArrayIfShallowEqual(state.areas, selectVisibleAreas(nextAreas.items));
                    const visiblePeople = reuseArrayIfShallowEqual(state.people, selectVisiblePeople(nextPeople.items));
                    return {
                        tasks: visibleTasks,
                        projects: visibleProjects,
                        sections: visibleSections,
                        areas: visibleAreas,
                        people: visiblePeople,
                        settings: nextSettings,
                        _allTasks: nextTasks.items,
                        _allProjects: nextProjects.items,
                        _allSections: nextSections.items,
                        _allAreas: nextAreas.items,
                        _allPeople: nextPeople.items,
                        _tasksById: nextTasks.byId,
                        _projectsById: nextProjects.byId,
                        _sectionsById: nextSections.byId,
                        _areasById: nextAreas.byId,
                        _peopleById: nextPeople.byId,
                        isLoading: false,
                        lastDataChangeAt:
                            didAutoArchive
                                || didPromoteScheduled
                                || didCompleteTasksForArchivedProjects
                                || didArchiveSectionsForArchivedProjects
                                || didClearDeletedProjectArchiveMetadata
                                || didRepairEntityReferences
                                || didTombstoneCleanup
                                || didPeopleMigration
                                ? getNextDataChangeAt(state.lastDataChangeAt)
                                : state.lastDataChangeAt,
                    };
                });
            });
            if (skippedDueToConcurrentLocalChange) {
                markCoreStartupPhase('core.fetch_data.skipped_local_change');
                logWarn('Skipped fetch result because local data changed during fetch', {
                    scope: 'store',
                    category: 'storage',
                    context: {
                        fetchStartedAt,
                        currentChangeAt: get().lastDataChangeAt,
                    },
                });
                return;
            }

            if (
                didAutoArchive
                || didPromoteScheduled
                || didCompleteTasksForArchivedProjects
                || didArchiveSectionsForArchivedProjects
                || didClearDeletedProjectArchiveMetadata
                || didRepairEntityReferences
                || didTombstoneCleanup
                || didAreaMigration
                || didPeopleMigration
                || didProjectOrderMigration
                || didSettingsUpdate
            ) {
                markCoreStartupPhase('core.fetch_data.debounced_save_enqueued');
                debouncedSave(
                    { tasks: allTasks, projects: allProjects, sections: allSections, areas: allAreas, people: allPeople, settings: nextSettings },
                    (msg) => set({ error: msg })
                );
            }
            markCoreStartupPhase('core.fetch_data.end');
        } catch (err) {
            markCoreStartupPhase('core.fetch_data.error');
            set({ error: getFetchDataErrorMessage(err), isLoading: false });
        }
    },

    /**
     * Update application settings.
     * @param updates Settings to update
     */
    updateSettings: async (updates: Partial<AppData['settings']>) => {
        const archiveDaysUpdate = updates.gtd?.autoArchiveDays !== undefined;
        let snapshot: AppData | null = null;
        set((state) => {
            const deviceState = ensureDeviceId(state.settings);
            const nowIso = new Date().toISOString();
            const nextSettings = mergeSettingsUpdates(deviceState.settings, updates);
            const nextSyncUpdatedAt = { ...(deviceState.settings.syncPreferencesUpdatedAt ?? {}) };
            let syncUpdated = false;

            const markSyncUpdated = (key: keyof NonNullable<AppData['settings']['syncPreferencesUpdatedAt']>) => {
                nextSyncUpdatedAt[key] = nowIso;
                syncUpdated = true;
            };

            if ('syncPreferences' in updates) {
                markSyncUpdated('preferences');
            }

            if ('theme' in updates || 'appearance' in updates || 'keybindingStyle' in updates) {
                markSyncUpdated('appearance');
            }

            const defaultScheduleTimeUpdate = updates.gtd
                ? Object.prototype.hasOwnProperty.call(updates.gtd, 'defaultScheduleTime')
                : false;
            const defaultAreaIdUpdate = updates.gtd
                ? Object.prototype.hasOwnProperty.call(updates.gtd, 'defaultAreaId')
                : false;
            const defaultAreaModeUpdate = updates.gtd
                ? Object.prototype.hasOwnProperty.call(updates.gtd, 'defaultAreaMode')
                : false;
            const focusTaskLimitUpdate = updates.gtd
                ? Object.prototype.hasOwnProperty.call(updates.gtd, 'focusTaskLimit')
                : false;
            const focusGroupByUpdate = updates.gtd
                ? Object.prototype.hasOwnProperty.call(updates.gtd, 'focusGroupBy')
                : false;
            const defaultProjectFlowModeUpdate = updates.gtd
                ? Object.prototype.hasOwnProperty.call(updates.gtd, 'defaultProjectFlowMode')
                : false;

            if ('language' in updates || 'weekStart' in updates || 'dateFormat' in updates || 'timeFormat' in updates) {
                markSyncUpdated('language');
            }

            if (defaultScheduleTimeUpdate || defaultAreaIdUpdate || defaultAreaModeUpdate || focusTaskLimitUpdate || focusGroupByUpdate || defaultProjectFlowModeUpdate) {
                markSyncUpdated('gtd');
            }

            if ('externalCalendars' in updates) {
                markSyncUpdated('externalCalendars');
            }

            if ('savedFilters' in updates) {
                markSyncUpdated('savedFilters');
            }

            if ('ai' in updates) {
                const prevAi = normalizeAiSettingsForSync(deviceState.settings.ai);
                const nextAi = normalizeAiSettingsForSync(nextSettings.ai);
                if (JSON.stringify(prevAi ?? null) !== JSON.stringify(nextAi ?? null)) {
                    markSyncUpdated('ai');
                }
            }

            const newSettings = syncUpdated ? { ...nextSettings, syncPreferencesUpdatedAt: nextSyncUpdatedAt } : nextSettings;
            const shouldTrackChange = shouldTrackSettingsChange(state.settings, newSettings, updates);
            if (archiveDaysUpdate) {
                const autoArchiveResult = runAutoArchive(state._allTasks, newSettings, {
                    nowIso,
                    nowMs: Date.now(),
                    deviceId: deviceState.deviceId,
                });

                if (autoArchiveResult.didAutoArchive) {
                    snapshot = buildSaveSnapshot(state, { tasks: autoArchiveResult.allTasks, settings: newSettings });
                    return {
                        tasks: autoArchiveResult.visibleTasks ?? selectVisibleTasks(autoArchiveResult.allTasks),
                        _allTasks: autoArchiveResult.allTasks,
                        settings: newSettings,
                        lastDataChangeAt: getNextDataChangeAt(state.lastDataChangeAt),
                    };
                }
            }

            snapshot = buildSaveSnapshot(state, { settings: newSettings });
            return {
                settings: newSettings,
                lastDataChangeAt: shouldTrackChange ? getNextDataChangeAt(state.lastDataChangeAt) : state.lastDataChangeAt,
            };
        });

        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    persistSnapshot: async () => {
        let snapshot: AppData | null = null;
        set((state) => {
            snapshot = buildSaveSnapshot(state);
            return {};
        });
        if (snapshot) {
            debouncedSave(snapshot, (msg) => set({ error: msg }));
        }
    },

    getDerivedState: () => {
        const state = get();
        if (
            derivedCache
            && derivedCache.visibleTasksRef === state.tasks
            && derivedCache.taskLookupRef === state._tasksById
            && derivedCache.projectLookupRef === state._projectsById
        ) {
            return derivedCache.value;
        }
        const previous = derivedCache?.value;
        const taskDerived =
            derivedCache
                && derivedCache.visibleTasksRef === state.tasks
                && derivedCache.taskLookupRef === state._tasksById
                && previous
                ? {
                    tasksById: previous.tasksById,
                    activeTasksByStatus: previous.activeTasksByStatus,
                    tasksByProjectId: previous.tasksByProjectId,
                    tasksByContext: previous.tasksByContext,
                    tasksByTag: previous.tasksByTag,
                    focusedTasks: previous.focusedTasks,
                    projectTaskSummaryById: previous.projectTaskSummaryById,
                    allContexts: previous.allContexts,
                    allTags: previous.allTags,
                    contextTokenUsage: previous.contextTokenUsage,
                    tagTokenUsage: previous.tagTokenUsage,
                    dateCoherenceIssuesByTaskId: previous.dateCoherenceIssuesByTaskId,
                    focusedCount: previous.focusedCount,
                }
                : computeTaskDerivedState(state.tasks, state._tasksById);
        const projectDerived =
            derivedCache && derivedCache.projectLookupRef === state._projectsById && previous
                ? {
                    projectMap: previous.projectMap,
                    sequentialProjectIds: previous.sequentialProjectIds,
                    sequentialWithinSectionProjectIds: previous.sequentialWithinSectionProjectIds,
                    focusedProjectCount: previous.focusedProjectCount,
                }
                : computeProjectDerivedState(state._allProjects, state._projectsById);
        const derived = {
            ...projectDerived,
            ...taskDerived,
        };
        derivedCache = {
            visibleTasksRef: state.tasks,
            taskLookupRef: state._tasksById,
            projectLookupRef: state._projectsById,
            value: derived,
        };
        return derived;
    },

    setHighlightTask: (id: string | null) => {
        set({ highlightTaskId: id, highlightTaskAt: id ? Date.now() : null });
    },
});
