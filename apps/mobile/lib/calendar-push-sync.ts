/**
 * Calendar push sync service.
 *
 * One-way push of scheduled tasks and tasks with due dates into a device
 * calendar (iOS EventKit via expo-calendar). Creates, updates, or removes
 * calendar events as task dates change. Mapping between task IDs and
 * calendar event IDs is persisted in the SQLite calendar_sync table.
 */
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
    type Task,
} from '@mindwtr/core';

import { logInfo, logWarn, logError } from './app-log';
import {
    getCalendarSyncEntry,
    upsertCalendarSyncEntry,
    deleteCalendarSyncEntry,
    getAllCalendarSyncEntries,
} from './storage-adapter';

// MARK: - Constants

const CALENDAR_PUSH_ENABLED_KEY = 'mindwtr:calendar-push-sync:enabled';
const CALENDAR_ID_KEY = 'mindwtr:calendar-push-sync:calendar-id';
const CALENDAR_TARGET_ID_KEY = 'mindwtr:calendar-push-sync:target-calendar-id';
const CALENDAR_COLOR_KEY = 'mindwtr:calendar-push-sync:color';
const PLATFORM = Platform.OS;
const SYNC_DEBOUNCE_MS = 2500;
const CALENDAR_SYNC_CONCURRENCY = 4;
const MANAGED_CALENDAR_TITLE = 'Mindwtr';
const MANAGED_CALENDAR_NAME = 'mindwtr';
const DEFAULT_MANAGED_CALENDAR_COLOR = '#3B82F6';
const PROJECTED_RECURRENCE_EVENT_DATE_FORMAT = 'PP';

export const CALENDAR_PUSH_COLOR_OPTIONS = [
    '#3B82F6',
    '#2563EB',
    '#7C3AED',
    '#DB2777',
    '#EA580C',
    '#059669',
    '#0891B2',
    '#65A30D',
] as const;

export type CalendarPushTargetCalendar = {
    id: string;
    name: string;
    sourceName?: string;
    color?: string;
    isMindwtrDedicated: boolean;
    isMindwtrManaged: boolean;
    isLocalOnly: boolean;
};

type CalendarPushTarget = {
    id: string;
};

function normalizeCalendarColor(value: string | null | undefined): string {
    const trimmed = value?.trim().toUpperCase() ?? '';
    return CALENDAR_PUSH_COLOR_OPTIONS.includes(trimmed as typeof CALENDAR_PUSH_COLOR_OPTIONS[number])
        ? trimmed
        : DEFAULT_MANAGED_CALENDAR_COLOR;
}

function isReadableAccountName(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return normalized.length > 0
        && normalized !== MANAGED_CALENDAR_NAME
        && normalized !== 'local account'
        && !normalized.endsWith('@group.calendar.google.com');
}

function getCalendarSourceName(calendar: Calendar.Calendar): string | undefined {
    const ownerAccount = typeof calendar.ownerAccount === 'string' && calendar.ownerAccount.trim().length > 0
        ? calendar.ownerAccount.trim()
        : undefined;
    const sourceName = typeof calendar.source?.name === 'string' && calendar.source.name.trim().length > 0
        ? calendar.source.name.trim()
        : undefined;

    if (sourceName && isReadableAccountName(sourceName)) {
        return sourceName;
    }

    if (ownerAccount && isReadableAccountName(ownerAccount)) {
        return ownerAccount;
    }

    return sourceName ?? ownerAccount;
}

function getCalendarSourceType(calendar: Calendar.Calendar): string | undefined {
    const sourceType = typeof calendar.source?.type === 'string' ? calendar.source.type.trim() : '';
    if (sourceType.length > 0) return sourceType;

    const platformCalendar = calendar as Calendar.Calendar & { type?: unknown };
    const calendarType = typeof platformCalendar.type === 'string' ? platformCalendar.type.trim() : '';
    return calendarType.length > 0 ? calendarType : undefined;
}

function isLocalOnlyCalendar(calendar: Calendar.Calendar): boolean {
    if (calendar.source?.isLocalAccount === true) return true;

    const sourceType = getCalendarSourceType(calendar)?.toLowerCase();
    if (sourceType === 'local') return true;

    const ownerAccount = typeof calendar.ownerAccount === 'string' ? calendar.ownerAccount.trim().toLowerCase() : '';
    const sourceName = typeof calendar.source?.name === 'string' ? calendar.source.name.trim().toLowerCase() : '';
    return ownerAccount === 'local account' && sourceName === 'local account';
}

