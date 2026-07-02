/**
 * One-way macOS Apple Calendar push for desktop.
 *
 * This mirrors the mobile calendar-push lifecycle: scheduled/due tasks become
 * EventKit events, while completed/archived/deleted/undated tasks remove their
 * pushed event. Task-to-event IDs are stored in the local SQLite calendar_sync
 * table through Tauri commands.
 */
import {
    buildCalendarPushEventFields,
    expandCalendarRecurringTasks,
    getProjectedRecurringTaskId,
    getTaskCalendarOccurrenceDate,
    hasTimeComponent,
    isProjectedRecurringTask,
    isProjectedRecurringTaskId,
    safeFormatDate,
    safeParseDate,
    timeEstimateToMinutes,
    useTaskStore,
    type CalendarSyncEntry,
    type Task,
} from '@mindwtr/core';

import { logInfo, logWarn } from './app-log';
import { isTauriRuntime } from './runtime';
import {
    createSystemCalendarEventResult,
    deleteSystemCalendarEventResult,
    ensureSystemMindwtrCalendar,
    getSystemCalendarPermissionStatus,
    getSystemCalendarPushTargets,
    updateSystemCalendarEventResult,
    type SystemCalendarEventDetails,
    type SystemCalendarEventWriteResult,
    type SystemCalendarPushTarget,
} from './system-calendar';

const DESKTOP_CALENDAR_PUSH_ENABLED_KEY = 'mindwtr:desktop-calendar-push:enabled';
const DESKTOP_CALENDAR_PUSH_TARGET_ID_KEY = 'mindwtr:desktop-calendar-push:target-calendar-id';
const DESKTOP_CALENDAR_PUSH_MANAGED_ID_KEY = 'mindwtr:desktop-calendar-push:managed-calendar-id';
const PLATFORM = 'macos';
const SYNC_DEBOUNCE_MS = 2500;
const CALENDAR_SYNC_CONCURRENCY = 4;
const ACCOUNT_TARGET_TITLE_PREFIX = 'Mindwtr: ';
const PROJECTED_RECURRENCE_EVENT_DATE_FORMAT = 'PP';

type CalendarPushTarget = {
    id: string;
    shouldPrefixTitles: boolean;
};

type DesktopCalendarPushDependencies = {
    createEvent: (details: SystemCalendarEventDetails) => Promise<SystemCalendarEventWriteResult>;
    deleteEvent: (eventId: string) => Promise<SystemCalendarEventWriteResult>;
    ensureMindwtrCalendar: (storedCalendarId?: string | null) => Promise<SystemCalendarPushTarget | null>;
    getAllSyncEntries: (platform: string) => Promise<CalendarSyncEntry[]>;
    getManagedCalendarId: () => Promise<string | null>;
    getPermissionStatus: typeof getSystemCalendarPermissionStatus;
    getPushEnabled: () => Promise<boolean>;
    getStoreState: typeof useTaskStore.getState;
    getSyncEntry: (taskId: string, platform: string) => Promise<CalendarSyncEntry | null>;
    getTargetCalendarId: () => Promise<string | null>;
    getTargets: () => Promise<SystemCalendarPushTarget[]>;
    nowIso: () => string;
    removeManagedCalendarId: () => Promise<void>;
    setManagedCalendarId: (calendarId: string) => Promise<void>;
    setPushEnabled: (enabled: boolean) => Promise<void>;
    setTargetCalendarId: (calendarId: string | null) => Promise<void>;
    subscribe: typeof useTaskStore.subscribe;
    updateEvent: (eventId: string, details: SystemCalendarEventDetails) => Promise<SystemCalendarEventWriteResult>;
    upsertSyncEntry: (entry: CalendarSyncEntry) => Promise<void>;
    deleteSyncEntry: (taskId: string, platform: string) => Promise<void>;
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as any, args as any);
}

const readLocalStorage = (key: string): string | null => {
    if (typeof localStorage === 'undefined') return null;
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

const writeLocalStorage = (key: string, value: string): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(key, value);
    } catch {
        // Best-effort local preference only.
    }
};

