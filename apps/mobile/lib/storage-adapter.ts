import { AppData, SqliteAdapter, searchAll, type SqliteClient, type CalendarSyncEntry, StorageAdapter, type Task } from '@mindwtr/core';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { WIDGET_DATA_KEY } from './widget-data';
import { updateMobileWidgetFromData } from './widget-service';
import { logError, logInfo, logWarn } from './app-log';
import { markStartupPhase, measureStartupPhase } from './startup-profiler';

const DATA_KEY = WIDGET_DATA_KEY;
const STARTUP_BACKUP_VERSION_KEY = `${DATA_KEY}:startup-backup-version`;
const STARTUP_BACKUP_UPDATED_AT_KEY = `${DATA_KEY}:startup-backup-updated-at`;
const STARTUP_BACKUP_VERSION = '2';
const LEGACY_DATA_KEYS = ['focus-gtd-data', 'gtd-todo-data', 'gtd-data'];
const EMPTY_APP_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
const SQLITE_STARTUP_TIMEOUT_MS = 3_500;
const SQLITE_QUERY_TIMEOUT_MS = 2_500;
const SQLITE_RETRY_COOLDOWN_MS = 60_000;
// Cap how long a read may block on in-flight writes so a stalled save (e.g. a
// lost-promise native call) degrades to the existing fallback instead of hanging the UI.
const SQLITE_WRITE_WAIT_TIMEOUT_MS = 3_000;
// Diagnostics: only log waits/saves slow enough to matter, to keep the shared beta log readable.
const SQLITE_WRITE_WAIT_LOG_THRESHOLD_MS = 50;
const SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS = 300;

let saveQueue: Promise<void> = Promise.resolve();

const enqueueSave = async (work: () => Promise<void>): Promise<void> => {
    const next = saveQueue.then(work, () => work());
    saveQueue = next.catch(() => undefined);
    return next;
};

const waitForQueuedSqliteWrites = async (): Promise<void> => {
    while (true) {
        const pendingSave = saveQueue;
        await pendingSave.catch(() => undefined);
        if (pendingSave === saveQueue) return;
    }
};

const SQLITE_DB_NAME = 'mindwtr.db';
const PREFER_LEGACY_SQLITE_OPEN = true;
const sqliteSyncOpenEnv = String(process.env.EXPO_PUBLIC_SQLITE_SYNC_OPEN || '').trim().toLowerCase();
const ENABLE_SYNC_SQLITE_OPEN = sqliteSyncOpenEnv === '1' || sqliteSyncOpenEnv === 'true';

type SqliteState = {
    adapter: SqliteAdapter;
    client: SqliteClient;
};

let sqliteStatePromise: Promise<SqliteState> | null = null;
let sqliteOpenMode = 'unknown';
let preferJsonBackup = false;
let preferJsonBackupUntil = 0;
let didWarnPreferJsonBackup = false;
let latestQueuedWriteStartedAtMs = 0;

const markQueuedWriteStarted = (): number => {
    const startedAtMs = Math.max(Date.now(), latestQueuedWriteStartedAtMs + 1);
    latestQueuedWriteStartedAtMs = startedAtMs;
    return startedAtMs;
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const buildStorageExtra = (message?: string, error?: unknown): Record<string, string> | undefined => {
    const extra: Record<string, string> = {};
    if (message) extra.message = message;
    if (error) {
        extra.error = formatError(error);
        if (error instanceof Error && error.stack) {
            extra.stack = error.stack;
        }
    }
    return Object.keys(extra).length ? extra : undefined;
};

const logStorageWarn = (message: string, error?: unknown, extra?: Record<string, string>) => {
    void logWarn(message, { scope: 'storage', extra: { ...buildStorageExtra(undefined, error), ...extra } });
};

// Diagnostic breadcrumb for the shared beta log; only written when diagnostics logging is on.
const logStorageInfo = (message: string, extra?: Record<string, string>) => {
    void logInfo(message, { scope: 'storage', extra });
};

const logStorageError = (message: string, error?: unknown) => {
    const err = error instanceof Error ? error : new Error(message);
    void logError(err, { scope: 'storage', extra: buildStorageExtra(message, error) });
};

const warnPreferJsonBackup = () => {
    if (didWarnPreferJsonBackup) return;
    logStorageWarn('[Storage] SQLite unavailable; using JSON backup for reads until restart.');
    didWarnPreferJsonBackup = true;
};

const withOperationTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
};