// MARK: - Settings

export const getCalendarPushEnabled = async (): Promise<boolean> => {
    const val = await AsyncStorage.getItem(CALENDAR_PUSH_ENABLED_KEY);
    return val === '1';
};

export const setCalendarPushEnabled = async (enabled: boolean): Promise<void> => {
    await AsyncStorage.setItem(CALENDAR_PUSH_ENABLED_KEY, enabled ? '1' : '0');
};

export const getCalendarPushTargetCalendarId = async (): Promise<string | null> => {
    const value = await AsyncStorage.getItem(CALENDAR_TARGET_ID_KEY);
    const trimmed = value?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
};

export const setCalendarPushTargetCalendarId = async (calendarId: string | null): Promise<void> => {
    const trimmed = calendarId?.trim() ?? '';
    if (trimmed.length === 0) {
        await AsyncStorage.removeItem(CALENDAR_TARGET_ID_KEY);
        return;
    }
    await AsyncStorage.setItem(CALENDAR_TARGET_ID_KEY, trimmed);
};

export const getCalendarPushColor = async (): Promise<string> => {
    const value = await AsyncStorage.getItem(CALENDAR_COLOR_KEY);
    return normalizeCalendarColor(value);
};

export const setCalendarPushColor = async (color: string): Promise<string> => {
    const normalized = normalizeCalendarColor(color);
    await AsyncStorage.setItem(CALENDAR_COLOR_KEY, normalized);
    return normalized;
};

// MARK: - Permission

export const requestCalendarWritePermission = async (): Promise<boolean> => {
    try {
        const { status } = await Calendar.requestCalendarPermissionsAsync();
        return status === 'granted';
    } catch {
        return false;
    }
};

export const getCalendarWritePermissionStatus = async (): Promise<'granted' | 'denied' | 'undetermined'> => {
    try {
        const { status } = await Calendar.getCalendarPermissionsAsync();
        if (status === 'granted') return 'granted';
        if (status === 'denied') return 'denied';
        return 'undetermined';
    } catch {
        return 'undetermined';
    }
};

// MARK: - Managed Calendar

const getStoredCalendarId = (): Promise<string | null> =>
    AsyncStorage.getItem(CALENDAR_ID_KEY);

const setStoredCalendarId = (id: string): Promise<void> =>
    AsyncStorage.setItem(CALENDAR_ID_KEY, id);

const READ_ONLY_ACCESS_LEVELS = new Set([
    Calendar.CalendarAccessLevel.FREEBUSY,
    Calendar.CalendarAccessLevel.NONE,
    Calendar.CalendarAccessLevel.READ,
    Calendar.CalendarAccessLevel.RESPOND,
    Calendar.CalendarAccessLevel.UNKNOWN,
]);

function getCalendarDisplayName(calendar: Calendar.Calendar): string {
    const legacyName = (calendar as Calendar.Calendar & { name?: string }).name;
    const preferred = typeof calendar.title === 'string' && calendar.title.trim().length > 0
        ? calendar.title
        : typeof legacyName === 'string' && legacyName.trim().length > 0
            ? legacyName
            : 'Calendar';
    return preferred.trim() || 'Calendar';
}

function isWritableCalendar(calendar: Calendar.Calendar): boolean {
    if (calendar.allowsModifications === false) return false;
    if (calendar.accessLevel && READ_ONLY_ACCESS_LEVELS.has(calendar.accessLevel)) return false;
    return true;
}

function isMindwtrNamedCalendar(calendar: Calendar.Calendar): boolean {
    const title = getCalendarDisplayName(calendar).trim().toLowerCase();
    const name = typeof calendar.name === 'string' ? calendar.name.trim().toLowerCase() : '';
    return title === MANAGED_CALENDAR_TITLE.toLowerCase() || name === MANAGED_CALENDAR_NAME;
}

function isStoredMindwtrManagedCalendar(calendar: Calendar.Calendar, storedCalendarId: string | null): boolean {
    return Boolean(storedCalendarId && calendar.id === storedCalendarId);
}

