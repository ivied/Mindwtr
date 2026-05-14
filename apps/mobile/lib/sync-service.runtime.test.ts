import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { computeStableValueFingerprint, computeSyncPayloadFingerprint, type AppData } from '@mindwtr/core';

const emptyData = {
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  settings: {},
};

const emptyStats = {
  tasks: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  projects: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  sections: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
  areas: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
};

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

const networkMocks = vi.hoisted(() => ({
  getNetworkStateAsync: vi.fn(),
  addNetworkStateListener: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  getData: vi.fn(),
  saveData: vi.fn(),
}));

const attachmentSyncMocks = vi.hoisted(() => ({
  getBaseSyncUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
  getCloudBaseUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
  syncCloudAttachments: vi.fn(),
  syncDropboxAttachments: vi.fn(),
  syncFileAttachments: vi.fn(),
  syncWebdavAttachments: vi.fn(),
  cleanupAttachmentTempFiles: vi.fn(),
}));

const externalCalendarMocks = vi.hoisted(() => ({
  getExternalCalendars: vi.fn(),
  saveExternalCalendars: vi.fn(),
}));

const dropboxAuthMocks = vi.hoisted(() => ({
  forceRefreshDropboxAccessToken: vi.fn(),
  getValidDropboxAccessToken: vi.fn(),
  isDropboxConnected: vi.fn(),
}));

const dropboxSyncMocks = vi.hoisted(() => ({
  deleteDropboxFile: vi.fn(),
  downloadDropboxAppData: vi.fn(),
  getDropboxAppDataMetadata: vi.fn(),
  uploadDropboxAppData: vi.fn(),
}));

const storageFileMocks = vi.hoisted(() => ({
  readSyncFile: vi.fn(),
  resolveSyncFileUri: vi.fn(),
  writeSyncFile: vi.fn(),
}));

const syncPathBookmarkMocks = vi.hoisted(() => ({
  resolveSyncPathBookmark: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logSyncError: vi.fn(),
  logWarn: vi.fn(),
}));

const storeStateRef = vi.hoisted(() => ({
  current: {
    lastDataChangeAt: 1,
    settings: {},
    fetchData: vi.fn(),
    updateSettings: vi.fn(),
    setError: vi.fn(),
  },
}));

const coreMocks = vi.hoisted(() => ({
  webdavGetJson: vi.fn(),
  webdavHeadFile: vi.fn(),
  webdavPutJson: vi.fn(),
  cloudGetJson: vi.fn(),
  cloudHeadJson: vi.fn(),
  cloudPutJson: vi.fn(),
  withRetry: vi.fn(),
  flushPendingSave: vi.fn(),
  performSyncCycle: vi.fn(),
  webdavDeleteFile: vi.fn(),
  cloudDeleteFile: vi.fn(),
  getInMemoryAppDataSnapshot: vi.fn(),
  useTaskStoreGetState: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageMocks.getItem,
    setItem: asyncStorageMocks.setItem,
    removeItem: asyncStorageMocks.removeItem,
  },
}));

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        isFossBuild: true,
      },
    },
  },
}));

vi.mock('expo-network', () => ({
  getNetworkStateAsync: networkMocks.getNetworkStateAsync,
  addNetworkStateListener: networkMocks.addNetworkStateListener,
}));

vi.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  deleteAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./storage-adapter', () => ({
  mobileStorage: {
    getData: storageMocks.getData,
    saveData: storageMocks.saveData,
  },
}));

vi.mock('./attachment-sync', () => ({
  getBaseSyncUrl: attachmentSyncMocks.getBaseSyncUrl,
  getCloudBaseUrl: attachmentSyncMocks.getCloudBaseUrl,
  syncCloudAttachments: attachmentSyncMocks.syncCloudAttachments,
  syncDropboxAttachments: attachmentSyncMocks.syncDropboxAttachments,
  syncFileAttachments: attachmentSyncMocks.syncFileAttachments,
  syncWebdavAttachments: attachmentSyncMocks.syncWebdavAttachments,
  cleanupAttachmentTempFiles: attachmentSyncMocks.cleanupAttachmentTempFiles,
}));