// Wait for in-flight SQLite writes to finish before reading, but bounded: a save that
// stalls must not strand reads (each read site falls back when this throws).
const awaitQueuedSqliteWrites = async (phase: string): Promise<void> => {
    const startedAt = Date.now();
    try {
        await withOperationTimeout(
            waitForQueuedSqliteWrites(),
            SQLITE_WRITE_WAIT_TIMEOUT_MS,
            `Timed out waiting for queued SQLite writes before ${phase}`
        );
    } catch (error) {
        logStorageWarn('[Storage] Gave up waiting for queued SQLite writes; falling back', error, {
            phase,
            waitedMs: String(Date.now() - startedAt),
        });
        throw error;
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= SQLITE_WRITE_WAIT_LOG_THRESHOLD_MS) {
        logStorageInfo('[Storage] Read waited for queued SQLite writes', {
            phase,
            waitedMs: String(waitedMs),
        });
    }
};

const shouldUseJsonBackupFastPath = () => preferJsonBackup && Date.now() < preferJsonBackupUntil;

const markPreferJsonBackup = () => {
    preferJsonBackup = true;
    preferJsonBackupUntil = Date.now() + SQLITE_RETRY_COOLDOWN_MS;
    warnPreferJsonBackup();
};

const clearPreferJsonBackup = () => {
    preferJsonBackup = false;
    preferJsonBackupUntil = 0;
    didWarnPreferJsonBackup = false;
};

const createLegacyClient = (db: any): SqliteClient => {
    const isConnectionPragmaAssignment = (sql: string) =>
        /^\s*PRAGMA\s+(journal_mode|foreign_keys|busy_timeout)\s*=/i.test(sql);

    const execSqlInTransaction = (sql: string, params: unknown[] = []) =>
        new Promise<any>((resolve, reject) => {
            db.transaction(
                (tx: any) => {
                    tx.executeSql(
                        sql,
                        params,
                        (_: any, result: any) => resolve(result),
                        (_: any, error: any) => {
                            reject(error);
                            return true;
                        }
                    );
                },
                (error: any) => reject(error)
            );
        });

    const execSqlDirect = (sql: string) =>
        new Promise<any>((resolve, reject) => {
            try {
                db.exec([{ sql, args: [] }], false, (error: any, result: any) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve(Array.isArray(result) ? result[0] : result);
                });
            } catch (error) {
                reject(error);
            }
        });

    const execSql = (sql: string, params: unknown[] = []) => {
        if (params.length === 0 && isConnectionPragmaAssignment(sql) && typeof db.exec === 'function') {
            return execSqlDirect(sql);
        }
        return execSqlInTransaction(sql, params);
    };

    const exec = async (sql: string) => {
        const statements = sql
            .split(';')
            .map((statement) => statement.trim())
            .filter(Boolean);
        for (const statement of statements) {
            await execSql(statement);
        }
    };

    return {
        run: async (sql: string, params: unknown[] = []) => {
            await execSql(sql, params);
        },
        all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await execSql(sql, params);
            const rows = result?.rows;
            if (!rows) return [] as T[];
            if (Array.isArray(rows._array)) return rows._array as T[];
            const collected: T[] = [];
            for (let i = 0; i < rows.length; i += 1) {
                collected.push(rows.item(i));
            }
            return collected;
        },
        get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
            const result = await execSql(sql, params);
            const rows = result?.rows;
            if (!rows || rows.length === 0) return undefined;
            if (Array.isArray(rows._array)) return rows._array[0] as T;
            return rows.item(0) as T;
        },
        exec,
    };
};

