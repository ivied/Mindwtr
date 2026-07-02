import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPendingSave, setStorageAdapter, useTaskStore } from '@mindwtr/core';
import type { AppData, StorageAdapter } from '@mindwtr/core';
import { __localDataWatcherTestUtils, markLocalSqliteWrite, markLocalWrite, start } from './local-data-watcher';

function getTauriMocks() {
    const globalObject = globalThis as typeof globalThis & {
        __localWatcherInvokeMock?: ReturnType<typeof vi.fn>;
    };
    if (!globalObject.__localWatcherInvokeMock) {
        globalObject.__localWatcherInvokeMock = vi.fn();
    }
    return {
        invokeMock: globalObject.__localWatcherInvokeMock,
    };
}

vi.mock('@tauri-apps/api/core', async () => {
    return {
        SERIALIZE_TO_IPC_FN: '__TAURI_TO_IPC_KEY__',
        Channel: class {},
        PluginListener: class {
            async unregister() {
                return undefined;
            }
        },
        Resource: class {},
        addPluginListener: async () => ({
            unregister: async () => undefined,
        }),
        checkPermissions: async () => undefined,
        convertFileSrc: (filePath: string) => filePath,
        invoke: getTauriMocks().invokeMock,
        isTauri: () => true,
        requestPermissions: async () => undefined,
        transformCallback: () => 1,
    };
});

let nowMs = 0;
let externalData: AppData;
let saveCalls: AppData[] = [];
let timerId = 1;
const scheduledTimers = new Map<number, () => void>();

const scheduleMock = ((callback: TimerHandler) => {
    const id = timerId++;
    const fn = typeof callback === 'function' ? callback : () => undefined;
    scheduledTimers.set(id, fn as () => void);
    return id as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

const cancelScheduleMock = ((id: ReturnType<typeof setTimeout>) => {
    scheduledTimers.delete(id as unknown as number);
}) as unknown as typeof clearTimeout;

const flushScheduledTimers = async () => {
    let guard = 0;
    let idleRounds = 0;
    while (guard < 50 && idleRounds < 5) {
        guard += 1;
        if (scheduledTimers.size === 0) {
            idleRounds += 1;
            await Promise.resolve();
            continue;
        }
        idleRounds = 0;
        const callbacks = Array.from(scheduledTimers.entries());
        scheduledTimers.clear();
        callbacks.forEach(([, callback]) => callback());
        await Promise.resolve();
    }
};

const emptyData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    people: [],
    settings: { deviceId: 'dev-local' },
});

const storageAdapter: StorageAdapter = {
    getData: async () => emptyData(),
    saveData: async (data) => {
        saveCalls.push(data);
    },
    queryTasks: async () => [],
    searchAll: async () => ({ tasks: [], projects: [] }),
};

