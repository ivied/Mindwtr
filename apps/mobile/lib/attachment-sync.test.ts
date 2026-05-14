import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';

const fileSystemMock = vi.hoisted(() => ({
  __esModule: true,
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  StorageAccessFramework: {
    readDirectoryAsync: vi.fn().mockResolvedValue([]),
    makeDirectoryAsync: vi.fn().mockResolvedValue('content://attachments'),
    createFileAsync: vi.fn().mockResolvedValue('content://attachments/file'),
    readAsStringAsync: vi.fn().mockResolvedValue(''),
    writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
  },
  EncodingType: {
    Base64: 'base64',
  },
  getInfoAsync: vi.fn(),
  makeDirectoryAsync: vi.fn().mockResolvedValue(undefined),
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn().mockResolvedValue(undefined),
  readDirectoryAsync: vi.fn().mockResolvedValue([]),
  deleteAsync: vi.fn().mockResolvedValue(undefined),
  copyAsync: vi.fn().mockResolvedValue(undefined),
  moveAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('expo-file-system/legacy', () => fileSystemMock);

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@mindwtr/core', () => ({
  validateAttachmentForUpload: vi.fn().mockResolvedValue({ valid: true }),
  cloudGetFile: vi.fn(),
  cloudDeleteFile: vi.fn(),
  cloudPutFile: vi.fn(),
  isAbortError: vi.fn().mockReturnValue(false),
  computeSha256Hex: vi.fn().mockResolvedValue(null),
  globalProgressTracker: {
    updateProgress: vi.fn(),
  },
  webdavGetFile: vi.fn(),
  webdavFileExists: vi.fn(),
  webdavMakeDirectory: vi.fn(),
  webdavPutFile: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => await fn()),
  createWebdavDownloadBackoff: vi.fn(() => ({
    getBlockedUntil: vi.fn().mockReturnValue(null),
    setFromError: vi.fn(),
    prune: vi.fn(),
    deleteEntry: vi.fn(),
  })),
  isWebdavRateLimitedError: vi.fn().mockReturnValue(false),
  getErrorStatus: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./dropbox-sync', () => ({
  DropboxFileNotFoundError: class DropboxFileNotFoundError extends Error {},
  DropboxUnauthorizedError: class DropboxUnauthorizedError extends Error {},
  downloadDropboxFile: vi.fn(),
  uploadDropboxFile: vi.fn(),
}));

vi.mock('./dropbox-auth', () => ({
  forceRefreshDropboxAccessToken: vi.fn().mockResolvedValue('dropbox-token'),
  getValidDropboxAccessToken: vi.fn().mockResolvedValue('dropbox-token'),
}));

vi.mock('./app-log', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  sanitizeLogMessage: (value: string) => value,
}));

