import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';

const fileSystemMock = vi.hoisted(() => {
  let storedText = '';
  return {
    __setStoredText: (value: string) => {
      storedText = value;
    },
    __getStoredText: () => storedText,
    __getUtf8ByteLength: (value: string) => new TextEncoder().encode(value).byteLength,
    StorageAccessFramework: {
      readAsStringAsync: vi.fn(async () => storedText),
      writeAsStringAsync: vi.fn(async (_uri: string, content: string) => {
        storedText = content + storedText.slice(content.length);
      }),
      createFileAsync: vi.fn(),
      readDirectoryAsync: vi.fn(),
      deleteAsync: vi.fn(),
    },
    getInfoAsync: vi.fn().mockResolvedValue({ exists: false }),
    readAsStringAsync: vi.fn(),
    writeAsStringAsync: vi.fn(),
    copyAsync: vi.fn(),
    deleteAsync: vi.fn(),
    moveAsync: vi.fn(),
    cacheDirectory: 'file://cache/',
    documentDirectory: 'file://document/',
  };
});

vi.mock('./file-system', () => fileSystemMock);

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

const expoFilesMock = vi.hoisted(() => new Map<string, string>());

vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return expoFilesMock.has(this.uri);
    }
    create() {
      expoFilesMock.set(this.uri, '');
    }
    write(content: string) {
      expoFilesMock.set(this.uri, content);
    }
    delete() {
      expoFilesMock.delete(this.uri);
    }
    copy(target: { uri: string }) {
      expoFilesMock.set(target.uri, expoFilesMock.get(this.uri) ?? '');
    }
    async text() {
      return expoFilesMock.get(this.uri) ?? '';
    }
  }
  class Directory {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    static pickDirectoryAsync = vi.fn();
  }
  return { Directory, File };
});

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

vi.mock('./app-log', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const bookmarkMocks = vi.hoisted(() => ({
  createSyncPathBookmark: vi.fn(),
  supportsBookmarkedSyncFileIO: vi.fn(() => false),
  readBookmarkedSyncFileText: vi.fn(),
  writeBookmarkedSyncFileText: vi.fn(),
}));

vi.mock('./sync-path-bookmarks', () => bookmarkMocks);

const syncFileUri =
  'content://com.android.externalstorage.documents/tree/primary%3AMindwtr/document/primary%3AMindwtr%2Fdata.json';

const appData = (settings: AppData['settings']): AppData => ({
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  settings,
});

describe('storage-file sync writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemMock.__setStoredText('');
    expoFilesMock.clear();
  });

  it('pads shorter SAF writes so stale bytes cannot corrupt data.json', async () => {
    const previous = JSON.stringify(
      appData({
        syncPreferences: { appearance: true, language: true, gtd: true },
        appearance: { showTaskAge: true },
        weekStart: 'monday',
        dateFormat: 'ymd',
        timeFormat: '24h',
      }),
      null,
      2
    );
    const nextData = appData({
      syncPreferences: { language: true },
      weekStart: 'monday',
    });
    const next = JSON.stringify(nextData, null, 2);
    fileSystemMock.__setStoredText(previous);

    const { writeSyncFile } = await import('./storage-file');

    await writeSyncFile(syncFileUri, nextData);

    const written = fileSystemMock.StorageAccessFramework.writeAsStringAsync.mock.calls[0]?.[1] as string;
    expect(fileSystemMock.__getUtf8ByteLength(written)).toBeGreaterThanOrEqual(
      fileSystemMock.__getUtf8ByteLength(previous)
    );
    expect(written.startsWith(next)).toBe(true);
    expect(written.slice(next.length)).toMatch(/^\s+$/);
    expect(JSON.parse(fileSystemMock.__getStoredText())).toEqual(nextData);
  }, 10_000);
});

describe('iOS sync file bookmarks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    fileSystemMock.__setStoredText('');
    expoFilesMock.clear();
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(false);
    bookmarkMocks.createSyncPathBookmark.mockResolvedValue(null);
    const { Platform } = await import('react-native');
    (Platform as { OS: string }).OS = 'ios';
  });

  afterEach(async () => {
    const { Platform } = await import('react-native');
    (Platform as { OS: string }).OS = 'android';
  });

  it('creates a bookmark when falling back to picking an existing sync file', async () => {
    const { Directory } = await import('expo-file-system');
    (Directory as unknown as { pickDirectoryAsync: ReturnType<typeof vi.fn> })
      .pickDirectoryAsync.mockRejectedValue(new Error('Operation was canceled'));
    const DocumentPicker = await import('expo-document-picker');
    (DocumentPicker.getDocumentAsync as ReturnType<typeof vi.fn>).mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///gdrive/Mindwtr/backup.json' }],
    });
    bookmarkMocks.createSyncPathBookmark.mockResolvedValue('bm-token');
    expoFilesMock.set('file:///gdrive/Mindwtr/backup.json', JSON.stringify(appData({})));

    const { pickAndParseSyncFolder } = await import('./storage-file');
    const result = await pickAndParseSyncFolder();

    expect(bookmarkMocks.createSyncPathBookmark).toHaveBeenCalledWith('file:///gdrive/Mindwtr/backup.json');
    expect(result?.__fileBookmark).toBe('bm-token');
    expect(result?.__fileUri).toBe('file:///gdrive/Mindwtr/backup.json');
  });

  it('writes the sync file through the bookmarked native path when available', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    bookmarkMocks.writeBookmarkedSyncFileText.mockResolvedValue(undefined);

    const { writeSyncFile } = await import('./storage-file');
    const data = appData({});
    await writeSyncFile('file:///gdrive/Mindwtr/backup.json', data, { bookmark: 'bm-token' });

    expect(bookmarkMocks.writeBookmarkedSyncFileText).toHaveBeenCalledWith(
      'bm-token',
      JSON.stringify(data, null, 2)
    );
  });

  it('reads the sync file through the bookmarked native path when available', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    const remote = appData({ weekStart: 'monday' });
    bookmarkMocks.readBookmarkedSyncFileText.mockResolvedValue(JSON.stringify(remote));

    const { readSyncFile } = await import('./storage-file');
    await expect(readSyncFile('file:///gdrive/Mindwtr/backup.json', { bookmark: 'bm-token' }))
      .resolves.toEqual(remote);
  });

  it('falls back to direct file access when the bookmarked read returns null', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    bookmarkMocks.readBookmarkedSyncFileText.mockResolvedValue(null);
    const remote = appData({ weekStart: 'sunday' });
    expoFilesMock.set('file:///gdrive/Mindwtr/backup.json', JSON.stringify(remote));

    const { readSyncFile } = await import('./storage-file');
    await expect(readSyncFile('file:///gdrive/Mindwtr/backup.json', { bookmark: 'bm-token' }))
      .resolves.toEqual(remote);
  });

  it('falls back to direct file access when the bookmarked read fails', async () => {
    bookmarkMocks.supportsBookmarkedSyncFileIO.mockReturnValue(true);
    bookmarkMocks.readBookmarkedSyncFileText.mockRejectedValue(new Error('scope lost'));

    const { readSyncFile } = await import('./storage-file');
    await expect(readSyncFile('file:///gdrive/Mindwtr/backup.json', { bookmark: 'bm-token' }))
      .resolves.toBeNull();
  });
});
