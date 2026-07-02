import {
    type AppData,
    flushPendingSave,
    getInMemoryAppDataSnapshot,
    mergeAppData,
    normalizeAppData,
    useTaskStore,
} from '@mindwtr/core';
import { invoke } from '@tauri-apps/api/core';
import { getDesktopTimerHost, isTauriRuntime } from './runtime';
import { hashString, toStableJson } from './sync-service-utils';
import { logInfo, logWarn } from './app-log';

const IGNORE_WINDOW_MS = 2000;
const DEBOUNCE_MS = 750;
const IGNORE_DRAIN_PADDING_MS = 25;
const SQLITE_NOOP_REFRESH_IGNORE_MS = 2000;
const SQLITE_SELF_WRITE_RETENTION_MS = 15_000;
const SELF_WRITE_RETENTION_MS = 10_000;
const MAX_PENDING_SELF_WRITES = 8;
const timerHost = getDesktopTimerHost();

type FsEvent = {
    path?: string;
    paths?: string[];
};

type PendingExternalData = {
    data: AppData;
    hash: string;
};

type LocalDataWatcherDependencies = {
    readDataJson: () => Promise<AppData>;
    refreshStorageData: () => Promise<void>;
    watchFile: (path: string, callback: (event: FsEvent) => void) => Promise<unknown>;
    now: () => number;
    schedule: typeof setTimeout;
    cancelSchedule: typeof clearTimeout;
    hashPayload: (payload: string) => Promise<string>;
    normalize: (data: AppData) => AppData;
    merge: (local: AppData, incoming: AppData) => AppData;
    getSnapshot: () => AppData;
    persistMergedData: (merged: AppData) => Promise<void>;
    logInfo: (message: string, extra?: Record<string, unknown>) => void;
    logWarn: (message: string, extra?: Record<string, unknown>) => void;
};

const persistMergedDataThroughStore = async (merged: AppData): Promise<void> => {
    const allTasks = Array.isArray(merged.tasks) ? merged.tasks : [];
    const allProjects = Array.isArray(merged.projects) ? merged.projects : [];
    const allSections = Array.isArray(merged.sections) ? merged.sections : [];
    const allAreas = Array.isArray(merged.areas) ? merged.areas : [];
    const allPeople = Array.isArray(merged.people) ? merged.people : [];

    useTaskStore.setState((state) => ({
        _allTasks: allTasks,
        _allProjects: allProjects,
        _allSections: allSections,
        _allAreas: allAreas,
        people: allPeople.filter((person) => !person.deletedAt),
        _allPeople: allPeople,
        _peopleById: new Map(allPeople.map((person) => [person.id, person] as const)),
        settings: merged.settings ?? state.settings,
        lastDataChangeAt: Date.now(),
    }));

    await useTaskStore.getState().persistSnapshot();
    await flushPendingSave();
};

const defaultDependencies: LocalDataWatcherDependencies = {
    readDataJson: () => invoke<AppData>('read_data_json' as any),
    refreshStorageData: async () => {
        await useTaskStore.getState().fetchData({ silent: true });
    },
    watchFile: async (path, callback) => {
        const { watch } = await import('@tauri-apps/plugin-fs');
        return watch(path, callback);
    },
    now: () => Date.now(),
    schedule: timerHost.setTimeout,
    cancelSchedule: timerHost.clearTimeout,
    hashPayload: hashString,
    normalize: normalizeAppData,
    merge: mergeAppData,
    getSnapshot: getInMemoryAppDataSnapshot,
    persistMergedData: persistMergedDataThroughStore,
    logInfo: (message, extra) => {
        void logInfo(message, extra ? { extra } : undefined);
    },
    logWarn: (message, extra) => {
        void logWarn(message, extra ? { extra } : undefined);
    },
};

let localDataWatcherDependencies: LocalDataWatcherDependencies = { ...defaultDependencies };
let unwatchFns: Array<() => void> = [];
let ignoreUntil = 0;
let sqliteIgnoreUntil = 0;
let sqliteSelfWriteUntil = 0;
let lastSqliteSelfWriteAt = 0;
let sqliteSuppressedSelfWriteEvents = 0;
let lastKnownHash = '';
let pendingSelfWrites: Array<{ payload: string; expiresAt: number }> = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let sqliteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let ignoreDrainTimer: ReturnType<typeof setTimeout> | null = null;
let hasPendingChangeDuringIgnore = false;
let pendingExternalData: PendingExternalData | null = null;
let mergeInFlight: Promise<void> | null = null;
let sqliteRefreshInFlight: Promise<void> | null = null;

