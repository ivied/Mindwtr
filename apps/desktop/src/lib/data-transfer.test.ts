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

vi.mock('./runtime', () => ({
    isTauriRuntime: () => false,
}));

vi.mock('./storage-adapter-web', () => ({
    webStorage: {
        getData: storageMocks.getData,
        saveData: storageMocks.saveData,
    },
}));

vi.mock('./storage-adapter', () => ({
    tauriStorage: {
        getData: storageMocks.getData,
        saveData: storageMocks.saveData,
    },
}));

vi.mock('./sync-service', () => ({
    SyncService: {
        createDataSnapshot: vi.fn(),
    },
}));

vi.mock('./app-log', () => ({
    logError: logMocks.logError,
    logInfo: logMocks.logInfo,
}));

import { importDesktopTodoistData } from './data-transfer';

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

describe('desktop data transfer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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

        await expect(importDesktopTodoistData(parsedProjects)).rejects.toMatchObject({
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