function isAppCreatedMindwtrCalendar(calendar: Calendar.Calendar): boolean {
    const title = getCalendarDisplayName(calendar).trim().toLowerCase();
    const name = typeof calendar.name === 'string' ? calendar.name.trim().toLowerCase() : '';
    return title === MANAGED_CALENDAR_TITLE.toLowerCase() && name === MANAGED_CALENDAR_NAME;
}

export const getCalendarPushTargetCalendars = async (): Promise<CalendarPushTargetCalendar[]> => {
    try {
        const [storedCalendarId, calendars] = await Promise.all([
            getStoredCalendarId(),
            Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT),
        ]);
        return calendars
            .filter((calendar) =>
                typeof calendar.id === 'string'
                && calendar.id.trim().length > 0
                && isWritableCalendar(calendar)
            )
            .map((calendar) => {
                const isMindwtrDedicated = isMindwtrNamedCalendar(calendar);
                return {
                    id: calendar.id,
                    name: getCalendarDisplayName(calendar),
                    sourceName: getCalendarSourceName(calendar),
                    color: typeof calendar.color === 'string' && calendar.color.trim().length > 0 ? calendar.color : undefined,
                    isMindwtrDedicated,
                    isMindwtrManaged: isStoredMindwtrManagedCalendar(calendar, storedCalendarId),
                    isLocalOnly: isLocalOnlyCalendar(calendar),
                };
            })
            .sort((a, b) => {
                if (a.isMindwtrManaged !== b.isMindwtrManaged) return a.isMindwtrManaged ? -1 : 1;
                if (a.isMindwtrDedicated !== b.isMindwtrDedicated) return a.isMindwtrDedicated ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
    } catch (error) {
        void logError(error, { scope: 'calendar-push', extra: { operation: 'getCalendarPushTargetCalendars' } });
        return [];
    }
};

function getAndroidManagedCalendarSeed(
    calendars: Awaited<ReturnType<typeof Calendar.getCalendarsAsync>>,
    color: string
): Parameters<typeof Calendar.createCalendarAsync>[0] | null {
    const ownedCalendar = calendars.find((calendar) =>
        calendar.accessLevel === Calendar.CalendarAccessLevel.OWNER
        && typeof calendar.ownerAccount === 'string'
        && calendar.ownerAccount.trim().length > 0
        && typeof calendar.source?.name === 'string'
        && calendar.source.name.trim().length > 0
    ) ?? calendars.find((calendar) =>
        calendar.allowsModifications
        && typeof calendar.ownerAccount === 'string'
        && calendar.ownerAccount.trim().length > 0
        && typeof calendar.source?.name === 'string'
        && calendar.source.name.trim().length > 0
    );

    if (!ownedCalendar || !ownedCalendar.source) {
        return null;
    }

    return {
        title: MANAGED_CALENDAR_TITLE,
        color,
        entityType: Calendar.EntityTypes.EVENT,
        name: MANAGED_CALENDAR_NAME,
        ownerAccount: ownedCalendar.ownerAccount,
        accessLevel: Calendar.CalendarAccessLevel.OWNER,
        source: {
            name: ownedCalendar.source.name,
            ...(ownedCalendar.source.type ? { type: ownedCalendar.source.type } : {}),
            ...(typeof ownedCalendar.source.isLocalAccount === 'boolean'
                ? { isLocalAccount: ownedCalendar.source.isLocalAccount }
                : {}),
        },
        isVisible: true,
        isSynced: true,
    };
}

/**
 * Returns the ID of the managed "Mindwtr" calendar, creating it if needed.
 * Returns null if the calendar cannot be created (e.g. no permission, no source).
 */
export const ensureMindwtrCalendar = async (): Promise<string | null> => {
    try {
        const storedId = await getStoredCalendarId();
        const allCalendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
        if (storedId) {
            if (allCalendars.some((c) => c.id === storedId)) return storedId;
            // Calendar was deleted externally — fall through to recreate
        }

        const color = await getCalendarPushColor();
        let calendarDetails: Parameters<typeof Calendar.createCalendarAsync>[0];

        if (Platform.OS === 'android') {
            // Android calendars need to be attached to a real device account/source
            // or some calendar providers will keep them hidden from the OS calendar app.
            const androidSeed = getAndroidManagedCalendarSeed(allCalendars, color);
            if (!androidSeed) {
                void logWarn('No owned Android calendar source available; cannot create Mindwtr calendar', {
                    scope: 'calendar-push',
                    extra: { calendarCount: String(allCalendars.length) },
                });
                return null;
            }
            calendarDetails = androidSeed;
        } else {
            // iOS requires a source
            const sources = await Calendar.getSourcesAsync();
            const source =
                sources.find((s) => s.type === Calendar.SourceType.LOCAL) ??
                sources.find((s) => s.type === Calendar.SourceType.CALDAV) ??
                sources[0];

            if (!source) {
                void logWarn('No calendar source available; cannot create Mindwtr calendar', {
                    scope: 'calendar-push',
                });
                return null;
            }

            calendarDetails = {
                title: MANAGED_CALENDAR_TITLE,
                color,
                entityType: Calendar.EntityTypes.EVENT,
                sourceId: source.id,
                source,
            };
        }

        const newId = await Calendar.createCalendarAsync(calendarDetails);

        await setStoredCalendarId(newId);
        void logInfo('Created Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { calendarId: newId },
        });
        return newId;
    } catch (error) {
        void logError(error, { scope: 'calendar-push', extra: { operation: 'ensureMindwtrCalendar' } });
        return null;
    }
};