const normalizePathsFromEvent = (event: FsEvent): string[] => {
    if (Array.isArray(event?.paths)) return event.paths;
    if (typeof event?.path === 'string' && event.path.length > 0) return [event.path];
    return [];
};

const getPathBasename = (path: string): string => {
    const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
};

const getParentPath = (path: string): string | null => {
    const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (separatorIndex <= 0) return null;
    return path.slice(0, separatorIndex);
};

const formatPathsForTrace = (paths: string[]): string =>
    paths.map(getPathBasename).slice(0, 8).join(',');

const remainingMs = (until: number, now: number): string =>
    String(Math.max(0, Math.ceil(until - now)));

const buildSqliteWatcherTraceExtra = (
    paths: string[] = [],
    extra: Record<string, unknown> = {},
): Record<string, unknown> => {
    const now = localDataWatcherDependencies.now();
    return {
        ...extra,
        basenames: formatPathsForTrace(paths),
        pathCount: String(paths.length),
        nowMs: String(now),
        ignoreRemainingMs: remainingMs(sqliteIgnoreUntil, now),
        selfWriteRemainingMs: remainingMs(sqliteSelfWriteUntil, now),
        sinceSelfWriteMs: lastSqliteSelfWriteAt > 0 ? String(now - lastSqliteSelfWriteAt) : '',
        refreshInFlight: String(Boolean(sqliteRefreshInFlight)),
        debounceActive: String(Boolean(sqliteDebounceTimer)),
        suppressedSelfWriteEvents: String(sqliteSuppressedSelfWriteEvents),
    };
};

type SnapshotTraceSummary = {
    dataSig: string;
    tasksSig: string;
    projectsSig: string;
    sectionsSig: string;
    areasSig: string;
    peopleSig: string;
    settingsSig: string;
    taskCount: string;
    projectCount: string;
    sectionCount: string;
    areaCount: string;
    peopleCount: string;
};

const buildSnapshotTraceSummary = async (data: AppData): Promise<SnapshotTraceSummary> => {
    const normalized = stripSqliteRefreshBookkeeping(localDataWatcherDependencies.normalize(data));
    const tasks = Array.isArray(normalized.tasks) ? normalized.tasks : [];
    const projects = Array.isArray(normalized.projects) ? normalized.projects : [];
    const sections = Array.isArray(normalized.sections) ? normalized.sections : [];
    const areas = Array.isArray(normalized.areas) ? normalized.areas : [];
    const people = Array.isArray(normalized.people) ? normalized.people ?? [] : [];
    const settings = normalized.settings ?? {};
    const [dataSig, tasksSig, projectsSig, sectionsSig, areasSig, peopleSig, settingsSig] = await Promise.all([
        localDataWatcherDependencies.hashPayload(toStableJson(normalized)),
        localDataWatcherDependencies.hashPayload(toStableJson(tasks)),
        localDataWatcherDependencies.hashPayload(toStableJson(projects)),
        localDataWatcherDependencies.hashPayload(toStableJson(sections)),
        localDataWatcherDependencies.hashPayload(toStableJson(areas)),
        localDataWatcherDependencies.hashPayload(toStableJson(people)),
        localDataWatcherDependencies.hashPayload(toStableJson(settings)),
    ]);

    return {
        dataSig,
        tasksSig,
        projectsSig,
        sectionsSig,
        areasSig,
        peopleSig,
        settingsSig,
        taskCount: String(tasks.length),
        projectCount: String(projects.length),
        sectionCount: String(sections.length),
        areaCount: String(areas.length),
        peopleCount: String(people.length),
    };
};