const createSqliteClient = async (): Promise<SqliteClient> => {
    markStartupPhase('mobile.storage.sqlite_client.create:start');
    // Use require to avoid async bundle loading in dev client.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SQLite = require('expo-sqlite');
    if (PREFER_LEGACY_SQLITE_OPEN && typeof (SQLite as any).openDatabase === 'function') {
        const legacyDb = (SQLite as any).openDatabase(SQLITE_DB_NAME);
        sqliteOpenMode = 'legacy_preferred';
        markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'legacy_preferred' });
        return createLegacyClient(legacyDb);
    }
    const openDatabaseSync = (SQLite as any).openDatabaseSync as ((name: string) => any) | undefined;
    if (ENABLE_SYNC_SQLITE_OPEN && openDatabaseSync) {
        try {
            const db = openDatabaseSync(SQLITE_DB_NAME);
            if (db?.runAsync && db?.getAllAsync && db?.getFirstAsync && db?.execAsync) {
                sqliteOpenMode = 'sync';
                markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'sync' });
                return {
                    run: async (sql: string, params: unknown[] = []) => {
                        await db.runAsync(sql, params);
                    },
                    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        db.getAllAsync(sql, params) as Promise<T[]>,
                    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        (await db.getFirstAsync(sql, params)) as T | undefined,
                    exec: async (sql: string) => {
                        await db.execAsync(sql);
                    },
                };
            }
        } catch (error) {
            if (__DEV__) {
                logStorageWarn('[Storage] Sync SQLite open failed; falling back', error);
            }
        }
    }
    const openDatabaseAsync = (SQLite as any).openDatabaseAsync as ((name: string) => Promise<any>) | undefined;
    if (openDatabaseAsync) {
        try {
            const db = await openDatabaseAsync(SQLITE_DB_NAME);
            if (db?.runAsync && db?.getAllAsync && db?.getFirstAsync && db?.execAsync) {
                sqliteOpenMode = 'async';
                markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'async' });
                return {
                    run: async (sql: string, params: unknown[] = []) => {
                        await db.runAsync(sql, params);
                    },
                    all: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        db.getAllAsync(sql, params) as Promise<T[]>,
                    get: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
                        (await db.getFirstAsync(sql, params)) as T | undefined,
                    exec: async (sql: string) => {
                        await db.execAsync(sql);
                    },
                };
            }
        } catch (error) {
            if (__DEV__) {
                logStorageWarn('[Storage] Async SQLite open failed, falling back to legacy API', error);
            }
        }
    }

    const legacyDb = (SQLite as any).openDatabase(SQLITE_DB_NAME);
    sqliteOpenMode = 'legacy';
    markStartupPhase('mobile.storage.sqlite_client.create:end', { mode: 'legacy' });
    return createLegacyClient(legacyDb);
};

const sqliteHasAnyData = async (client: SqliteClient): Promise<boolean> => {
    const count = async (table: string) => {
        const row = await client.get<{ count?: number }>(`SELECT COUNT(*) as count FROM ${table}`);
        return Number(row?.count ?? 0);
    };
    const [tasks, projects, areas, settings] = await Promise.all([
        count('tasks'),
        count('projects'),
        count('areas'),
        count('settings'),
    ]);
    return tasks > 0 || projects > 0 || areas > 0 || settings > 0;
};

const getLegacyJson = async (AsyncStorage: any): Promise<string | null> => {
    let jsonValue = await AsyncStorage.getItem(DATA_KEY);
    if (jsonValue != null) return jsonValue;
    for (const legacyKey of LEGACY_DATA_KEYS) {
        const legacyValue = await AsyncStorage.getItem(legacyKey);
        if (legacyValue != null) {
            await AsyncStorage.setItem(DATA_KEY, legacyValue);
            return legacyValue;
        }
    }
    return null;
};