beforeEach(() => {
    const { invokeMock } = getTauriMocks();
    invokeMock.mockReset();
    (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {};

    nowMs = 0;
    timerId = 1;
    scheduledTimers.clear();
    saveCalls = [];
    externalData = emptyData();

    setStorageAdapter(storageAdapter);

    useTaskStore.setState((state) => ({
        ...state,
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        _allTasks: [],
        _allProjects: [],
        _allSections: [],
        _allAreas: [],
        _allPeople: [],
        _peopleById: new Map(),
        settings: { deviceId: 'dev-local' },
        lastDataChangeAt: 0,
        error: null,
    }));

    __localDataWatcherTestUtils.resetForTests();
    __localDataWatcherTestUtils.setDependenciesForTests({
        now: () => nowMs,
        readDataJson: async () => externalData,
        schedule: scheduleMock,
        cancelSchedule: cancelScheduleMock,
        hashPayload: async (payload) => payload,
        logInfo: () => undefined,
        logWarn: () => undefined,
    });
});

afterEach(async () => {
    __localDataWatcherTestUtils.resetForTests();
    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
    scheduledTimers.clear();
    await flushPendingSave();
});

describe('local-data-watcher', () => {
    it('refreshes the store when SQLite WAL files change', async () => {
        const watchers: Array<{ path: string; callback: (event: { path?: string; paths?: string[] }) => void }> = [];
        const task = {
            id: 'mcp-1',
            title: 'From MCP',
            status: 'inbox' as const,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        } as AppData['tasks'][number];
        const refreshStorageData = vi.fn(async () => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [task],
                _allTasks: [task],
                lastDataChangeAt: 1,
            }));
        });

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        expect(watchers.map((watcher) => watcher.path)).toEqual(['/tmp/mindwtr/data.json', '/tmp/mindwtr']);

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
        expect(useTaskStore.getState().tasks[0]?.id).toBe('mcp-1');
    });

    it('ignores SQLite shared-memory events from read activity', async () => {
        const watchers: Array<{ path: string; callback: (event: { path?: string; paths?: string[] }) => void }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-shm'] });
        await flushScheduledTimers();

        expect(refreshStorageData).not.toHaveBeenCalled();

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('ignores SQLite watcher events caused by local SQLite writes', async () => {
        const watchers: Array<{ path: string; callback: (event: { path?: string; paths?: string[] }) => void }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        markLocalSqliteWrite();
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).not.toHaveBeenCalled();

        nowMs = 2100;
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).not.toHaveBeenCalled();

        nowMs = 15100;
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('does not feed SQLite watcher loops when a refresh finds no data changes', async () => {
        const watchers: Array<{ path: string; callback: (event: { path?: string; paths?: string[] }) => void }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);

        nowMs = 2100;
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(2);
    });

    it('does not treat sync bookkeeping-only SQLite refreshes as app data changes', async () => {
        const watchers: Array<{ path: string; callback: (event: { path?: string; paths?: string[] }) => void }> = [];
        const logInfo = vi.fn();
        const refreshStorageData = vi.fn(async () => {
            useTaskStore.setState((state) => ({
                ...state,
                settings: {
                    ...state.settings,
                    lastSyncAt: '2026-01-01T00:00:00.000Z',
                    lastSyncStatus: 'success',
                },
                lastDataChangeAt: 1,
            }));
        });

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
            logInfo,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');
        logInfo.mockClear();

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
        expect(logInfo).not.toHaveBeenCalledWith('[local-data-watcher] Refreshed after SQLite change');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('does not cancel a pending external SQLite refresh when a local SQLite write follows', async () => {
        const watchers: Array<{ path: string; callback: (event: { path?: string; paths?: string[] }) => void }> = [];
        const refreshStorageData = vi.fn();

        __localDataWatcherTestUtils.setDependenciesForTests({
            watchFile: async (path, callback) => {
                watchers.push({ path, callback });
                return () => undefined;
            },
            refreshStorageData,
        });

        await start('/tmp/mindwtr/data.json', '/tmp/mindwtr/mindwtr.db');

        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        markLocalSqliteWrite();
        watchers[1]?.callback({ paths: ['/tmp/mindwtr/mindwtr.db-wal'] });
        await flushScheduledTimers();

        expect(refreshStorageData).toHaveBeenCalledTimes(1);
    });

    it('ignores self-written payloads after the ignore window drains', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'local-1',
                    title: 'Written by sync',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite(externalData);

        nowMs = 1000;
        await __localDataWatcherTestUtils.triggerChangeForTests();
        expect(saveCalls).toHaveLength(0);

        nowMs = 2200;
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(0);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);
    });

    it('ignores older self-written payloads when multiple local writes happen back-to-back', async () => {
        const firstWrite = {
            ...emptyData(),
            tasks: [
                {
                    id: 'local-older',
                    title: 'First write',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;
        const secondWrite = {
            ...emptyData(),
            tasks: [
                {
                    id: 'local-newer',
                    title: 'Second write',
                    status: 'next',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite(firstWrite);

        nowMs = 500;
        markLocalWrite(secondWrite);

        externalData = firstWrite;
        nowMs = 1000;
        await __localDataWatcherTestUtils.triggerChangeForTests();
        expect(saveCalls).toHaveLength(0);

        nowMs = 2600;
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(0);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBeGreaterThan(0);

        externalData = secondWrite;
        await __localDataWatcherTestUtils.triggerChangeForTests();

        expect(saveCalls).toHaveLength(0);
        expect(__localDataWatcherTestUtils.getPendingSelfWritePayloadLengthForTests()).toBe(0);
    });

    it('re-reads external writes that happen during ignore window', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'ext-1',
                    title: 'From CLI',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite();

        nowMs = 1000;
        await __localDataWatcherTestUtils.triggerChangeForTests();
        expect(saveCalls).toHaveLength(0);

        nowMs = 2200;
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'ext-1')).toBe(true);
    });

    it('can merge an explicit cross-window refresh without waiting for the watcher debounce', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'quick-add-1',
                    title: 'From quick add window',
                    status: 'inbox',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ],
        } as AppData;

        markLocalWrite();

        nowMs = 1000;
        await __localDataWatcherTestUtils.refreshFromDiskNowForTests();

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'quick-add-1')).toBe(true);
        expect(scheduledTimers.size).toBe(0);
    });

    it('persists merged changes through store save queue (without direct tauri save_data calls)', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'ext-2',
                    title: 'Merged task',
                    status: 'next',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        } as AppData;

        await __localDataWatcherTestUtils.triggerChangeForTests();
        await flushScheduledTimers();

        const { invokeMock } = getTauriMocks();
        expect(invokeMock.mock.calls.some(([command]) => command === 'save_data')).toBe(false);
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.tasks.some((task) => task.id === 'ext-2')).toBe(true);
    });

    it('preserves merged people when writing external data through the store', async () => {
        externalData = {
            ...emptyData(),
            people: [
                {
                    id: 'person-1',
                    name: 'Alex',
                    createdAt: '2026-01-02T00:00:00.000Z',
                    updatedAt: '2026-01-02T00:00:00.000Z',
                },
            ],
        };

        await __localDataWatcherTestUtils.triggerChangeForTests();
        await flushScheduledTimers();

        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0]?.people?.some((person) => person.id === 'person-1')).toBe(true);
        expect(useTaskStore.getState().people.some((person) => person.id === 'person-1')).toBe(true);
        expect(useTaskStore.getState()._allPeople.some((person) => person.id === 'person-1')).toBe(true);
        expect(useTaskStore.getState()._peopleById.get('person-1')?.name).toBe('Alex');
    });

    it('skips merge work when the external payload already matches the local snapshot', async () => {
        externalData = {
            ...emptyData(),
            tasks: [
                {
                    id: 'same-1',
                    title: 'Already current',
                    status: 'next',
                    createdAt: '2026-01-03T00:00:00.000Z',
                    updatedAt: '2026-01-03T00:00:00.000Z',
                },
            ],
        } as AppData;
        const mergeSpy = vi.fn((local: AppData) => local);

        __localDataWatcherTestUtils.setDependenciesForTests({
            getSnapshot: () => externalData,
            merge: mergeSpy,
        });

        await __localDataWatcherTestUtils.triggerChangeForTests();
        await flushScheduledTimers();

        expect(mergeSpy).not.toHaveBeenCalled();
        expect(saveCalls).toHaveLength(0);
    });
});