export const updateMindwtrCalendarColor = async (color: string): Promise<boolean> => {
    const normalized = await setCalendarPushColor(color);
    try {
        if (typeof Calendar.updateCalendarAsync !== 'function') return false;
        const storedCalendarId = await getStoredCalendarId();
        const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
        const target = calendars.find((calendar) => storedCalendarId && calendar.id === storedCalendarId)
            ?? calendars.find(isAppCreatedMindwtrCalendar);
        if (!target || !isWritableCalendar(target)) return false;

        // Android's CalendarProvider only stores a calendar's color at creation
        // time, and expo-calendar's update path never writes CALENDAR_COLOR, so
        // updating it in place never reaches third-party calendar apps (#726).
        // Recreate the managed calendar with the freshly stored color instead.
        if (Platform.OS === 'android') {
            return await recreateManagedMindwtrCalendar();
        }

        await Calendar.updateCalendarAsync(target.id, { color: normalized });
        return true;
    } catch (error) {
        void logWarn('Failed to update Mindwtr calendar color', {
            scope: 'calendar-push',
            extra: { error: getCalendarErrorMessage(error) },
        });
        return false;
    }
};

/**
 * Deletes and recreates the managed "Mindwtr" calendar so a color change takes
 * effect on Android. The provider ignores post-creation color updates, so the
 * only way to change the color third-party calendar apps render is to drop the
 * calendar and create a fresh one with the already-stored color, then re-push
 * its events. Serialized on the calendar sync queue so it cannot race a
 * concurrent push and duplicate events (#743). Returns true when a new managed
 * calendar was created.
 */
async function recreateManagedMindwtrCalendar(): Promise<boolean> {
    let recreatedId: string | null = null;
    await enqueueCalendarSync(async () => {
        await deleteMindwtrCalendar();
        recreatedId = await ensureMindwtrCalendar();
        if (!recreatedId) return;
        await runFullCalendarSyncUnsafe();
    });
    return recreatedId !== null;
}

async function resolveCalendarPushTarget(): Promise<CalendarPushTarget | null> {
    const selectedId = await getCalendarPushTargetCalendarId();
    if (selectedId) {
        try {
            const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
            const selected = calendars.find((calendar) => calendar.id === selectedId);
            if (selected && isWritableCalendar(selected)) {
                return { id: selectedId };
            }
            await setCalendarPushTargetCalendarId(null);
            void logWarn('Selected calendar push target is unavailable; falling back to Mindwtr calendar', {
                scope: 'calendar-push',
                extra: { calendarId: selectedId },
            });
        } catch (error) {
            void logError(error, { scope: 'calendar-push', extra: { operation: 'resolveCalendarPushTargetId' } });
        }
    }

    const managedId = await ensureMindwtrCalendar();
    return managedId ? { id: managedId } : null;
}

/**
 * Deletes the managed Mindwtr calendar and removes the stored ID.
 * Called when the user disables calendar push sync and chooses to clean up.
 */