const prefixSnapshotTraceSummary = (
    prefix: string,
    summary: SnapshotTraceSummary,
): Record<string, string> => Object.fromEntries(
    Object.entries(summary).map(([name, value]) => [
        `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
        value,
    ]),
);

const buildSnapshotChangeTraceExtra = (
    before: SnapshotTraceSummary,
    after: SnapshotTraceSummary,
): Record<string, string> => ({
    dataChanged: String(before.dataSig !== after.dataSig),
    tasksChanged: String(before.tasksSig !== after.tasksSig),
    projectsChanged: String(before.projectsSig !== after.projectsSig),
    sectionsChanged: String(before.sectionsSig !== after.sectionsSig),
    areasChanged: String(before.areasSig !== after.areasSig),
    peopleChanged: String(before.peopleSig !== after.peopleSig),
    settingsChanged: String(before.settingsSig !== after.settingsSig),
    ...prefixSnapshotTraceSummary('before', before),
    ...prefixSnapshotTraceSummary('after', after),
});

/** Filter out iCloud placeholder events (.icloud files, lock files). */
const isRelevantSyncEvent = (paths: string[]): boolean => {
    return paths.some((p) => {
        const name = p.split('/').pop() ?? '';
        // Ignore iCloud placeholder stubs (.filename.icloud)
        if (name.endsWith('.icloud')) return false;
        // Ignore our own advisory lock file
        if (name === '.mindwtr.lock') return false;
        // Ignore temp files from atomic writes
        if (name.endsWith('.tmp')) return false;
        return true;
    });
};

const isRelevantSqliteEvent = (paths: string[], dbPath: string): boolean => {
    const dbName = getPathBasename(dbPath);
    // WAL carries committed writes. The shared-memory file can move during
    // read/lock activity, so watching it makes fetchData feed itself.
    const sqliteNames = new Set([dbName, `${dbName}-wal`]);
    return paths.some((path) => sqliteNames.has(getPathBasename(path)));
};

const resolveUnwatch = (unwatch: unknown): (() => void) | null => {
    if (typeof unwatch === 'function') return unwatch as () => void;
    if (unwatch && typeof (unwatch as any).stop === 'function') {
        return () => (unwatch as any).stop();
    }
    if (unwatch && typeof (unwatch as any).unwatch === 'function') {
        return () => (unwatch as any).unwatch();
    }
    return null;
};

const pruneExpiredSelfWrites = (now: number) => {
    pendingSelfWrites = pendingSelfWrites.filter((entry) => entry.expiresAt > now);
};

const scheduleIgnoreDrain = () => {
    if (!hasPendingChangeDuringIgnore) return;
    if (ignoreDrainTimer) {
        localDataWatcherDependencies.cancelSchedule(ignoreDrainTimer);
        ignoreDrainTimer = null;
    }
    const remainingMs = Math.max(0, ignoreUntil - localDataWatcherDependencies.now());
    ignoreDrainTimer = localDataWatcherDependencies.schedule(() => {
        ignoreDrainTimer = null;
        if (!hasPendingChangeDuringIgnore) return;
        hasPendingChangeDuringIgnore = false;
        void handleExternalChange();
    }, remainingMs + IGNORE_DRAIN_PADDING_MS);
};

const runPendingMerge = () => {
    if (mergeInFlight) return;

    mergeInFlight = (async () => {
        while (pendingExternalData) {
            const externalData = pendingExternalData;
            pendingExternalData = null;
            await mergeExternalData(externalData);
        }
    })().finally(() => {
        mergeInFlight = null;
        if (pendingExternalData) {
            runPendingMerge();
        }
    });
};

const stripSqliteRefreshBookkeeping = (data: AppData): AppData => {
    const {
        network,
        lastSyncAt,
        lastSyncStatus,
        lastSyncError,
        pendingRemoteWriteAt,
        pendingRemoteWriteRetryAt,
        pendingRemoteWriteAttempts,
        lastSyncStats,
        lastSyncHistory,
        ...settings
    } = data.settings ?? {};

    void network;
    void lastSyncAt;
    void lastSyncStatus;
    void lastSyncError;
    void pendingRemoteWriteAt;
    void pendingRemoteWriteRetryAt;
    void pendingRemoteWriteAttempts;
    void lastSyncStats;
    void lastSyncHistory;

    return {
        ...data,
        settings,
    };
};

const extendSqliteIgnoreWindow = (windowMs: number = IGNORE_WINDOW_MS): void => {
    sqliteIgnoreUntil = Math.max(sqliteIgnoreUntil, localDataWatcherDependencies.now() + windowMs);
};

const markSqliteSelfWriteWindow = (): void => {
    const now = localDataWatcherDependencies.now();
    extendSqliteIgnoreWindow();
    sqliteSelfWriteUntil = Math.max(sqliteSelfWriteUntil, now + SQLITE_SELF_WRITE_RETENTION_MS);
    lastSqliteSelfWriteAt = now;
    localDataWatcherDependencies.logInfo(
        '[local-data-watcher] Marked SQLite self-write',
        buildSqliteWatcherTraceExtra([], {
            retentionMs: String(SQLITE_SELF_WRITE_RETENTION_MS),
        }),
    );
};

async function mergeExternalData(externalData: PendingExternalData): Promise<void> {
    try {
        await flushPendingSave();

        const localSnapshot = localDataWatcherDependencies.getSnapshot();
        const normalizedLocal = localDataWatcherDependencies.normalize(localSnapshot);
        const localPayload = toStableJson(normalizedLocal);
        const localHash = await localDataWatcherDependencies.hashPayload(localPayload);

        if (localHash === externalData.hash) {
            lastKnownHash = externalData.hash;
            return;
        }

        const merged = localDataWatcherDependencies.merge(normalizedLocal, externalData.data);
        const normalizedMerged = localDataWatcherDependencies.normalize(merged);
        const mergedPayload = toStableJson(normalizedMerged);
        const mergedHash = await localDataWatcherDependencies.hashPayload(mergedPayload);

        if (mergedHash === localHash) {
            lastKnownHash = mergedHash;
            return;
        }

        await localDataWatcherDependencies.persistMergedData(normalizedMerged);
        lastKnownHash = mergedHash;
        localDataWatcherDependencies.logInfo('[local-data-watcher] Merged external data.json changes');
    } catch (error) {
        localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to merge external data: ' + String(error));
    }
}

const runSqliteRefresh = (): Promise<void> => {
    if (sqliteRefreshInFlight) return sqliteRefreshInFlight;

    sqliteRefreshInFlight = (async () => {
        try {
            await flushPendingSave();
            const beforeSummary = await buildSnapshotTraceSummary(localDataWatcherDependencies.getSnapshot());
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite refresh start',
                prefixSnapshotTraceSummary('before', beforeSummary),
            );
            await localDataWatcherDependencies.refreshStorageData();
            const afterSummary = await buildSnapshotTraceSummary(localDataWatcherDependencies.getSnapshot());
            const changeExtra = buildSnapshotChangeTraceExtra(beforeSummary, afterSummary);
            if (beforeSummary.dataSig === afterSummary.dataSig) {
                extendSqliteIgnoreWindow(SQLITE_NOOP_REFRESH_IGNORE_MS);
                localDataWatcherDependencies.logInfo(
                    '[local-data-watcher] SQLite refresh no data changes',
                    changeExtra,
                );
                return;
            }
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite refresh changed snapshot',
                changeExtra,
            );
            localDataWatcherDependencies.logInfo('[local-data-watcher] Refreshed after SQLite change');
        } catch (error) {
            localDataWatcherDependencies.logWarn(
                '[local-data-watcher] Failed to refresh SQLite change: ' + String(error),
                { error: String(error) },
            );
        }
    })().finally(() => {
        sqliteRefreshInFlight = null;
    });

    return sqliteRefreshInFlight;
};

async function handleSqliteChange(options: { immediate?: boolean; paths?: string[] } = {}): Promise<void> {
    const paths = options.paths ?? [];
    const now = localDataWatcherDependencies.now();

    if (!options.immediate) {
        localDataWatcherDependencies.logInfo(
            '[local-data-watcher] SQLite event received',
            buildSqliteWatcherTraceExtra(paths),
        );

        if (now < sqliteIgnoreUntil) {
            if (now < sqliteSelfWriteUntil) {
                sqliteSuppressedSelfWriteEvents += 1;
            }
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite event ignored inside write window',
                buildSqliteWatcherTraceExtra(paths),
            );
            return;
        }

        if (now < sqliteSelfWriteUntil) {
            sqliteSuppressedSelfWriteEvents += 1;
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite event suppressed as delayed self-write',
                buildSqliteWatcherTraceExtra(paths),
            );
            return;
        }
    }

    if (sqliteDebounceTimer) {
        localDataWatcherDependencies.cancelSchedule(sqliteDebounceTimer);
        sqliteDebounceTimer = null;
    }

    if (options.immediate) {
        localDataWatcherDependencies.logInfo(
            '[local-data-watcher] SQLite refresh requested immediately',
            buildSqliteWatcherTraceExtra(paths),
        );
        await runSqliteRefresh();
        return;
    }

    const scheduledDuringRefresh = sqliteRefreshInFlight !== null;
    sqliteDebounceTimer = localDataWatcherDependencies.schedule(() => {
        sqliteDebounceTimer = null;
        if (scheduledDuringRefresh && localDataWatcherDependencies.now() < sqliteIgnoreUntil) {
            localDataWatcherDependencies.logInfo(
                '[local-data-watcher] SQLite scheduled refresh skipped after no-op window',
                buildSqliteWatcherTraceExtra(paths, { scheduledDuringRefresh: String(scheduledDuringRefresh) }),
            );
            return;
        }
        void runSqliteRefresh();
    }, DEBOUNCE_MS);
    localDataWatcherDependencies.logInfo(
        '[local-data-watcher] SQLite event scheduled refresh',
        buildSqliteWatcherTraceExtra(paths, { scheduledDuringRefresh: String(scheduledDuringRefresh) }),
    );
}

async function handleExternalChange(options: { immediate?: boolean; ignoreSelfWindow?: boolean } = {}): Promise<void> {
    const now = localDataWatcherDependencies.now();
    pruneExpiredSelfWrites(now);

    if (!options.ignoreSelfWindow && now < ignoreUntil) {
        hasPendingChangeDuringIgnore = true;
        scheduleIgnoreDrain();
        return;
    }

    try {
        const rawData = await localDataWatcherDependencies.readDataJson();
        const normalized = localDataWatcherDependencies.normalize(rawData);
        const payload = toStableJson(normalized);

        const matchedSelfWriteIndex = pendingSelfWrites.findIndex((entry) => entry.payload === payload);
        if (matchedSelfWriteIndex >= 0) {
            lastKnownHash = await localDataWatcherDependencies.hashPayload(payload);
            pendingSelfWrites.splice(matchedSelfWriteIndex, 1);
            return;
        }

        const hash = await localDataWatcherDependencies.hashPayload(payload);

        if (hash === lastKnownHash) {
            if (options.immediate && pendingExternalData?.hash === hash) {
                if (debounceTimer) {
                    localDataWatcherDependencies.cancelSchedule(debounceTimer);
                    debounceTimer = null;
                }
                const externalData = pendingExternalData;
                pendingExternalData = null;
                await mergeExternalData(externalData);
            }
            return;
        }
        lastKnownHash = hash;

        if (options.immediate) {
            if (debounceTimer) {
                localDataWatcherDependencies.cancelSchedule(debounceTimer);
                debounceTimer = null;
            }
            pendingExternalData = null;
            await mergeExternalData({ data: normalized, hash });
            return;
        }

        if (debounceTimer) {
            localDataWatcherDependencies.cancelSchedule(debounceTimer);
            debounceTimer = null;
        }

        pendingExternalData = { data: normalized, hash };
        debounceTimer = localDataWatcherDependencies.schedule(() => {
            debounceTimer = null;
            runPendingMerge();
        }, DEBOUNCE_MS);
    } catch (error) {
        localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to read external change: ' + String(error));
    }
}

export async function refreshFromDiskNow(): Promise<void> {
    await handleExternalChange({ immediate: true, ignoreSelfWindow: true });
}

export function markLocalWrite(data?: AppData): void {
    const now = localDataWatcherDependencies.now();
    pruneExpiredSelfWrites(now);

    if (data) {
        try {
            const normalized = localDataWatcherDependencies.normalize(data);
            const payload = toStableJson(normalized);
            pendingSelfWrites = pendingSelfWrites.filter((entry) => entry.payload !== payload);
            pendingSelfWrites.push({
                payload,
                expiresAt: now + SELF_WRITE_RETENTION_MS,
            });
            if (pendingSelfWrites.length > MAX_PENDING_SELF_WRITES) {
                pendingSelfWrites = pendingSelfWrites.slice(-MAX_PENDING_SELF_WRITES);
            }
        } catch {
            pendingSelfWrites = [];
        }
    } else {
        pendingSelfWrites = [];
    }
    ignoreUntil = now + IGNORE_WINDOW_MS;
    scheduleIgnoreDrain();
}

export function markLocalSqliteWrite(): void {
    markSqliteSelfWriteWindow();
}

export async function start(dataPath: string, dbPath?: string): Promise<void> {
    if (!isTauriRuntime()) return;
    if (unwatchFns.length > 0) return;

    try {
        const unwatch = await localDataWatcherDependencies.watchFile(dataPath, (event) => {
            const paths = normalizePathsFromEvent(event);
            if (paths.length === 0) return;
            // Skip iCloud placeholder events, lock files, and temp files to
            // avoid spurious merges from iCloud Drive housekeeping operations.
            if (!isRelevantSyncEvent(paths)) return;
            void handleExternalChange();
        });

        const resolvedUnwatch = resolveUnwatch(unwatch);
        if (resolvedUnwatch) unwatchFns.push(resolvedUnwatch);
        localDataWatcherDependencies.logInfo('[local-data-watcher] Started watching ' + dataPath);
    } catch (error) {
        localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to start watcher: ' + String(error));
    }

    if (dbPath) {
        const dbWatchPath = getParentPath(dbPath) ?? dbPath;
        try {
            const unwatch = await localDataWatcherDependencies.watchFile(dbWatchPath, (event) => {
                const paths = normalizePathsFromEvent(event);
                if (paths.length === 0) return;
                if (!isRelevantSqliteEvent(paths, dbPath)) return;
                void handleSqliteChange({ paths });
            });

            const resolvedUnwatch = resolveUnwatch(unwatch);
            if (resolvedUnwatch) unwatchFns.push(resolvedUnwatch);
            localDataWatcherDependencies.logInfo('[local-data-watcher] Started watching SQLite directory ' + dbWatchPath);
        } catch (error) {
            localDataWatcherDependencies.logWarn('[local-data-watcher] Failed to start SQLite watcher: ' + String(error));
        }
    }
}

export function stop(): void {
    if (debounceTimer) {
        localDataWatcherDependencies.cancelSchedule(debounceTimer);
        debounceTimer = null;
    }
    if (sqliteDebounceTimer) {
        localDataWatcherDependencies.cancelSchedule(sqliteDebounceTimer);
        sqliteDebounceTimer = null;
    }
    if (ignoreDrainTimer) {
        localDataWatcherDependencies.cancelSchedule(ignoreDrainTimer);
        ignoreDrainTimer = null;
    }
    hasPendingChangeDuringIgnore = false;
    pendingExternalData = null;
    pendingSelfWrites = [];
    sqliteIgnoreUntil = 0;
    sqliteSelfWriteUntil = 0;
    lastSqliteSelfWriteAt = 0;
    sqliteSuppressedSelfWriteEvents = 0;

    if (unwatchFns.length > 0) {
        unwatchFns.forEach((unwatch) => unwatch());
        unwatchFns = [];
        localDataWatcherDependencies.logInfo('[local-data-watcher] Stopped');
    }
}

export const __localDataWatcherTestUtils = {
    setDependenciesForTests(overrides: Partial<LocalDataWatcherDependencies>) {
        localDataWatcherDependencies = {
            ...localDataWatcherDependencies,
            ...overrides,
        };
    },
    async triggerChangeForTests() {
        await handleExternalChange();
    },
    async refreshFromDiskNowForTests() {
        await refreshFromDiskNow();
    },
    resetForTests() {
        stop();
        localDataWatcherDependencies = { ...defaultDependencies };
        ignoreUntil = 0;
        sqliteIgnoreUntil = 0;
        sqliteSelfWriteUntil = 0;
        lastSqliteSelfWriteAt = 0;
        sqliteSuppressedSelfWriteEvents = 0;
        lastKnownHash = '';
        pendingSelfWrites = [];
        mergeInFlight = null;
        sqliteRefreshInFlight = null;
    },
    getPendingSelfWritePayloadLengthForTests() {
        return pendingSelfWrites.reduce((total, entry) => total + entry.payload.length, 0);
    },
};