const removeLocalStorage = (key: string): void => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(key);
    } catch {
        // Best-effort local preference only.
    }
};

export const getDesktopCalendarPushEnabled = async (): Promise<boolean> => (
    readLocalStorage(DESKTOP_CALENDAR_PUSH_ENABLED_KEY) === '1'
);

export const setDesktopCalendarPushEnabled = async (enabled: boolean): Promise<void> => {
    writeLocalStorage(DESKTOP_CALENDAR_PUSH_ENABLED_KEY, enabled ? '1' : '0');
};

export const getDesktopCalendarPushTargetCalendarId = async (): Promise<string | null> => {
    const value = readLocalStorage(DESKTOP_CALENDAR_PUSH_TARGET_ID_KEY)?.trim() ?? '';
    return value.length > 0 ? value : null;
};

export const setDesktopCalendarPushTargetCalendarId = async (calendarId: string | null): Promise<void> => {
    const trimmed = calendarId?.trim() ?? '';
    if (!trimmed) {
        removeLocalStorage(DESKTOP_CALENDAR_PUSH_TARGET_ID_KEY);
        return;
    }
    writeLocalStorage(DESKTOP_CALENDAR_PUSH_TARGET_ID_KEY, trimmed);
};

const getDesktopCalendarPushManagedCalendarId = async (): Promise<string | null> => {
    const value = readLocalStorage(DESKTOP_CALENDAR_PUSH_MANAGED_ID_KEY)?.trim() ?? '';
    return value.length > 0 ? value : null;
};

const setDesktopCalendarPushManagedCalendarId = async (calendarId: string): Promise<void> => {
    writeLocalStorage(DESKTOP_CALENDAR_PUSH_MANAGED_ID_KEY, calendarId);
};

const removeDesktopCalendarPushManagedCalendarId = async (): Promise<void> => {
    removeLocalStorage(DESKTOP_CALENDAR_PUSH_MANAGED_ID_KEY);
};

const getCalendarSyncEntry = async (taskId: string, platform: string): Promise<CalendarSyncEntry | null> => (
    tauriInvoke<CalendarSyncEntry | null>('get_calendar_sync_entry', { taskId, platform })
);

const upsertCalendarSyncEntry = async (entry: CalendarSyncEntry): Promise<void> => {
    await tauriInvoke('upsert_calendar_sync_entry', { entry });
};

const deleteCalendarSyncEntry = async (taskId: string, platform: string): Promise<void> => {
    await tauriInvoke('delete_calendar_sync_entry', { taskId, platform });
};

const getAllCalendarSyncEntries = async (platform: string): Promise<CalendarSyncEntry[]> => (
    tauriInvoke<CalendarSyncEntry[]>('get_all_calendar_sync_entries', { platform })
);

const defaultDependencies: DesktopCalendarPushDependencies = {
    createEvent: createSystemCalendarEventResult,
    deleteEvent: deleteSystemCalendarEventResult,
    deleteSyncEntry: deleteCalendarSyncEntry,
    ensureMindwtrCalendar: ensureSystemMindwtrCalendar,
    getAllSyncEntries: getAllCalendarSyncEntries,
    getManagedCalendarId: getDesktopCalendarPushManagedCalendarId,
    getPermissionStatus: getSystemCalendarPermissionStatus,
    getPushEnabled: getDesktopCalendarPushEnabled,
    getStoreState: useTaskStore.getState,
    getSyncEntry: getCalendarSyncEntry,
    getTargetCalendarId: getDesktopCalendarPushTargetCalendarId,
    getTargets: getSystemCalendarPushTargets,
    nowIso: () => new Date().toISOString(),
    removeManagedCalendarId: removeDesktopCalendarPushManagedCalendarId,
    setManagedCalendarId: setDesktopCalendarPushManagedCalendarId,
    setPushEnabled: setDesktopCalendarPushEnabled,
    setTargetCalendarId: setDesktopCalendarPushTargetCalendarId,
    subscribe: useTaskStore.subscribe,
    updateEvent: updateSystemCalendarEventResult,
    upsertSyncEntry: upsertCalendarSyncEntry,
};