export const deleteMindwtrCalendar = async (): Promise<void> => {
    const storedId = await getStoredCalendarId();
    const selectedTargetId = await getCalendarPushTargetCalendarId();
    const calendarIdsToDelete = new Set<string>();
    if (storedId) {
        calendarIdsToDelete.add(storedId);
    }

    try {
        const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
        calendars.forEach((calendar) => {
            if (isAppCreatedMindwtrCalendar(calendar)) {
                calendarIdsToDelete.add(calendar.id);
            }
        });
    } catch (error) {
        void logWarn('Failed to inspect calendars before deleting Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { error: String(error) },
        });
    }

    if (calendarIdsToDelete.size === 0) {
        await AsyncStorage.removeItem(CALENDAR_ID_KEY);
        if (selectedTargetId) {
            const targets = await getCalendarPushTargetCalendars();
            if (!targets.some((target) => target.id === selectedTargetId)) {
                await setCalendarPushTargetCalendarId(null);
            }
        }
        void logInfo('Deleted Mindwtr calendar', {
            scope: 'calendar-push',
            extra: { deletedCalendars: '0' },
        });
        return;
    }

    try {
        await Promise.allSettled(
            Array.from(calendarIdsToDelete).map((calendarId) => Calendar.deleteCalendarAsync(calendarId))
        );
    } catch {
        // Already deleted or not found — ignore
    }

    await AsyncStorage.removeItem(CALENDAR_ID_KEY);
    if (selectedTargetId && calendarIdsToDelete.has(selectedTargetId)) {
        await setCalendarPushTargetCalendarId(null);
    }

    try {
        const syncedEntries = await getAllCalendarSyncEntries(PLATFORM);
        const deletedEntries = syncedEntries.filter((entry) => calendarIdsToDelete.has(entry.calendarId));
        await Promise.allSettled(
            deletedEntries.map((entry) => deleteCalendarSyncEntry(entry.taskId, PLATFORM))
        );
    } catch (error) {
        void logWarn('Failed to clear deleted Mindwtr calendar sync entries', {
            scope: 'calendar-push',
            extra: { error: String(error) },
        });
    }

    void logInfo('Deleted Mindwtr calendar', {
        scope: 'calendar-push',
        extra: { deletedCalendars: String(calendarIdsToDelete.size) },
    });
};

// MARK: - Per-task sync

function formatProjectedRecurrenceEventDate(task: Task): string {
    return safeFormatDate(getTaskCalendarOccurrenceDate(task), PROJECTED_RECURRENCE_EVENT_DATE_FORMAT);
}

function formatCalendarEventTitle(title: string, occurrenceDateLabel = ''): string {
    const trimmed = title.trim() || 'Task';
    return occurrenceDateLabel ? `${trimmed} (${occurrenceDateLabel})` : trimmed;
}

function formatProjectedRecurrenceNote(task: Task): string {
    const occurrenceDateLabel = formatProjectedRecurrenceEventDate(task);
    return occurrenceDateLabel
        ? `Projected recurring occurrence for ${occurrenceDateLabel}. Complete the current Mindwtr task to create the real next task.`
        : 'Projected recurring occurrence. Complete the current Mindwtr task to create the real next task.';
}

function buildEventDetails(task: Task) {
    // safeParseDate parses YYYY-MM-DD as local midnight, avoiding the UTC
    // shift that `new Date(dateString)` produces for date-only strings.
    const dateValue = task.startTime ?? task.dueDate;
    const parsed = safeParseDate(dateValue);
    const startDate = parsed ?? new Date();
    const projectedOccurrenceDateLabel = isProjectedRecurringTask(task)
        ? formatProjectedRecurrenceEventDate(task)
        : '';
    const title = formatCalendarEventTitle(task.title, projectedOccurrenceDateLabel);
    const location = typeof task.location === 'string' ? task.location.trim() : '';
    const { projects, sections } = useTaskStore.getState();
    const projectName = task.projectId
        ? projects.find((project) => project.id === task.projectId)?.title
        : undefined;
    const sectionName = task.sectionId
        ? sections.find((section) => section.id === task.sectionId)?.title
        : undefined;
    const leadingNote = isProjectedRecurringTask(task) ? formatProjectedRecurrenceNote(task) : undefined;
    const { notes, url } = buildCalendarPushEventFields(task, { projectName, sectionName, leadingNote });

    if (hasTimeComponent(dateValue)) {
        const endDate = new Date(startDate.getTime() + timeEstimateToMinutes(task.timeEstimate) * 60 * 1000);
        return {
            title,
            startDate,
            endDate,
            allDay: false,
            notes,
            location,
            ...(url ? { url } : {}),
        };
    }

    const startDateOnly = buildAllDayBoundary(startDate);
    const endDate = buildAllDayBoundary(startDate, 1);
    return {
        title,
        startDate: startDateOnly,
        endDate,
        allDay: true,
        notes,
        location,
        ...(url ? { url } : {}),
        ...(Platform.OS === 'android' ? { timeZone: 'UTC', endTimeZone: 'UTC' } : {}),
    };
}

