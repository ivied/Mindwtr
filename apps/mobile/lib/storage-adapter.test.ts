import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';

const {
  asyncStorageMock,
  localStorageMock,
  sqliteAdapterSaveTask,
  updateMobileWidgetFromDataMock,
} = vi.hoisted(() => ({
  asyncStorageMock: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  localStorageMock: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  sqliteAdapterSaveTask: vi.fn(),
  updateMobileWidgetFromDataMock: vi.fn(),
}));

vi.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    appOwnership: 'standalone',
  },
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      OS: 'android',
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: asyncStorageMock,
}));

vi.mock('./widget-service', () => ({
  updateMobileWidgetFromData: updateMobileWidgetFromDataMock,
}));

vi.mock('./app-log', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock('./startup-profiler', () => ({
  markStartupPhase: vi.fn(),
  measureStartupPhase: vi.fn(async (_name: string, work: () => Promise<unknown>) => work()),
}));

describe('mobile storage adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    asyncStorageMock.getItem.mockResolvedValue(null);
    asyncStorageMock.setItem.mockResolvedValue(undefined);
    sqliteAdapterSaveTask.mockResolvedValue(undefined);
    updateMobileWidgetFromDataMock.mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: localStorageMock },
    });
  });

  it('refreshes the JSON startup backup after a successful incremental task save', async () => {
    const currentTask: Task = {
      id: 'task-current',
      title: 'Current task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    };
    const currentSnapshot: AppData = {
      tasks: [currentTask],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    if (!mobileStorage.saveTask) {
      throw new Error('Expected mobile storage to support saveTask');
    }
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: { saveTask: sqliteAdapterSaveTask },
      client: {},
    });

    await mobileStorage.saveTask(currentTask, currentSnapshot);

    expect(sqliteAdapterSaveTask).toHaveBeenCalledWith(currentTask);
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data',
      JSON.stringify(currentSnapshot),
    );
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data:startup-backup-version',
      '2',
    );
    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr-data:startup-backup-updated-at',
      expect.stringMatching(/^\d+$/),
    );
    expect(updateMobileWidgetFromDataMock).toHaveBeenCalledWith(currentSnapshot);
  }, 10_000);

  it('waits for queued SQLite writes before reading from SQLite', async () => {
    const currentSnapshot: AppData = {
      tasks: [],
      projects: [
        {
          id: 'project-current',
          title: 'Current project',
          status: 'active',
          order: 0,
          color: '#888888',
          tagIds: [],
          createdAt: '2026-06-30T00:00:00.000Z',
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      ],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    let finishSqliteWrite!: () => void;
    let writeFinished = false;
    const sqliteAdapterSaveData = vi.fn(() => new Promise<void>((resolve) => {
      finishSqliteWrite = () => {
        writeFinished = true;
        resolve();
      };
    }));
    const sqliteAdapterGetData = vi.fn(async () => {
      if (!writeFinished) {
        throw new Error('read started before queued write finished');
      }
      return currentSnapshot;
    });

    const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
    __mobileStorageTestUtils.setSqliteStateForTests({
      adapter: {
        getData: sqliteAdapterGetData,
        saveData: sqliteAdapterSaveData,
        saveTask: sqliteAdapterSaveTask,
      } as any,
      client: {},
    });

    const savePromise = mobileStorage.saveData(currentSnapshot);
    for (let index = 0; index < 5 && sqliteAdapterSaveData.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    expect(sqliteAdapterSaveData).toHaveBeenCalledTimes(1);

    const readPromise = mobileStorage.getData();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sqliteAdapterGetData).not.toHaveBeenCalled();

    finishSqliteWrite();
    await savePromise;
    await expect(readPromise).resolves.toEqual(currentSnapshot);
    expect(sqliteAdapterGetData).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('falls back to a fresh JSON backup instead of hanging when a queued SQLite write stalls', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const freshBackupUpdatedAt = String(Date.now() + 1);
      const backupSnapshot: AppData = {
        tasks: [],
        projects: [
          {
            id: 'project-backup',
            title: 'Backup project',
            status: 'active',
            order: 0,
            color: '#888888',
            tagIds: [],
            createdAt: '2026-06-30T00:00:00.000Z',
            updatedAt: '2026-06-30T00:00:00.000Z',
          },
        ],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      };
      asyncStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'mindwtr-data:startup-backup-updated-at') return Promise.resolve(freshBackupUpdatedAt);
        if (key === 'mindwtr-data') return Promise.resolve(JSON.stringify(backupSnapshot));
        return Promise.resolve(null);
      });

      // A SQLite write that never settles, e.g. a lost-promise native bridge call.
      const stalledSave = vi.fn(() => new Promise<void>(() => {}));
      const sqliteAdapterGetData = vi.fn(async () => {
        throw new Error('SQLite read should not run while a write is stalled');
      });

      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          getData: sqliteAdapterGetData,
          saveData: stalledSave,
          saveTask: sqliteAdapterSaveTask,
        } as any,
        client: {},
      });

      void mobileStorage.saveData(backupSnapshot);
      await vi.advanceTimersByTimeAsync(0);
      expect(stalledSave).toHaveBeenCalledTimes(1);

      const readPromise = mobileStorage.getData();
      let settled = false;
      void readPromise.then(() => { settled = true; }, () => { settled = true; });

      // Advance well past the bounded wait; the read must give up waiting and fall back.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(settled).toBe(true);

      const data = await readPromise;
      expect(data.projects).toEqual(backupSnapshot.projects);
      expect(sqliteAdapterGetData).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('rejects a stale JSON backup when a queued SQLite write stalls', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-30T00:00:00.000Z'));
      const staleBackupUpdatedAt = String(Date.now() - 1);
      const staleBackup: AppData = {
        tasks: [],
        projects: [
          {
            id: 'project-stale-backup',
            title: 'Stale backup project',
            status: 'active',
            order: 0,
            color: '#888888',
            tagIds: [],
            createdAt: '2026-06-29T00:00:00.000Z',
            updatedAt: '2026-06-29T00:00:00.000Z',
          },
        ],
        sections: [],
        areas: [],
        people: [],
        settings: {},
      };
      asyncStorageMock.getItem.mockImplementation((key: string) => {
        if (key === 'mindwtr-data:startup-backup-updated-at') return Promise.resolve(staleBackupUpdatedAt);
        if (key === 'mindwtr-data') return Promise.resolve(JSON.stringify(staleBackup));
        return Promise.resolve(null);
      });

      const stalledSave = vi.fn(() => new Promise<void>(() => {}));
      const sqliteAdapterGetData = vi.fn(async () => staleBackup);

      const { mobileStorage, __mobileStorageTestUtils } = await import('./storage-adapter');
      __mobileStorageTestUtils.setSqliteStateForTests({
        adapter: {
          getData: sqliteAdapterGetData,
          saveData: stalledSave,
          saveTask: sqliteAdapterSaveTask,
        } as any,
        client: {},
      });

      void mobileStorage.saveData(staleBackup);
      await vi.advanceTimersByTimeAsync(0);
      expect(stalledSave).toHaveBeenCalledTimes(1);

      const readPromise = mobileStorage.getData();
      const readExpectation = expect(readPromise).rejects.toThrow('JSON backup is older than the latest queued SQLite write');
      await vi.advanceTimersByTimeAsync(6_000);

      await readExpectation;
      expect(sqliteAdapterGetData).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('runs legacy SQLite connection pragmas outside transactions', async () => {
    const directExec = vi.fn((_queries, _readOnly, callback) => callback?.(null, []));
    const transactionStatements: string[] = [];
    const db = {
      exec: directExec,
      transaction: vi.fn((work) => {
        work({
          executeSql: (sql: string, _params: unknown[], success: (_tx: unknown, result: unknown) => void) => {
            transactionStatements.push(sql);
            success(null, { rows: { length: 0, item: () => undefined, _array: [] } });
          },
        });
      }),
    };

    const { __mobileStorageTestUtils } = await import('./storage-adapter');
    const { SQLITE_BASE_SCHEMA } = await import('@mindwtr/core');
    const client = __mobileStorageTestUtils.createLegacyClientForTests(db);
    expect(client.exec).toBeDefined();

    await client.exec?.(SQLITE_BASE_SCHEMA);

    expect(directExec.mock.calls.map(([queries]) => queries[0].sql)).toEqual([
      'PRAGMA journal_mode = WAL',
      'PRAGMA foreign_keys = ON',
      'PRAGMA busy_timeout = 5000',
    ]);
    expect(transactionStatements.some((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS tasks'))).toBe(true);
    expect(transactionStatements.filter((statement) => statement.startsWith('PRAGMA '))).toEqual([]);
  }, 10_000);

  it('ignores an unmarked JSON backup startup snapshot', async () => {
    const staleBackup = {
      tasks: [
        {
          id: 'deleted-task',
          title: 'Deleted task',
          status: 'next',
          tags: [],
          contexts: [],
          createdAt: '2026-06-15T00:00:00.000Z',
          updatedAt: '2026-06-15T00:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    };
    asyncStorageMock.getItem.mockImplementation((key: string) => (
      key === 'mindwtr-data' ? Promise.resolve(JSON.stringify(staleBackup)) : Promise.resolve(null)
    ));

    const { getMobileStartupSnapshotFromBackup } = await import('./storage-adapter');
    const snapshot = await getMobileStartupSnapshotFromBackup();

    expect(snapshot).toBeNull();
  }, 10_000);

  it('preserves people when reading the JSON backup startup snapshot', async () => {
    const backup = {
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      people: [
        {
          id: 'person-1',
          name: 'Alex',
          createdAt: '2026-04-01T00:00:00.000Z',
          updatedAt: '2026-04-01T00:00:00.000Z',
        },
      ],
      settings: {},
    };
    asyncStorageMock.getItem.mockImplementation((key: string) => {
      if (key === 'mindwtr-data:startup-backup-version') {
        return Promise.resolve('2');
      }
      if (key === 'mindwtr-data') {
        return Promise.resolve(JSON.stringify(backup));
      }
      return Promise.resolve(null);
    });

    const { getMobileStartupSnapshotFromBackup } = await import('./storage-adapter');
    const snapshot = await getMobileStartupSnapshotFromBackup();

    expect(snapshot?.people).toEqual(backup.people);
  }, 10_000);
});