let dependencies: DesktopCalendarPushDependencies = { ...defaultDependencies };

export const getDesktopCalendarPushTargetCalendars = async (): Promise<SystemCalendarPushTarget[]> => {
    if (!isTauriRuntime()) return [];
    const permission = await dependencies.getPermissionStatus();
    if (permission !== 'granted') return [];
    return dependencies.getTargets();
};

const isMindwtrDedicatedTarget = (target: Pick<SystemCalendarPushTarget, 'isMindwtrDedicated' | 'name'>): boolean => (
    target.isMindwtrDedicated || target.name.trim().toLowerCase() === 'mindwtr'
);

async function ensureDesktopMindwtrCalendar(): Promise<SystemCalendarPushTarget | null> {
    const storedCalendarId = await dependencies.getManagedCalendarId();
    const target = await dependencies.ensureMindwtrCalendar(storedCalendarId);
    if (!target) {
        await dependencies.removeManagedCalendarId();
        return null;
    }
    await dependencies.setManagedCalendarId(target.id);
    return target;
}

async function resolveCalendarPushTarget(): Promise<CalendarPushTarget | null> {
    const selectedId = await dependencies.getTargetCalendarId();
    if (selectedId) {
        const targets = await dependencies.getTargets();
        const selected = targets.find((target) => target.id === selectedId);
        if (selected) {
            return {
                id: selected.id,
                shouldPrefixTitles: !isMindwtrDedicatedTarget(selected),
            };
        }
        await dependencies.setTargetCalendarId(null);
        void logWarn('Selected macOS calendar push target is unavailable; falling back to Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { calendarId: selectedId },
        });
    }

    const managed = await ensureDesktopMindwtrCalendar();
    return managed ? { id: managed.id, shouldPrefixTitles: false } : null;
}

function buildAllDayBoundary(date: Date, dayOffset = 0): Date {
    const boundary = new Date(date);
    boundary.setHours(0, 0, 0, 0);
    boundary.setDate(boundary.getDate() + dayOffset);
    return boundary;
}

function formatProjectedRecurrenceEventDate(task: Task): string {
    return safeFormatDate(getTaskCalendarOccurrenceDate(task), PROJECTED_RECURRENCE_EVENT_DATE_FORMAT);
}

function formatCalendarEventTitle(title: string, shouldPrefixTitle: boolean, occurrenceDateLabel = ''): string {
    const trimmed = title.trim() || 'Task';
    const datedTitle = occurrenceDateLabel ? `${trimmed} (${occurrenceDateLabel})` : trimmed;
    if (!shouldPrefixTitle) return datedTitle;
    if (trimmed.toLowerCase().startsWith(ACCOUNT_TARGET_TITLE_PREFIX.toLowerCase())) {
        return datedTitle;
    }
    return `${ACCOUNT_TARGET_TITLE_PREFIX}${datedTitle}`;
}

function formatProjectedRecurrenceNote(task: Task): string {
    const occurrenceDateLabel = formatProjectedRecurrenceEventDate(task);
    return occurrenceDateLabel
        ? `Projected recurring occurrence for ${occurrenceDateLabel}. Complete the current Mindwtr task to create the real next task.`
        : 'Projected recurring occurrence. Complete the current Mindwtr task to create the real next task.';
}