vi.mock('./external-calendar', () => ({
  getExternalCalendars: externalCalendarMocks.getExternalCalendars,
  saveExternalCalendars: externalCalendarMocks.saveExternalCalendars,
}));

vi.mock('./dropbox-auth', () => ({
  forceRefreshDropboxAccessToken: dropboxAuthMocks.forceRefreshDropboxAccessToken,
  getValidDropboxAccessToken: dropboxAuthMocks.getValidDropboxAccessToken,
  isDropboxConnected: dropboxAuthMocks.isDropboxConnected,
}));

vi.mock('./dropbox-sync', () => ({
  DropboxConflictError: class DropboxConflictError extends Error {},
  DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
  deleteDropboxFile: dropboxSyncMocks.deleteDropboxFile,
  downloadDropboxAppData: dropboxSyncMocks.downloadDropboxAppData,
  getDropboxAppDataMetadata: dropboxSyncMocks.getDropboxAppDataMetadata,
  uploadDropboxAppData: dropboxSyncMocks.uploadDropboxAppData,
}));

vi.mock('./storage-file', () => ({
  readSyncFile: storageFileMocks.readSyncFile,
  resolveSyncFileUri: storageFileMocks.resolveSyncFileUri,
  writeSyncFile: storageFileMocks.writeSyncFile,
}));

vi.mock('./sync-path-bookmarks', () => ({
  resolveSyncPathBookmark: syncPathBookmarkMocks.resolveSyncPathBookmark,
}));

vi.mock('./app-log', () => ({
  logInfo: logMocks.logInfo,
  logSyncError: logMocks.logSyncError,
  logWarn: logMocks.logWarn,
  sanitizeLogMessage: (value: string) => value,
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    webdavGetJson: coreMocks.webdavGetJson,
    webdavHeadFile: coreMocks.webdavHeadFile,
    webdavPutJson: coreMocks.webdavPutJson,
    cloudGetJson: coreMocks.cloudGetJson,
    cloudHeadJson: coreMocks.cloudHeadJson,
    cloudPutJson: coreMocks.cloudPutJson,
    withRetry: coreMocks.withRetry,
    flushPendingSave: coreMocks.flushPendingSave,
    performSyncCycle: coreMocks.performSyncCycle,
    webdavDeleteFile: coreMocks.webdavDeleteFile,
    cloudDeleteFile: coreMocks.cloudDeleteFile,
    getInMemoryAppDataSnapshot: coreMocks.getInMemoryAppDataSnapshot,
    useTaskStore: {
      getState: coreMocks.useTaskStoreGetState,
    },
  };
});

let syncServiceModule: Awaited<typeof import('./sync-service')>;