const normalizeStoredAppData = (data: AppData): AppData => ({
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    projects: Array.isArray(data.projects) ? data.projects : [],
    sections: Array.isArray(data.sections) ? data.sections : [],
    areas: Array.isArray(data.areas) ? data.areas : [],
    people: Array.isArray(data.people) ? data.people : [],
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
});

const parseStoredAppDataJson = (jsonValue: string): AppData => (
    normalizeStoredAppData(JSON.parse(jsonValue) as AppData)
);

const saveStartupJsonBackup = async (
    AsyncStorage: any,
    data: AppData,
    phasePrefix: string,
    minimumUpdatedAtMs = 0,
): Promise<void> => {
    const jsonValue = await measureStartupPhase(`${phasePrefix}.json_backup_stringify`, async () => JSON.stringify(data));
    const updatedAtMs = Math.max(Date.now(), minimumUpdatedAtMs);
    await measureStartupPhase(`${phasePrefix}.json_backup_set`, async () =>
        AsyncStorage.setItem(DATA_KEY, jsonValue)
    );
    await measureStartupPhase(`${phasePrefix}.json_backup_version_set`, async () =>
        AsyncStorage.setItem(STARTUP_BACKUP_VERSION_KEY, STARTUP_BACKUP_VERSION)
    );
    await measureStartupPhase(`${phasePrefix}.json_backup_updated_at_set`, async () =>
        AsyncStorage.setItem(STARTUP_BACKUP_UPDATED_AT_KEY, String(updatedAtMs))
    );
};