function buildEventDetails(task: Task, target: CalendarPushTarget): SystemCalendarEventDetails {
    const dateValue = task.startTime ?? task.dueDate;
    const parsed = safeParseDate(dateValue);
    const startDate = parsed ?? new Date();
    const location = typeof task.location === 'string' ? task.location.trim() : '';
    const projectedOccurrenceDateLabel = isProjectedRecurringTask(task)
        ? formatProjectedRecurrenceEventDate(task)
        : '';
    const { projects, sections } = dependencies.getStoreState();
    const projectName = task.projectId
        ? projects.find((project) => project.id === task.projectId)?.title
        : undefined;
    const sectionName = task.sectionId
        ? sections.find((section) => section.id === task.sectionId)?.title
        : undefined;
    const leadingNote = isProjectedRecurringTask(task) ? formatProjectedRecurrenceNote(task) : undefined;
    // SystemCalendarEventDetails has no native URL field, so the primary link
    // rides in the notes (buildCalendarPushEventFields already adds Link: lines).
    const { notes } = buildCalendarPushEventFields(task, { projectName, sectionName, leadingNote });
    const title = formatCalendarEventTitle(task.title, target.shouldPrefixTitles, projectedOccurrenceDateLabel);

    if (hasTimeComponent(dateValue)) {
        const endDate = new Date(startDate.getTime() + timeEstimateToMinutes(task.timeEstimate) * 60 * 1000);
        return {
            calendarId: target.id,
            title,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            allDay: false,
            notes,
            location,
        };
    }

    return {
        calendarId: target.id,
        title,
        start: buildAllDayBoundary(startDate).toISOString(),
        end: buildAllDayBoundary(startDate, 1).toISOString(),
        allDay: true,
        notes,
        location,
    };
}

function shouldRemoveFromCalendar(task: Task): boolean {
    return (!task.dueDate && !task.startTime)
        || !!task.deletedAt
        || task.status === 'done'
        || task.status === 'archived'
        || task.status === 'reference';
}

function isMissingCalendarEventResult(result: SystemCalendarEventWriteResult): boolean {
    return result.error === 'event-not-found';
}

async function removeCalendarEntry(entry: CalendarSyncEntry): Promise<void> {
    const result = await dependencies.deleteEvent(entry.calendarEventId);
    if (!result.ok) {
        void logWarn('Failed to delete macOS calendar event; keeping local sync mapping for retry', {
            scope: 'calendar-push',
            extra: {
                taskId: entry.taskId,
                eventId: entry.calendarEventId,
                error: result.error ?? 'unknown',
            },
        });
        throw new Error(result.error ?? 'calendar-delete-failed');
    }
    await dependencies.deleteSyncEntry(entry.taskId, PLATFORM);
}

async function removeTaskFromCalendar(taskId: string): Promise<void> {
    const entry = await dependencies.getSyncEntry(taskId, PLATFORM);
    if (!entry) return;
    await removeCalendarEntry(entry);
}

async function syncTaskToCalendar(task: Task, target: CalendarPushTarget): Promise<void> {
    if (shouldRemoveFromCalendar(task)) {
        await removeTaskFromCalendar(task.id);
        return;
    }

    const details = buildEventDetails(task, target);
    const existing = await dependencies.getSyncEntry(task.id, PLATFORM);

    if (existing && existing.calendarId === target.id) {
        const updateResult = await dependencies.updateEvent(existing.calendarEventId, details);
        if (updateResult.ok && updateResult.eventId) {
            await dependencies.upsertSyncEntry({
                taskId: task.id,
                calendarEventId: updateResult.eventId,
                calendarId: target.id,
                platform: PLATFORM,
                lastSyncedAt: dependencies.nowIso(),
            });
            return;
        }
        if (!isMissingCalendarEventResult(updateResult)) {
            void logWarn('Failed to update macOS calendar event; keeping local sync mapping for retry', {
                scope: 'calendar-push',
                extra: {
                    taskId: task.id,
                    eventId: existing.calendarEventId,
                    error: updateResult.error ?? 'unknown',
                },
            });
            throw new Error(updateResult.error ?? 'calendar-update-failed');
        }
        await dependencies.deleteSyncEntry(task.id, PLATFORM);
    } else if (existing) {
        await removeCalendarEntry(existing);
    }

    const createResult = await dependencies.createEvent(details);
    if (!createResult.ok || !createResult.eventId) {
        throw new Error(createResult.error ?? 'calendar-create-failed');
    }
    await dependencies.upsertSyncEntry({
        taskId: task.id,
        calendarEventId: createResult.eventId,
        calendarId: target.id,
        platform: PLATFORM,
        lastSyncedAt: dependencies.nowIso(),
    });
}

