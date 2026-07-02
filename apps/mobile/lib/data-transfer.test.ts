import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';
import type { ParsedTodoistProject } from '@mindwtr/core/todoist-import';

const emptyData: AppData = {
  tasks: [],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
};

const storageMocks = vi.hoisted(() => ({
  getData: vi.fn(),
  saveData: vi.fn(),
}));

const storeStateRef = vi.hoisted(() => ({
  current: {
    lastDataChangeAt: 1,
    fetchData: vi.fn(),
  },
}));

const coreMocks = vi.hoisted(() => ({
  flushPendingSave: vi.fn(),
  useTaskStoreGetState: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

const fileSystemMocks = vi.hoisted(() => ({
  fileWrites: [] as string[],
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    flushPendingSave: coreMocks.flushPendingSave,
    useTaskStore: {
      getState: coreMocks.useTaskStoreGetState,
    },
  };
});

vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(),
}));

vi.mock('./file-system', () => ({
  StorageAccessFramework: null,
  documentDirectory: 'file://document/',
  cacheDirectory: 'file://cache/',
  readAsStringAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  EncodingType: {
    Base64: 'base64',
  },
}));

vi.mock('expo-file-system', () => ({
  Paths: {
    document: {
      uri: 'file://document',
    },
  },
  Directory: class Directory {
    uri: string;
    exists = true;

    constructor(uri: string) {
      this.uri = uri;
    }

    create() {}
    list() { return []; }
  },
  File: class File {
    uri: string;
    exists = false;

    constructor(uri: string) {
      this.uri = uri;
    }

    create() {}
    delete() {}
    write(text: string) { fileSystemMocks.fileWrites.push(text); }
    async text() { return '{}'; }
    async bytes() { return new Uint8Array(); }
  },
}));

vi.mock('./storage-adapter', () => ({
  mobileStorage: {
    getData: storageMocks.getData,
    saveData: storageMocks.saveData,
  },
}));

vi.mock('./app-log', () => ({
  logError: logMocks.logError,
  logInfo: logMocks.logInfo,
}));

import { importTodoistData } from './data-transfer';

const parsedProjects: ParsedTodoistProject[] = [{
  name: 'Todoist',
  sections: [],
  checklistItemCount: 0,
  recurringCount: 0,
  tasks: [{
    title: 'Imported task',
    tags: [],
    checklist: [],
  }],
}];

describe('mobile data transfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileSystemMocks.fileWrites = [];
    storeStateRef.current = {
      lastDataChangeAt: 1,
      fetchData: vi.fn().mockResolvedValue(undefined),
    };
    coreMocks.flushPendingSave.mockResolvedValue(undefined);
    coreMocks.useTaskStoreGetState.mockImplementation(() => storeStateRef.current);
    storageMocks.getData.mockResolvedValue(emptyData);
    storageMocks.saveData.mockResolvedValue(undefined);
  });

  it('aborts Todoist import when local data changes before the full snapshot write', async () => {
    storageMocks.getData.mockImplementation(async () => {
      storeStateRef.current = {
        ...storeStateRef.current,
        lastDataChangeAt: 2,
      };
      return emptyData;
    });

    await expect(importTodoistData(parsedProjects)).rejects.toMatchObject({
      name: 'LocalSyncAbort',
    });

    expect(storageMocks.saveData).not.toHaveBeenCalled();
    expect(storeStateRef.current.fetchData).not.toHaveBeenCalled();
    expect(logMocks.logInfo).toHaveBeenCalledWith(
      'Data transfer aborted after local data changed',
      expect.objectContaining({
        scope: 'transfer',
        extra: expect.objectContaining({
          operation: 'importTodoist',
          snapshotChangeAt: '1',
          currentChangeAt: '2',
        }),
      })
    );
  });
});