const readStartupJsonBackupUpdatedAt = async (AsyncStorage: any): Promise<number | null> => {
    const raw = await AsyncStorage.getItem(STARTUP_BACKUP_UPDATED_AT_KEY);
    if (raw == null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const assertJsonBackupFreshEnough = async (AsyncStorage: any, phase: string): Promise<void> => {
    if (latestQueuedWriteStartedAtMs <= 0) return;
    const backupUpdatedAtMs = await readStartupJsonBackupUpdatedAt(AsyncStorage);
    if (backupUpdatedAtMs !== null && backupUpdatedAtMs >= latestQueuedWriteStartedAtMs) return;
    logStorageWarn('[Storage] Refusing stale JSON backup fallback', undefined, {
        phase,
        backupUpdatedAtMs: backupUpdatedAtMs === null ? 'missing' : String(backupUpdatedAtMs),
        latestQueuedWriteStartedAtMs: String(latestQueuedWriteStartedAtMs),
    });
    throw new Error('JSON backup is older than the latest queued SQLite write. Please wait for the save to finish and try again.');
};

export const getMobileStartupSnapshotFromBackup = async (): Promise<AppData | null> => {
    const backupVersion = await AsyncStorage.getItem(STARTUP_BACKUP_VERSION_KEY);
    if (backupVersion !== STARTUP_BACKUP_VERSION) {
        return null;
    }
    const jsonValue = await getLegacyJson(AsyncStorage);
    if (jsonValue == null) {
        return null;
    }
    try {
        return parseStoredAppDataJson(jsonValue);
    } catch (error) {
        logStorageWarn('[Storage] Failed to parse startup JSON backup snapshot', error);
        return null;
    }
};

const initSqliteState = async (): Promise<SqliteState> => {
    markStartupPhase('mobile.storage.sqlite_init.start');
    let client = await measureStartupPhase('mobile.storage.sqlite_init.create_client', async () => createSqliteClient());
    let adapter = new SqliteAdapter(client);
    try {
        await measureStartupPhase('mobile.storage.sqlite_init.ensure_schema', async () => adapter.ensureSchema());
    } catch (error) {
        if (__DEV__) {
            logStorageWarn('[Storage] SQLite schema init failed, retrying with legacy API', error);
        }
        // Use require to avoid async bundle loading in dev client.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const SQLite = require('expo-sqlite');
        const legacyDb = (SQLite as any).openDatabase(SQLITE_DB_NAME);
        client = createLegacyClient(legacyDb);
        adapter = new SqliteAdapter(client);
        await measureStartupPhase('mobile.storage.sqlite_init.ensure_schema_legacy_retry', async () => adapter.ensureSchema());
    }
    // Diagnostic: confirm whether WAL actually took effect on this device. The schema PRAGMA
    // may not switch journal mode on the legacy client (it runs each statement in its own
    // transaction), so the shared beta log should report the real mode rather than assume WAL.
    try {
        const journalRow = await client.get<{ journal_mode?: string }>('PRAGMA journal_mode');
        const busyRow = await client.get<{ timeout?: number }>('PRAGMA busy_timeout');
        logStorageInfo('[Storage] SQLite journal mode ready', {
            journalMode: String(journalRow?.journal_mode ?? 'unknown'),
            busyTimeoutMs: String(busyRow?.timeout ?? 'unknown'),
            openMode: sqliteOpenMode,
        });
    } catch (error) {
        logStorageWarn('[Storage] Failed to read SQLite journal mode', error);
    }
    let hasData = false;
    try {
        hasData = await measureStartupPhase('mobile.storage.sqlite_init.has_any_data', async () => sqliteHasAnyData(client));
    } catch (error) {
        if (__DEV__) {
            logStorageWarn('[Storage] SQLite availability check failed', error);
        }
        hasData = false;
    }
    if (!hasData) {
        const jsonValue = await measureStartupPhase('mobile.storage.sqlite_init.read_legacy_json', async () => getLegacyJson(AsyncStorage));
        if (jsonValue != null) {
            try {
                const data = JSON.parse(jsonValue) as AppData;
                data.areas = Array.isArray(data.areas) ? data.areas : [];
                // Ensure JSON backup is updated before SQLite migration so fallback stays consistent.
                await saveStartupJsonBackup(AsyncStorage, data, 'mobile.storage.sqlite_init.migrate');
                await measureStartupPhase('mobile.storage.sqlite_init.migrate_json_to_sqlite', async () => adapter.saveData(data));
            } catch (error) {
                logStorageWarn('[Storage] Failed to migrate JSON data to SQLite', error);
            }
        }
    }
    markStartupPhase('mobile.storage.sqlite_init.end');
    return { adapter, client };
};

const getSqliteState = async (): Promise<SqliteState> => {
    if (!sqliteStatePromise) {
        markStartupPhase('mobile.storage.sqlite_state.cache_miss');
        sqliteStatePromise = initSqliteState();
    } else {
        markStartupPhase('mobile.storage.sqlite_state.cache_hit');
    }
    try {
        const state = await sqliteStatePromise;
        markStartupPhase('mobile.storage.sqlite_state.ready');
        return state;
    } catch (error) {
        markStartupPhase('mobile.storage.sqlite_state.retry_after_error');
        sqliteStatePromise = null;
        // Retry once on init failure to avoid a poisoned cache.
        sqliteStatePromise = initSqliteState();
        const state = await sqliteStatePromise;
        markStartupPhase('mobile.storage.sqlite_state.ready_after_retry');
        return state;
    }
};

// Platform-specific storage implementation
const createStorage = (): StorageAdapter => {
    // Web platform - use localStorage
    if (Platform.OS === 'web') {
        return {
            getData: async (): Promise<AppData> => {
                if (typeof window === 'undefined') {
                    return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
                }
                let jsonValue = localStorage.getItem(DATA_KEY);
                if (jsonValue == null) {
                    for (const legacyKey of LEGACY_DATA_KEYS) {
                        const legacyValue = localStorage.getItem(legacyKey);
                        if (legacyValue != null) {
                            localStorage.setItem(DATA_KEY, legacyValue);
                            jsonValue = legacyValue;
                            break;
                        }
                    }
                }
                if (jsonValue == null) {
                    return { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
                }
                try {
                    const data = parseStoredAppDataJson(jsonValue);
                    return data;
                } catch (e) {
                    // JSON parse error - data corrupted, throw so user is notified
                    logStorageError('Failed to parse stored data - may be corrupted', e);
                    throw new Error('Data appears corrupted. Please restore from backup.');
                }
            },
            saveData: async (data: AppData): Promise<void> => {
                try {
                    if (typeof window !== 'undefined') {
                        const jsonValue = JSON.stringify(data);
                        localStorage.setItem(DATA_KEY, jsonValue);
                    }
                } catch (e) {
                    logStorageError('Failed to save data', e);
                    throw new Error('Failed to save data: ' + (e as Error).message);
                }
            },
        };
    }

    // Native platforms - use SQLite with AsyncStorage backup for widgets/rollback.
    const shouldUseSqlite = Constants.appOwnership !== 'expo';

    return {
        getData: async (): Promise<AppData> => {
            markStartupPhase('mobile.storage.get_data.start');
            const loadJsonBackup = async (phase = 'get_data') => {
                await assertJsonBackupFreshEnough(AsyncStorage, phase);
                const jsonValue = await getLegacyJson(AsyncStorage);
                if (jsonValue == null) {
                    return { ...EMPTY_APP_DATA };
                }
                if (jsonValue != null) {
                    try {
                        const data = parseStoredAppDataJson(jsonValue);
                        updateMobileWidgetFromData(data).catch((error) => {
                            logStorageWarn('[Widgets] Failed to update mobile widget from backup', error);
                        });
                        return data;
                    } catch (parseError) {
                        logStorageError('Failed to parse stored data - may be corrupted', parseError);
                    }
                }
                throw new Error('Data appears corrupted. Please restore from backup.');
            };

            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                return loadJsonBackup('json_fast_path');
            }
            if (preferJsonBackup && !shouldUseSqlite) {
                warnPreferJsonBackup();
                return loadJsonBackup('json_preferred_sqlite_disabled');
            }
            if (preferJsonBackup) {
                warnPreferJsonBackup();
            }
            try {
                if (!shouldUseSqlite) {
                    throw new Error('SQLite disabled in Expo Go');
                }
                await measureStartupPhase(
                    'mobile.storage.get_data.await_sqlite_writes',
                    async () => awaitQueuedSqliteWrites('get_data')
                );
                const { adapter } = await measureStartupPhase('mobile.storage.get_data.sqlite_get_state', async () =>
                    withOperationTimeout(
                        getSqliteState(),
                        SQLITE_STARTUP_TIMEOUT_MS,
                        'SQLite initialization timed out'
                    )
                );
                const data = await measureStartupPhase('mobile.storage.get_data.sqlite_read', async () =>
                    withOperationTimeout(
                        adapter.getData(),
                        SQLITE_STARTUP_TIMEOUT_MS,
                        'SQLite read timed out'
                    )
                );
                data.areas = Array.isArray(data.areas) ? data.areas : [];
                saveStartupJsonBackup(AsyncStorage, data, 'mobile.storage.get_data', latestQueuedWriteStartedAtMs).catch((error) => {
                    logStorageWarn('[Storage] Failed to refresh startup JSON backup from SQLite load', error);
                });
                updateMobileWidgetFromData(data).catch((error) => {
                    logStorageWarn('[Widgets] Failed to update mobile widget from storage load', error);
                });
                markStartupPhase('mobile.storage.get_data.widget_update_dispatched');
                clearPreferJsonBackup();
                markStartupPhase('mobile.storage.get_data.end');
                return data;
            } catch (e) {
                if (__DEV__ && !shouldUseSqlite && String(e).includes('Expo Go')) {
                    logStorageWarn('[Storage] SQLite disabled in Expo Go, falling back to JSON backup');
                } else {
                    logStorageWarn('[Storage] SQLite load failed, falling back to JSON backup', e);
                }
                markPreferJsonBackup();
                const fallbackData = await measureStartupPhase('mobile.storage.get_data.json_fallback_read', async () => loadJsonBackup('get_data_fallback'));
                markStartupPhase('mobile.storage.get_data.end');
                return fallbackData;
            }
        },
        saveData: async (data: AppData): Promise<void> => {
            return enqueueSave(async () => {
                markStartupPhase('mobile.storage.save_data.start');
                const queuedWriteStartedAtMs = markQueuedWriteStarted();
                try {
                    if (!shouldUseSqlite) {
                        throw new Error('SQLite disabled in Expo Go');
                    }
                    const { adapter } = await measureStartupPhase('mobile.storage.save_data.sqlite_get_state', async () => getSqliteState());
                    const writeStartedAt = Date.now();
                    await measureStartupPhase('mobile.storage.save_data.sqlite_write', async () => adapter.saveData(data));
                    const writeMs = Date.now() - writeStartedAt;
                    if (writeMs >= SQLITE_SLOW_WRITE_LOG_THRESHOLD_MS) {
                        logStorageInfo('[Storage] Slow SQLite save', { writeMs: String(writeMs) });
                    }
                    clearPreferJsonBackup();
                } catch (error) {
                    markPreferJsonBackup();
                    if (__DEV__ && !shouldUseSqlite && String(error).includes('Expo Go')) {
                        logStorageWarn('[Storage] SQLite disabled in Expo Go, keeping JSON backup');
                    } else {
                        logStorageWarn('[Storage] SQLite save failed, keeping JSON backup', error);
                    }
                }
                try {
                    await saveStartupJsonBackup(AsyncStorage, data, 'mobile.storage.save_data', queuedWriteStartedAtMs);
                    await measureStartupPhase('mobile.storage.save_data.widget_update', async () => updateMobileWidgetFromData(data));
                    markStartupPhase('mobile.storage.save_data.end');
                } catch (e) {
                    markStartupPhase('mobile.storage.save_data.error');
                    logStorageError('Failed to save data', e);
                    throw new Error('Failed to save data: ' + (e as Error).message);
                }
            });
        },
        saveTask: async (task: Task, snapshot?: AppData): Promise<void> => {
            return enqueueSave(async () => {
                const queuedWriteStartedAtMs = markQueuedWriteStarted();
                try {
                    if (!shouldUseSqlite) {
                        throw new Error('SQLite disabled in Expo Go');
                    }
                    const { adapter } = await measureStartupPhase('mobile.storage.save_task.sqlite_get_state', async () => getSqliteState());
                    await measureStartupPhase('mobile.storage.save_task.sqlite_write', async () => adapter.saveTask(task));
                    clearPreferJsonBackup();
                    if (snapshot) {
                        await saveStartupJsonBackup(AsyncStorage, snapshot, 'mobile.storage.save_task', queuedWriteStartedAtMs);
                        await measureStartupPhase('mobile.storage.save_task.widget_update', async () => updateMobileWidgetFromData(snapshot));
                    }
                } catch (error) {
                    markPreferJsonBackup();
                    logStorageWarn('[Storage] SQLite task save failed', error);
                    if (!snapshot) {
                        throw error;
                    }

                    try {
                        await saveStartupJsonBackup(AsyncStorage, snapshot, 'mobile.storage.save_task.json_fallback', queuedWriteStartedAtMs);
                        await measureStartupPhase('mobile.storage.save_task.json_fallback_widget_update', async () =>
                            updateMobileWidgetFromData(snapshot)
                        );
                    } catch (fallbackError) {
                        logStorageError('Failed to save task fallback data', fallbackError);
                        throw new Error('Failed to save task: ' + (fallbackError as Error).message);
                    }
                }
            });
        },
        queryTasks: async (options) => {
            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                const data = await mobileStorage.getData();
                const statusFilter = options.status;
                const excludeStatuses = options.excludeStatuses ?? [];
                const includeArchived = options.includeArchived === true;
                const includeDeleted = options.includeDeleted === true;
                return data.tasks.filter((task) => {
                    if (!includeDeleted && task.deletedAt) return false;
                    if (!includeArchived && task.status === 'archived') return false;
                    if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
                    if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
                    if (options.projectId && task.projectId !== options.projectId) return false;
                    return true;
                });
            }
            try {
                await awaitQueuedSqliteWrites('query_tasks');
                const { adapter } = await withOperationTimeout(
                    getSqliteState(),
                    SQLITE_QUERY_TIMEOUT_MS,
                    'SQLite query initialization timed out'
                );
                if (typeof (adapter as any).queryTasks === 'function') {
                    return withOperationTimeout(
                        (adapter as any).queryTasks(options),
                        SQLITE_QUERY_TIMEOUT_MS,
                        'SQLite query timed out'
                    );
                }
            } catch (error) {
                markPreferJsonBackup();
                logStorageWarn('[Storage] SQLite query failed, falling back to in-memory filter', error);
            }
            const data = await mobileStorage.getData();
            const statusFilter = options.status;
            const excludeStatuses = options.excludeStatuses ?? [];
            const includeArchived = options.includeArchived === true;
            const includeDeleted = options.includeDeleted === true;
            return data.tasks.filter((task) => {
                if (!includeDeleted && task.deletedAt) return false;
                if (!includeArchived && task.status === 'archived') return false;
                if (statusFilter && statusFilter !== 'all' && task.status !== statusFilter) return false;
                if (excludeStatuses.length > 0 && excludeStatuses.includes(task.status)) return false;
                if (options.projectId && task.projectId !== options.projectId) return false;
                return true;
            });
        },
        searchAll: async (query: string) => {
            if (shouldUseJsonBackupFastPath()) {
                warnPreferJsonBackup();
                const data = await mobileStorage.getData();
                return searchAll(data.tasks, data.projects, query);
            }
            try {
                await awaitQueuedSqliteWrites('search_all');
                const { adapter } = await withOperationTimeout(
                    getSqliteState(),
                    SQLITE_QUERY_TIMEOUT_MS,
                    'SQLite search initialization timed out'
                );
                if (typeof (adapter as any).searchAll === 'function') {
                    return withOperationTimeout(
                        (adapter as any).searchAll(query),
                        SQLITE_QUERY_TIMEOUT_MS,
                        'SQLite search timed out'
                    );
                }
            } catch (error) {
                markPreferJsonBackup();
                logStorageWarn('[Storage] SQLite search failed, falling back to in-memory search', error);
            }
            const data = await mobileStorage.getData();
            return searchAll(data.tasks, data.projects, query);
        },
    };
};

export const mobileStorage = createStorage();

export const __mobileStorageTestUtils = {
    createLegacyClientForTests: createLegacyClient,
    reset: () => {
        saveQueue = Promise.resolve();
        sqliteStatePromise = null;
        latestQueuedWriteStartedAtMs = 0;
        clearPreferJsonBackup();
    },
    setSqliteStateForTests: (state: { adapter: Pick<SqliteAdapter, 'saveTask'>; client: Partial<SqliteClient> }) => {
        sqliteStatePromise = Promise.resolve(state as SqliteState);
        clearPreferJsonBackup();
    },
};

// MARK: - Calendar Sync SQLite helpers

export const getCalendarSyncEntry = async (taskId: string, platform: string) => {
    const { adapter } = await getSqliteState();
    return adapter.getCalendarSyncEntry(taskId, platform);
};

export const upsertCalendarSyncEntry = async (entry: CalendarSyncEntry) => {
    const { adapter } = await getSqliteState();
    return adapter.upsertCalendarSyncEntry(entry);
};

export const deleteCalendarSyncEntry = async (taskId: string, platform: string) => {
    const { adapter } = await getSqliteState();
    return adapter.deleteCalendarSyncEntry(taskId, platform);
};

export const getAllCalendarSyncEntries = async (platform: string) => {
    const { adapter } = await getSqliteState();
    return adapter.getAllCalendarSyncEntries(platform);
};