function getCalendarPushTasks(tasks: Task[]): Task[] {
    const projectedAtIso = dependencies.nowIso();
    return tasks.flatMap((task) => expandCalendarRecurringTasks(task, projectedAtIso));
}

async function runLimitedSettled<T>(
    items: T[],
    runner: (item: T) => Promise<void>
): Promise<PromiseSettledResult<void>[]> {
    if (items.length === 0) return [];
    const results: PromiseSettledResult<void>[] = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.min(CALENDAR_SYNC_CONCURRENCY, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            try {
                await runner(items[index]!);
                results[index] = { status: 'fulfilled', value: undefined };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    });
    await Promise.all(workers);
    return results;
}

// Serialize all calendar writes so a full sync (fired on mount) and the
// debounced partial sync (or two rapid manual refreshes) cannot race on the
// check-then-create path and create duplicate events (#743).
let calendarSyncQueue: Promise<void> = Promise.resolve();
function enqueueCalendarSync(run: () => Promise<void>): Promise<void> {
    const next = calendarSyncQueue.catch(() => undefined).then(run);
    calendarSyncQueue = next.catch(() => undefined);
    return next;
}

export const runFullDesktopCalendarPushSync = (): Promise<void> =>
    enqueueCalendarSync(runFullDesktopCalendarPushSyncUnsafe);

const runFullDesktopCalendarPushSyncUnsafe = async (): Promise<void> => {
    if (!isTauriRuntime()) return;
    const enabled = await dependencies.getPushEnabled();
    if (!enabled) return;
    const permission = await dependencies.getPermissionStatus();
    if (permission !== 'granted') return;

    const target = await resolveCalendarPushTarget();
    if (!target) return;

    const { _allTasks } = dependencies.getStoreState();
    const calendarTasks = getCalendarPushTasks(_allTasks as Task[]);
    const results = await runLimitedSettled(calendarTasks, (task) => syncTaskToCalendar(task, target));

    const activeEventIds = new Set(
        calendarTasks.filter((task) => !shouldRemoveFromCalendar(task)).map((task) => task.id)
    );
    const syncedEntries = await dependencies.getAllSyncEntries(PLATFORM);
    const staleEntries = syncedEntries.filter((entry) => !activeEventIds.has(entry.taskId));
    await runLimitedSettled(staleEntries, removeCalendarEntry);

    const failed = results.filter((result) => result.status === 'rejected').length;
    void logInfo('Full macOS calendar push sync complete', {
        scope: 'calendar-push',
        extra: {
            total: String(calendarTasks.length),
            failed: String(failed),
            stale: String(staleEntries.length),
        },
    });
};

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSyncTaskIds = new Set<string>();

export const scheduleDesktopCalendarPushSyncDebounced = (taskIds: string[]): void => {
    taskIds.forEach((id) => pendingSyncTaskIds.add(id));
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        const idsToSync = Array.from(pendingSyncTaskIds);
        pendingSyncTaskIds.clear();
        void runPartialDesktopCalendarPushSync(idsToSync);
    }, SYNC_DEBOUNCE_MS);
};

const runPartialDesktopCalendarPushSync = (taskIds: string[]): Promise<void> =>
    enqueueCalendarSync(() => runPartialDesktopCalendarPushSyncUnsafe(taskIds));