describe('attachment sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemMock.makeDirectoryAsync.mockResolvedValue(undefined);
    fileSystemMock.copyAsync.mockResolvedValue(undefined);
    fileSystemMock.moveAsync.mockResolvedValue(undefined);
    fileSystemMock.writeAsStringAsync.mockResolvedValue(undefined);
    fileSystemMock.deleteAsync.mockResolvedValue(undefined);
    fileSystemMock.readAsStringAsync.mockReset();
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockResolvedValue([]);
    fileSystemMock.StorageAccessFramework.makeDirectoryAsync.mockResolvedValue('content://attachments');
    fileSystemMock.StorageAccessFramework.createFileAsync.mockResolvedValue('content://attachments/file');
    fileSystemMock.StorageAccessFramework.writeAsStringAsync.mockResolvedValue(undefined);
  });

  it('persists generic Android content uris by staging them to a temp file first', async () => {
    const contentUri = 'content://com.android.providers.downloads.documents/document/msf%3A1000006030';
    fileSystemMock.getInfoAsync
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValueOnce({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync
      .mockRejectedValueOnce(new Error(`Unsupported scheme for location '${contentUri}'.`))
      .mockResolvedValueOnce('AQID');

    const { persistAttachmentLocally } = await import('./attachment-sync');

    const result = await persistAttachmentLocally({
      id: 'att-1',
      kind: 'file',
      title: 'Embosser.png',
      uri: contentUri,
      createdAt: '2026-03-06T05:14:32.399Z',
      updatedAt: '2026-03-06T05:14:32.399Z',
    });

    expect(fileSystemMock.copyAsync).toHaveBeenCalledTimes(1);
    expect(fileSystemMock.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        from: contentUri,
        to: expect.stringMatching(/^file:\/\/cache\/content-read-/),
      })
    );
    expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/cache\/content-read-/),
      { idempotent: true }
    );
    expect(result.uri).toBe('file://document/attachments/att-1.png');
    expect(result.localStatus).toBe('available');
    expect(result.size).toBe(3);
  });

  it('reuses an existing SAF attachments directory even when Android returns it with a trailing slash', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';

    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { resolveFileSyncDir } = await import('./attachment-sync-utils');

    const resolved = await resolveFileSyncDir(syncFileUri);

    expect(resolved).toEqual({
      type: 'saf',
      dirUri: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup',
      attachmentsDirUri,
    });
    expect(fileSystemMock.StorageAccessFramework.makeDirectoryAsync).not.toHaveBeenCalled();
  });

  it('avoids creating duplicate SAF attachments folders on repeated file-sync attachment checks', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const remoteFileUri = `${attachmentsDirUri}f7d7d7-photo.jpg`;

    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [remoteFileUri];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });

    const { syncFileAttachments } = await import('./attachment-sync');

    const didMutate = await syncFileAttachments({
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'f7d7d7-photo',
              kind: 'file',
              title: 'photo.jpg',
              uri: 'file://document/attachments/f7d7d7-photo.jpg',
              cloudKey: 'attachments/f7d7d7-photo.jpg',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    }, syncFileUri);

    expect(didMutate).toBe(false);
    expect(fileSystemMock.StorageAccessFramework.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('uploads a pending SAF file attachment into the existing attachments directory', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const createdRemoteFileUri = `${attachmentsDirUri}upload-me.jpg`;

    fileSystemMock.getInfoAsync.mockImplementation(async (uri: string) => ({
      exists: uri === 'file://document/attachments/upload-me.jpg',
      size: uri === 'file://document/attachments/upload-me.jpg' ? 3 : 0,
    }));
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });
    fileSystemMock.StorageAccessFramework.createFileAsync.mockResolvedValue(createdRemoteFileUri);

    const { syncFileAttachments } = await import('./attachment-sync');

    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'upload-me',
              kind: 'file' as const,
              title: 'photo.jpg',
              uri: 'file://document/attachments/upload-me.jpg',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const didMutate = await syncFileAttachments(appData, syncFileUri);
    const attachment = appData.tasks[0].attachments?.[0];

    expect(didMutate).toBe(true);
    expect(attachment?.cloudKey).toBe('attachments/upload-me.jpg');
    expect(fileSystemMock.StorageAccessFramework.makeDirectoryAsync).not.toHaveBeenCalled();
    expect(fileSystemMock.StorageAccessFramework.createFileAsync).toHaveBeenCalledWith(
      attachmentsDirUri,
      'upload-me.jpg',
      'application/octet-stream'
    );
    expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
      createdRemoteFileUri,
      'AQID',
      { encoding: 'base64' }
    );
  });

  it('aborts file attachment sync before writing stale bytes', async () => {
    const syncFileUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fdata.json';
    const attachmentsDirUri = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2FMindwtr%20Backup/document/primary%3ADocuments%2FMindwtr%20Backup%2Fattachments/';
    const controller = new AbortController();

    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.StorageAccessFramework.readDirectoryAsync.mockImplementation(async (uri: string) => {
      if (uri === attachmentsDirUri) {
        return [];
      }
      if (uri.includes('primary%3ADocuments%2FMindwtr%20Backup')) {
        return [attachmentsDirUri];
      }
      return [];
    });
    fileSystemMock.readAsStringAsync.mockImplementation(async () => {
      controller.abort('File attachment sync cancelled');
      return 'AQID';
    });

    const { syncFileAttachments } = await import('./attachment-sync');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'upload-me',
              kind: 'file',
              title: 'photo.jpg',
              uri: 'file://document/attachments/upload-me.jpg',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    await expect(syncFileAttachments(appData, syncFileUri, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'File attachment sync cancelled',
    });
    expect(fileSystemMock.StorageAccessFramework.writeAsStringAsync).not.toHaveBeenCalled();
  });

  it('passes abort signals through WebDAV attachment transfers', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    vi.mocked(core.webdavPutFile).mockResolvedValue(undefined);
    vi.mocked(core.webdavFileExists).mockResolvedValue(false);

    const controller = new AbortController();
    const { syncWebdavAttachments } = await import('./attachment-sync');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'webdav-upload',
              kind: 'file',
              title: 'photo.jpg',
              uri: 'file://document/attachments/webdav-upload.jpg',
              localStatus: 'available',
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    await syncWebdavAttachments(
      appData,
      { url: 'https://example.com/data.json', username: 'u', password: 'p' },
      'https://example.com',
      controller.signal
    );

    expect(core.webdavMakeDirectory).toHaveBeenCalledWith('https://example.com/attachments', expect.objectContaining({
      signal: controller.signal,
    }));
    expect(core.webdavPutFile).toHaveBeenCalledWith(
      'https://example.com/attachments/webdav-upload.jpg',
      expect.any(ArrayBuffer),
      'application/octet-stream',
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it('cleans up a cloud upload when local data changes before metadata is stamped', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const abortError = new Error('Local changes detected during sync');
    let assertCalls = 0;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'race',
              kind: 'file' as const,
              title: 'race.txt',
              uri: 'file://document/attachments/race.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = await import('./attachment-sync');

    await expect(syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1',
      {
        assertCurrent: () => {
          assertCalls += 1;
          if (assertCalls > 1) throw abortError;
        },
      }
    )).rejects.toBe(abortError);

    expect(core.cloudPutFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/race.txt',
      expect.any(ArrayBuffer),
      'application/octet-stream',
      { token: 'token' }
    );
    expect(core.cloudDeleteFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/race.txt',
      { token: 'token' }
    );
    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('propagates abort signals into cloud attachment uploads', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const abortController = new AbortController();
    const uploadError = new Error('Upload aborted by sync lifecycle');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'mid-upload',
              kind: 'file' as const,
              title: 'mid-upload.txt',
              uri: 'file://document/attachments/mid-upload.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    vi.mocked(core.cloudPutFile).mockImplementationOnce(async (_url, _data, _contentType, options) => {
      expect(options?.signal).toBe(abortController.signal);
      abortController.abort();
      throw uploadError;
    });

    const { syncCloudAttachments } = await import('./attachment-sync');

    await expect(syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1',
      { signal: abortController.signal }
    )).rejects.toBe(uploadError);

    expect(core.cloudDeleteFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/mid-upload.txt',
      { token: 'token' }
    );
    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('propagates abort signals from Dropbox attachment uploads', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const dropbox = await import('./dropbox-sync');
    const abortController = new AbortController();
    const uploadError = new Error('Dropbox upload aborted by sync lifecycle');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'dropbox-mid-upload',
              kind: 'file' as const,
              title: 'dropbox-mid-upload.txt',
              uri: 'file://document/attachments/dropbox-mid-upload.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    vi.mocked(dropbox.uploadDropboxFile).mockImplementationOnce(async () => {
      abortController.abort();
      throw uploadError;
    });

    const { syncDropboxAttachments } = await import('./attachment-sync');

    await expect(syncDropboxAttachments(
      appData,
      'dropbox-client-id',
      fetch,
      { signal: abortController.signal }
    )).rejects.toBe(uploadError);

    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
  });

  it('does not leave partial cloud metadata when a later attachment aborts the batch', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const abortError = new Error('Local changes detected during sync');
    let assertCalls = 0;
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'first',
              kind: 'file' as const,
              title: 'first.txt',
              uri: 'file://document/attachments/first.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
            {
              id: 'second',
              kind: 'file' as const,
              title: 'second.txt',
              uri: 'file://document/attachments/second.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };

    const { syncCloudAttachments } = await import('./attachment-sync');

    await expect(syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1',
      {
        assertCurrent: () => {
          assertCalls += 1;
          if (assertCalls > 3) throw abortError;
        },
      }
    )).rejects.toBe(abortError);

    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBeUndefined();
    expect(appData.tasks[0].attachments?.[1]?.cloudKey).toBeUndefined();
    expect(core.cloudDeleteFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/second.txt',
      { token: 'token' }
    );
    expect(core.cloudDeleteFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/first.txt',
      { token: 'token' }
    );
  });

  it('cleans up uncertain cloud uploads after a network failure without dropping earlier successful metadata', async () => {
    fileSystemMock.getInfoAsync.mockResolvedValue({ exists: true, size: 3 });
    fileSystemMock.readAsStringAsync.mockResolvedValue('AQID');
    const core = await import('@mindwtr/core');
    const networkError = new Error('network flap');
    const appData: AppData = {
      tasks: [
        {
          id: 'task-1',
          title: 'Task',
          status: 'inbox',
          tags: [],
          contexts: [],
          attachments: [
            {
              id: 'first',
              kind: 'file' as const,
              title: 'first.txt',
              uri: 'file://document/attachments/first.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
            {
              id: 'second',
              kind: 'file' as const,
              title: 'second.txt',
              uri: 'file://document/attachments/second.txt',
              localStatus: 'available' as const,
              createdAt: '2026-04-18T10:00:00.000Z',
              updatedAt: '2026-04-18T10:00:00.000Z',
            },
          ],
          createdAt: '2026-04-18T10:00:00.000Z',
          updatedAt: '2026-04-18T10:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    };
    vi.mocked(core.cloudPutFile)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(networkError);

    const { syncCloudAttachments } = await import('./attachment-sync');

    const didMutate = await syncCloudAttachments(
      appData,
      { url: 'https://cloud.example/v1/data', token: 'token' },
      'https://cloud.example/v1'
    );

    expect(didMutate).toBe(true);
    expect(appData.tasks[0].attachments?.[0]?.cloudKey).toBe('attachments/first.txt');
    expect(appData.tasks[0].attachments?.[1]?.cloudKey).toBeUndefined();
    expect(core.cloudDeleteFile).toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/second.txt',
      { token: 'token' }
    );
    expect(core.cloudDeleteFile).not.toHaveBeenCalledWith(
      'https://cloud.example/v1/attachments/first.txt',
      { token: 'token' }
    );
  });
});