describe('mobile sync-service runtime', () => {
  beforeAll(async () => {
    syncServiceModule = await import('./sync-service');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (Platform as { OS: string }).OS = 'web';

    storeStateRef.current = {
      lastDataChangeAt: 1,
      settings: {},
      fetchData: vi.fn().mockResolvedValue(undefined),
      updateSettings: vi.fn().mockResolvedValue(undefined),
      setError: vi.fn(),
    };

    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'webdav',
        '@mindwtr_webdav_url': 'https://sync.example.com/data.json',
        '@mindwtr_webdav_username': 'user',
        '@mindwtr_webdav_password': 'pass',
      };
      return values[key] ?? null;
    });
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    asyncStorageMocks.removeItem.mockResolvedValue(undefined);

    networkMocks.getNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      isInternetReachable: true,
      isAirplaneModeEnabled: false,
    });
    networkMocks.addNetworkStateListener.mockReturnValue({ remove: vi.fn() });

    storageMocks.getData.mockResolvedValue(emptyData);
    storageMocks.saveData.mockResolvedValue(undefined);
    storageFileMocks.readSyncFile.mockResolvedValue(null);
    storageFileMocks.resolveSyncFileUri.mockImplementation(async (uri: string) => uri);
    storageFileMocks.writeSyncFile.mockResolvedValue(undefined);
    syncPathBookmarkMocks.resolveSyncPathBookmark.mockResolvedValue(null);

    attachmentSyncMocks.syncCloudAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncDropboxAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncFileAttachments.mockResolvedValue(false);
    attachmentSyncMocks.syncWebdavAttachments.mockResolvedValue(false);
    attachmentSyncMocks.cleanupAttachmentTempFiles.mockResolvedValue(undefined);

    externalCalendarMocks.getExternalCalendars.mockResolvedValue([]);
    externalCalendarMocks.saveExternalCalendars.mockResolvedValue(undefined);

    dropboxAuthMocks.forceRefreshDropboxAccessToken.mockResolvedValue('token');
    dropboxAuthMocks.getValidDropboxAccessToken.mockResolvedValue('token');
    dropboxAuthMocks.isDropboxConnected.mockResolvedValue(false);

    logMocks.logSyncError.mockResolvedValue(null);

    coreMocks.flushPendingSave.mockResolvedValue(undefined);
    coreMocks.withRetry.mockImplementation(async (operation: () => Promise<unknown>) => await operation());
    coreMocks.webdavHeadFile.mockResolvedValue({ exists: true, fingerprint: 'webdav:v1:etag="initial":mtime=:len=2' });
    coreMocks.cloudHeadJson.mockResolvedValue({ exists: true, fingerprint: 'cloud:v1:etag="initial":mtime=:len=2' });
    coreMocks.getInMemoryAppDataSnapshot.mockReturnValue(emptyData);
    coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      const local = await io.readLocal();
      const remote = await io.readRemote();
      let data = remote ?? local;
      const prepared = await io.prepareRemoteWrite?.(data);
      data = prepared ?? data;
      await io.writeLocal(data);
      await io.writeRemote(data);
      return { status: 'success', stats: emptyStats, data };
    });

    syncServiceModule.__mobileSyncTestUtils.reset();
  });

  it('pauses repeated WebDAV sync attempts after a rate limit response', async () => {
    const rateLimitError = Object.assign(new Error('WebDAV GET failed (429): Too Many Requests'), { status: 429 });
    coreMocks.webdavGetJson.mockRejectedValue(rateLimitError);

    const first = await syncServiceModule.performMobileSync();
    expect(first.success).toBe(false);
    expect(first.error).toContain('WebDAV rate limited. Sync paused briefly; try again in about a minute.');
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
    expect(syncServiceModule.__mobileSyncTestUtils.getWebdavSyncBlockedUntil()).toBeGreaterThan(Date.now());

    coreMocks.webdavGetJson.mockResolvedValue(emptyData);

    const second = await syncServiceModule.performMobileSync();
    expect(second.success).toBe(false);
    expect(second.error).toContain('WebDAV rate limited. Sync paused briefly; try again in about a minute.');
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('skips remote sync before start when the device is offline', async () => {
    networkMocks.getNetworkStateAsync.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
      isAirplaneModeEnabled: false,
    });

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'offline' });
    expect(coreMocks.performSyncCycle).not.toHaveBeenCalled();
    expect(coreMocks.webdavGetJson).not.toHaveBeenCalled();
    expect(storeStateRef.current.updateSettings).not.toHaveBeenCalled();
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
  });

  it('continues remote sync when iOS reports connected with uncertain internet reachability', async () => {
    networkMocks.getNetworkStateAsync.mockResolvedValue({
      isConnected: true,
      isInternetReachable: false,
      isAirplaneModeEnabled: false,
    });
    coreMocks.webdavGetJson.mockResolvedValue(emptyData);

    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(coreMocks.performSyncCycle).toHaveBeenCalledTimes(1);
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
  });

  it('skips the full WebDAV merge when local and remote fingerprints are unchanged', async () => {
    const remoteFingerprint = 'webdav:v1:etag="fast":mtime=:len=2';
    const scope = computeStableValueFingerprint({
      backend: 'webdav',
      url: 'https://sync.example.com/data.json',
      username: 'user',
    });
    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'webdav',
        '@mindwtr_webdav_url': 'https://sync.example.com/data.json',
        '@mindwtr_webdav_username': 'user',
        '@mindwtr_webdav_password': 'pass',
        '@mindwtr_fast_sync_state_v1': JSON.stringify({
          scope,
          localFingerprint: computeSyncPayloadFingerprint(emptyData),
          remoteFingerprint,
          checkedAt: '2026-05-07T00:00:00.000Z',
        }),
      };
      return values[key] ?? null;
    });
    coreMocks.webdavHeadFile.mockResolvedValue({
      exists: true,
      fingerprint: remoteFingerprint,
      etag: '"fast"',
      lastModified: null,
      contentLength: '2',
    });

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'unchanged' });
    expect(coreMocks.performSyncCycle).not.toHaveBeenCalled();
    expect(coreMocks.webdavGetJson).not.toHaveBeenCalled();
    expect(coreMocks.webdavHeadFile).toHaveBeenCalledTimes(1);
    expect(storeStateRef.current.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      lastSyncStatus: 'success',
      lastSyncError: undefined,
    }));
  });

  it('reports Dropbox as unavailable in FOSS builds instead of falling through to self-hosted config', async () => {
    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'cloud',
        '@mindwtr_cloud_provider': 'dropbox',
      };
      return values[key] ?? null;
    });

    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Dropbox sync is unavailable in this build');
    expect(coreMocks.performSyncCycle).not.toHaveBeenCalled();
  });

  it('ignores connected reachability-false listener updates during remote sync', async () => {
    networkMocks.addNetworkStateListener.mockImplementation((listener: (state: {
      isConnected?: boolean | null;
      isInternetReachable?: boolean | null;
      isAirplaneModeEnabled?: boolean | null;
    }) => void) => {
      listener({
        isConnected: true,
        isInternetReachable: false,
        isAirplaneModeEnabled: false,
      });
      return { remove: vi.fn() };
    });
    coreMocks.webdavGetJson.mockResolvedValue(emptyData);

    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(coreMocks.performSyncCycle).toHaveBeenCalledTimes(1);
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
  });

  it('skips remote sync when the request fails with an offline network error', async () => {
    coreMocks.webdavGetJson.mockRejectedValue(new TypeError('Network request failed'));

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'offline' });
    expect(coreMocks.performSyncCycle).toHaveBeenCalledTimes(1);
    expect(coreMocks.webdavGetJson).toHaveBeenCalledTimes(1);
    expect(storeStateRef.current.updateSettings).not.toHaveBeenCalled();
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
  });

  it('resolves a stored iOS sync-folder bookmark before using a stale file-sync override path', async () => {
    (Platform as { OS: string }).OS = 'ios';
    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'file',
        '@mindwtr_sync_path': 'file:///stale/MindWtr/data.json',
        '@mindwtr_sync_path_bookmark': 'bookmark-token',
      };
      return values[key] ?? null;
    });
    syncPathBookmarkMocks.resolveSyncPathBookmark.mockResolvedValue('file:///resolved/MindWtr');

    const result = await syncServiceModule.performMobileSync('file:///stale/MindWtr/data.json');

    expect(result.success).toBe(true);
    expect(syncPathBookmarkMocks.resolveSyncPathBookmark).toHaveBeenCalledWith('bookmark-token');
    expect(asyncStorageMocks.setItem).toHaveBeenCalledWith('@mindwtr_sync_path', 'file:///resolved/MindWtr/data.json');
    expect(storageFileMocks.readSyncFile).toHaveBeenCalledWith('file:///resolved/MindWtr/data.json');
    expect(storageFileMocks.writeSyncFile).toHaveBeenCalledWith('file:///resolved/MindWtr/data.json', expect.any(Object));
  });

  it('returns a queued retry result when fresher local edits abort the merge', async () => {
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      const local = await io.readLocal();
      storeStateRef.current = {
        ...storeStateRef.current,
        lastDataChangeAt: 2,
      };
      await io.writeLocal(local);
      return { status: 'success', stats: emptyStats, data: local };
    });

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, skipped: 'requeued' });
    expect(storeStateRef.current.updateSettings).not.toHaveBeenCalled();
    expect(logMocks.logSyncError).not.toHaveBeenCalled();
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Sync detected local data changes during cycle; queued follow-up',
      expect.objectContaining({
        scope: 'sync',
        extra: expect.objectContaining({
          backend: 'webdav',
          snapshotChangeAt: '1',
          currentChangeAt: '2',
        }),
      }),
    );
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Sync requeued after local data changed',
      expect.objectContaining({
        scope: 'sync',
        extra: expect.objectContaining({
          backend: 'webdav',
          wroteLocal: 'false',
        }),
      }),
    );
  });

  it('skips WebDAV writes when remote data only differs by device-local sync history', async () => {
    const localSyncedData = {
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      settings: {
        syncPreferences: { appearance: true },
        syncPreferencesUpdatedAt: {
          appearance: '2026-04-16T00:00:00.000Z',
          preferences: '2026-04-16T00:00:00.000Z',
        },
        theme: 'dark',
        lastSyncHistory: [
          {
            at: '2026-04-16T00:00:00.000Z',
            status: 'success',
            conflicts: 0,
            conflictIds: [],
            maxClockSkewMs: 0,
            timestampAdjustments: 0,
          },
        ],
      },
    };
    const remoteSyncedData = {
      ...localSyncedData,
      settings: {
        syncPreferences: { appearance: true },
        syncPreferencesUpdatedAt: {
          appearance: '2026-04-16T00:00:00.000Z',
          preferences: '2026-04-16T00:00:00.000Z',
        },
        theme: 'dark',
      },
    };

    storageMocks.getData.mockResolvedValue(localSyncedData);
    coreMocks.webdavGetJson.mockResolvedValue(remoteSyncedData);
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      const local = await io.readLocal();
      const remote = await io.readRemote();
      expect(remote).toEqual(remoteSyncedData);
      await io.writeRemote(local);
      await io.writeLocal(local);
      return { status: 'success', stats: emptyStats, data: local };
    });

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, stats: emptyStats });
    expect(coreMocks.webdavPutJson).not.toHaveBeenCalled();
  });

  it('runs a final attachment sync pass before writing remote data when uploads are still pending', async () => {
    const localData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'att-1',
              kind: 'file',
              title: 'doc.txt',
              uri: 'file:///local/doc.txt',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };
    const events: string[] = [];
    let attachmentSyncCalls = 0;

    storageMocks.getData.mockResolvedValue(localData);
    coreMocks.webdavGetJson.mockResolvedValue(null);
    coreMocks.webdavPutJson.mockImplementation(async () => {
      events.push('write-remote');
    });
    attachmentSyncMocks.syncWebdavAttachments.mockImplementation(async (data: any) => {
      attachmentSyncCalls += 1;
      events.push(`sync:${attachmentSyncCalls}`);
      if (attachmentSyncCalls === 1) {
        return false;
      }
      data.tasks[0].attachments[0].cloudKey = 'attachments/att-1.txt';
      data.tasks[0].attachments[0].localStatus = 'available';
      return true;
    });

    const result = await syncServiceModule.performMobileSync();

    expect(result).toEqual({ success: true, stats: emptyStats });
    expect(attachmentSyncMocks.syncWebdavAttachments).toHaveBeenCalledTimes(3);
    expect(events.indexOf('sync:2')).toBeGreaterThan(events.indexOf('sync:1'));
    expect(events.indexOf('write-remote')).toBeGreaterThan(events.indexOf('sync:2'));
    expect(coreMocks.webdavPutJson).toHaveBeenCalledWith(
      'https://sync.example.com/data.json',
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            attachments: [
              expect.objectContaining({
                id: 'att-1',
                cloudKey: 'attachments/att-1.txt',
                uri: '',
              }),
            ],
          }),
        ],
      }),
      expect.objectContaining({
        username: 'user',
        password: 'pass',
      }),
    );
  });

  it('clears stale sync stats when a sync error occurs after prior conflicts', async () => {
    storeStateRef.current = {
      ...storeStateRef.current,
      settings: {
        lastSyncStatus: 'conflict',
        lastSyncStats: {
          tasks: { mergedTotal: 1, conflicts: 3, conflictIds: ['task-1'], maxClockSkewMs: 0, timestampAdjustments: 0 },
          projects: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
          sections: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
          areas: { mergedTotal: 0, conflicts: 0, conflictIds: [], maxClockSkewMs: 0, timestampAdjustments: 0 },
        },
      },
      updateSettings: vi.fn().mockResolvedValue(undefined),
    };
    coreMocks.webdavGetJson.mockRejectedValue(new Error('sync read failed'));

    const result = await syncServiceModule.performMobileSync();

    expect(result.success).toBe(false);
    expect(coreMocks.performSyncCycle).toHaveBeenCalledTimes(1);
    expect(storeStateRef.current.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      lastSyncStatus: 'error',
      lastSyncStats: undefined,
    }));
  });

  it('reports sync activity state while a sync cycle is in flight', async () => {
    let releaseSync!: () => void;
    const syncGate = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });

    coreMocks.webdavGetJson.mockResolvedValue(emptyData);
    coreMocks.performSyncCycle.mockImplementation(async (io: any) => {
      await io.readLocal();
      await io.readRemote();
      await syncGate;
      return { status: 'success', stats: emptyStats, data: emptyData };
    });

    const states: string[] = [];
    const unsubscribe = syncServiceModule.subscribeMobileSyncActivityState((state) => {
      states.push(state);
    });

    const syncPromise = syncServiceModule.performMobileSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states).toContain('syncing');

    releaseSync();
    await syncPromise;
    unsubscribe();

    expect(states[0]).toBe('idle');
    expect(states.at(-1)).toBe('idle');
  });

  it('stops cloud attachment pre-sync when the app lifecycle aborts the sync', async () => {
    const dataWithAttachment: AppData = {
      tasks: [
        {
          id: 'task-attachment',
          title: 'Attachment task',
          status: 'inbox',
          tags: [],
          contexts: [],
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
          attachments: [
            {
              id: 'att-lifecycle',
              kind: 'file',
              title: 'large.txt',
              uri: 'file://document/attachments/large.txt',
              localStatus: 'available',
              createdAt: '2026-05-01T00:00:00.000Z',
              updatedAt: '2026-05-01T00:00:00.000Z',
            },
          ],
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };
    let uploadSignal: AbortSignal | undefined;
    let releaseUploadStart!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUploadStart = resolve;
    });

    asyncStorageMocks.getItem.mockImplementation(async (key: string) => {
      const values: Record<string, string | null> = {
        '@mindwtr_sync_backend': 'cloud',
        '@mindwtr_cloud_provider': 'selfhosted',
        '@mindwtr_cloud_url': 'https://cloud.example/v1/data',
        '@mindwtr_cloud_token': 'token',
      };
      return values[key] ?? null;
    });
    storageMocks.getData.mockResolvedValue(dataWithAttachment);
    coreMocks.getInMemoryAppDataSnapshot.mockReturnValue(dataWithAttachment);
    coreMocks.cloudGetJson.mockResolvedValue(emptyData);
    attachmentSyncMocks.syncCloudAttachments.mockImplementation(async (_data, _config, _baseUrl, options) => {
      uploadSignal = options?.signal;
      releaseUploadStart();
      await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('Upload aborted by lifecycle')), { once: true });
      });
      return false;
    });

    const syncPromise = syncServiceModule.performMobileSync();
    await uploadStarted;

    expect(uploadSignal?.aborted).toBe(false);
    expect(syncServiceModule.abortMobileSync()).toBe(true);

    const result = await syncPromise;

    expect(uploadSignal?.aborted).toBe(true);
    expect(result).toEqual({ success: true });
    expect(coreMocks.cloudGetJson).not.toHaveBeenCalled();
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Sync aborted by app lifecycle transition',
      expect.objectContaining({ scope: 'sync' }),
    );
  });
});