function buildAllDayBoundary(date: Date, dayOffset = 0): Date {
    if (Platform.OS === 'android') {
        return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset));
    }
    const boundary = new Date(date);
    boundary.setHours(0, 0, 0, 0);
    boundary.setDate(boundary.getDate() + dayOffset);
    return boundary;
}

function getCalendarErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const value = error as { code?: unknown; message?: unknown; name?: unknown };
        return [value.name, value.code, value.message]
            .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
            .join(' ');
    }
    return String(error);
}

function isCalendarEventMissingError(error: unknown): boolean {
    const message = getCalendarErrorMessage(error).toLowerCase();
    return message.includes('event-not-found')
        || message.includes('calendar event not found')
        || message.includes('event not found')
        || message.includes('event does not exist')
        || message.includes('event already deleted')
        || (message.includes('event') && message.includes('not found'));
}

async function deleteCalendarEventAndMapping(entry: { taskId: string; calendarEventId: string }): Promise<void> {
    try {
        await Calendar.deleteEventAsync(entry.calendarEventId);
    } catch (error) {
        if (!isCalendarEventMissingError(error)) {
            void logWarn('Failed to delete calendar event; keeping local sync mapping for retry', {
                scope: 'calendar-push',
                extra: {
                    taskId: entry.taskId,
                    eventId: entry.calendarEventId,
                    error: getCalendarErrorMessage(error),
                },
            });
            throw error;
        }
    }
    await deleteCalendarSyncEntry(entry.taskId, PLATFORM);
}

async function removeTaskFromCalendar(taskId: string): Promise<void> {
    const entry = await getCalendarSyncEntry(taskId, PLATFORM);
    if (!entry) return;
    await deleteCalendarEventAndMapping(entry);
}

/** Returns true for tasks that should not have a calendar event. */
function shouldRemoveFromCalendar(task: Task): boolean {
    return (!task.dueDate && !task.startTime)
        || !!task.deletedAt
        || task.status === 'done'
        || task.status === 'archived'
        || task.status === 'reference';
}

async function syncTaskToCalendar(task: Task, target: CalendarPushTarget): Promise<void> {
    if (shouldRemoveFromCalendar(task)) {
        await removeTaskFromCalendar(task.id);
        return;
    }

    const details = buildEventDetails(task);
    const calendarId = target.id;
    const existing = await getCalendarSyncEntry(task.id, PLATFORM);

    if (existing && existing.calendarId === calendarId) {
        try {
            await Calendar.updateEventAsync(existing.calendarEventId, details);
            await upsertCalendarSyncEntry({
                taskId: task.id,
                calendarEventId: existing.calendarEventId,
                calendarId,
                platform: PLATFORM,
                lastSyncedAt: new Date().toISOString(),
            });
            return;
        } catch (error) {
            if (!isCalendarEventMissingError(error)) {
                void logWarn('Failed to update calendar event; keeping local sync mapping for retry', {
                    scope: 'calendar-push',
                    extra: {
                        taskId: task.id,
                        eventId: existing.calendarEventId,
                        error: getCalendarErrorMessage(error),
                    },
                });
                throw error;
            }
            await deleteCalendarSyncEntry(task.id, PLATFORM);
        }
    } else if (existing) {
        await deleteCalendarEventAndMapping(existing);
    }

    const eventId = await Calendar.createEventAsync(calendarId, { ...details, calendarId });
    await upsertCalendarSyncEntry({
        taskId: task.id,
        calendarEventId: eventId,
        calendarId,
        platform: PLATFORM,
        lastSyncedAt: new Date().toISOString(),
    });
}