const runPartialDesktopCalendarPushSyncUnsafe = async (taskIds: string[]): Promise<void> => {
    if (!isTauriRuntime()) return;
    const enabled = await dependencies.getPushEnabled();
    if (!enabled) return;
    const permission = await dependencies.getPermissionStatus();
    if (permission !== 'granted') return;

    const target = await resolveCalendarPushTarget();
    if (!target) return;

    const { _tasksById } = dependencies.getStoreState();
    const targets: Task[] = [];
    const removedIds: string[] = [];

    for (const id of taskIds) {
        if (isProjectedRecurringTaskId(id)) {
            removedIds.push(id);
            continue;
        }
        const task = _tasksById.get(id);
        if (!task) {
            removedIds.push(id, getProjectedRecurringTaskId(id));
            continue;
        }
        const expandedTasks = expandCalendarRecurringTasks(task);
        targets.push(...expandedTasks);
        if (!expandedTasks.some((candidate) => candidate.id === getProjectedRecurringTaskId(task.id))) {
            removedIds.push(getProjectedRecurringTaskId(task.id));
        }
    }

    await Promise.allSettled([
        ...targets.map((task) => syncTaskToCalendar(task, target)),
        ...removedIds.map((id) => removeTaskFromCalendar(id)),
    ]);
};

let unsubscribeStore: (() => void) | null = null;

const buildCalendarSyncTaskMap = (tasks: Task[]) => new Map(tasks.map((task) => [task.id, task]));

export const startDesktopCalendarPushSync = (): (() => void) => {
    if (unsubscribeStore) return unsubscribeStore;

    let previousTaskMap = buildCalendarSyncTaskMap(dependencies.getStoreState()._allTasks as Task[]);

    unsubscribeStore = dependencies.subscribe(
        (state) => state._allTasks,
        (currentTasks) => {
            const changedIds: string[] = [];
            const currentMap = buildCalendarSyncTaskMap(currentTasks as Task[]);

            for (const task of currentTasks as Task[]) {
                const prev = previousTaskMap.get(task.id);
                if (
                    !prev ||
                    prev.updatedAt !== task.updatedAt ||
                    prev.startTime !== task.startTime ||
                    prev.dueDate !== task.dueDate ||
                    prev.deletedAt !== task.deletedAt ||
                    prev.status !== task.status ||
                    prev.title !== task.title ||
                    prev.description !== task.description ||
                    prev.location !== task.location ||
                    prev.timeEstimate !== task.timeEstimate ||
                    prev.recurrence !== task.recurrence ||
                    prev.showFutureRecurrence !== task.showFutureRecurrence
                ) {
                    changedIds.push(task.id);
                }
            }

            for (const id of previousTaskMap.keys()) {
                if (!currentMap.has(id)) {
                    changedIds.push(id);
                }
            }

            previousTaskMap = currentMap;

            if (changedIds.length > 0) {
                scheduleDesktopCalendarPushSyncDebounced(changedIds);
            }
        }
    );

    return () => {
        unsubscribeStore?.();
        unsubscribeStore = null;
        if (syncDebounceTimer) {
            clearTimeout(syncDebounceTimer);
            syncDebounceTimer = null;
        }
        pendingSyncTaskIds.clear();
    };
};

export const stopDesktopCalendarPushSync = (): void => {
    unsubscribeStore?.();
    unsubscribeStore = null;
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    pendingSyncTaskIds.clear();
};

export const __desktopCalendarPushSyncTestUtils = {
    resetForTests() {
        stopDesktopCalendarPushSync();
        calendarSyncQueue = Promise.resolve();
        dependencies = { ...defaultDependencies };
    },
    setDependenciesForTests(overrides: Partial<DesktopCalendarPushDependencies>) {
        dependencies = {
            ...defaultDependencies,
            ...overrides,
        };
    },
};

export const enableDesktopCalendarPush = async (): Promise<boolean> => {
    if (!isTauriRuntime()) return false;
    const permission = await dependencies.getPermissionStatus();
    if (permission !== 'granted') return false;
    const selectedTargetId = await dependencies.getTargetCalendarId();
    if (!selectedTargetId) {
        const managed = await ensureDesktopMindwtrCalendar();
        if (!managed) return false;
    }
    await dependencies.setPushEnabled(true);
    startDesktopCalendarPushSync();
    await runFullDesktopCalendarPushSync();
    return true;
};