function getCalendarPushTasks(tasks: Task[]): Task[] {
    const projectedAtIso = new Date().toISOString();
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

// MARK: - Full sync

// Serialize all calendar writes so a full sync and the debounced partial sync
// (or two rapid manual refreshes) cannot race on the check-then-create path and
// create duplicate events (#743).
let calendarSyncQueue: Promise<void> = Promise.resolve();
function enqueueCalendarSync(run: () => Promise<void>): Promise<void> {
    const next = calendarSyncQueue.catch(() => undefined).then(run);
    calendarSyncQueue = next.catch(() => undefined);
    return next;
}

export const runFullCalendarSync = (): Promise<void> => enqueueCalendarSync(runFullCalendarSyncUnsafe);

const runFullCalendarSyncUnsafe = async (): Promise<void> => {
    const enabled = await getCalendarPushEnabled();
    if (!enabled) return;

    const target = await resolveCalendarPushTarget();
    if (!target) return;

    const { _allTasks } = useTaskStore.getState();
    const calendarTasks = getCalendarPushTasks(_allTasks as Task[]);

    // Sync all tasks currently in the store
    const results = await runLimitedSettled(calendarTasks, (task) => syncTaskToCalendar(task, target));

    // Reconcile: remove stale calendar_sync entries for tasks that are no
    // longer in the store or that should not have an event (completed between
    // sessions, archived, etc.)
    const activeEventIds = new Set(
        calendarTasks.filter((task) => !shouldRemoveFromCalendar(task)).map((task) => task.id)
    );
    const syncedEntries = await getAllCalendarSyncEntries(PLATFORM);
    const staleEntries = syncedEntries.filter((e) => !activeEventIds.has(e.taskId));
    await runLimitedSettled(staleEntries, (entry) => removeTaskFromCalendar(entry.taskId));

    const failed = results.filter((r) => r.status === 'rejected').length;
    void logInfo('Full calendar sync complete', {
        scope: 'calendar-push',
        extra: {
            total: String(calendarTasks.length),
            failed: String(failed),
            stale: String(staleEntries.length),
        },
    });
};

// MARK: - Debounced partial sync

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSyncTaskIds = new Set<string>();

export const scheduleSyncDebounced = (taskIds: string[]): void => {
    taskIds.forEach((id) => pendingSyncTaskIds.add(id));
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        const idsToSync = Array.from(pendingSyncTaskIds);
        pendingSyncTaskIds.clear();
        void runPartialCalendarSync(idsToSync);
    }, SYNC_DEBOUNCE_MS);
};

const runPartialCalendarSync = (taskIds: string[]): Promise<void> =>
    enqueueCalendarSync(() => runPartialCalendarSyncUnsafe(taskIds));

const runPartialCalendarSyncUnsafe = async (taskIds: string[]): Promise<void> => {
    const enabled = await getCalendarPushEnabled();
    if (!enabled) return;

    const target = await resolveCalendarPushTarget();
    if (!target) return;

    const { _tasksById } = useTaskStore.getState();
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
        ...targets.map((t) => syncTaskToCalendar(t, target)),
        ...removedIds.map((id) => removeTaskFromCalendar(id)),
    ]);
};

// MARK: - Store subscription

let unsubscribeStore: (() => void) | null = null;

const buildCalendarSyncTaskMap = (tasks: Task[]) => new Map(tasks.map((task) => [task.id, task]));

/**
 * Starts watching the task store for changes and syncing due-date tasks to
 * the device calendar. Returns an unsubscribe function.
 */
export const startCalendarPushSync = (): (() => void) => {
    if (unsubscribeStore) return unsubscribeStore;

    let previousTaskMap = buildCalendarSyncTaskMap(useTaskStore.getState()._allTasks);

    unsubscribeStore = useTaskStore.subscribe(
        (state) => state._allTasks,
        (currentTasks) => {
            const changedIds: string[] = [];
            const currentMap = buildCalendarSyncTaskMap(currentTasks);

            // Changed or new tasks
            for (const task of currentTasks) {
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
                    prev.suppressMindwtrReminders !== task.suppressMindwtrReminders ||
                    prev.recurrence !== task.recurrence ||
                    prev.showFutureRecurrence !== task.showFutureRecurrence
                ) {
                    changedIds.push(task.id);
                }
            }

            // Tasks removed from store entirely
            for (const id of previousTaskMap.keys()) {
                if (!currentMap.has(id)) {
                    changedIds.push(id);
                }
            }

            previousTaskMap = currentMap;

            if (changedIds.length > 0) {
                scheduleSyncDebounced(changedIds);
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

export const stopCalendarPushSync = (): void => {
    unsubscribeStore?.();
    unsubscribeStore = null;
    if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
    }
    pendingSyncTaskIds.clear();
};
