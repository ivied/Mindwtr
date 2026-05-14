import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    asyncStorageGetItem,
    asyncStorageRemoveItem,
    asyncStorageSetItem,
    cloudKitSync,
} = vi.hoisted(() => ({
    asyncStorageGetItem: vi.fn(async () => null as string | null),
    asyncStorageRemoveItem: vi.fn(async () => undefined),
    asyncStorageSetItem: vi.fn(async () => undefined),
    cloudKitSync: {
        addListener: vi.fn(),
        consumePendingRemoteChange: vi.fn(async () => false),
        deleteRecords: vi.fn(),
        ensureSubscription: vi.fn(async () => undefined),
        ensureZone: vi.fn(async () => undefined),
        fetchAllRecords: vi.fn(),
        fetchChanges: vi.fn(),
        getAccountStatus: vi.fn(async () => 'available'),
        saveRecords: vi.fn(),
    },
}));

vi.mock('expo-modules-core', () => ({
    requireNativeModule: vi.fn(() => cloudKitSync),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: asyncStorageGetItem,
        removeItem: asyncStorageRemoveItem,
        setItem: asyncStorageSetItem,
    },
}));

vi.mock('./app-log', () => ({
    logError: vi.fn(async () => undefined),
    logInfo: vi.fn(async () => undefined),
    logWarn: vi.fn(async () => undefined),
}));

const createPendingPromise = <T,>() => new Promise<T>(() => undefined);

describe('cloudkit-sync abort handling', () => {
    beforeEach(() => {
        asyncStorageGetItem.mockReset();
        asyncStorageGetItem.mockResolvedValue(null);
        asyncStorageRemoveItem.mockClear();
        asyncStorageSetItem.mockClear();
        cloudKitSync.addListener.mockClear();
        cloudKitSync.consumePendingRemoteChange.mockClear();
        cloudKitSync.deleteRecords.mockReset();
        cloudKitSync.ensureSubscription.mockReset();
        cloudKitSync.ensureSubscription.mockResolvedValue(undefined);
        cloudKitSync.ensureZone.mockReset();
        cloudKitSync.ensureZone.mockResolvedValue(undefined);
        cloudKitSync.fetchAllRecords.mockReset();
        cloudKitSync.fetchAllRecords.mockResolvedValue([]);
        cloudKitSync.fetchChanges.mockReset();
        cloudKitSync.fetchChanges.mockResolvedValue({ records: {}, deletedIDs: {}, changeToken: 'token-1' });
        cloudKitSync.getAccountStatus.mockReset();
        cloudKitSync.getAccountStatus.mockResolvedValue('available');
        cloudKitSync.saveRecords.mockReset();
        cloudKitSync.saveRecords.mockResolvedValue([]);
    });

    it('rejects CloudKit reads when the sync lifecycle aborts mid-fetch', async () => {
        const { readRemoteCloudKit } = await import('./cloudkit-sync');
        const controller = new AbortController();
        const abortReason = new Error('Sync lifecycle aborted');
        cloudKitSync.fetchAllRecords.mockImplementation(() => createPendingPromise());

        const promise = readRemoteCloudKit({ signal: controller.signal });
        await Promise.resolve();
        controller.abort(abortReason);

        await expect(promise).rejects.toBe(abortReason);
        expect(cloudKitSync.fetchAllRecords).toHaveBeenCalled();
    });

    it('rejects CloudKit writes when the sync lifecycle aborts mid-save', async () => {
        const { writeRemoteCloudKit } = await import('./cloudkit-sync');
        const controller = new AbortController();
        const abortReason = new Error('Sync lifecycle aborted');
        cloudKitSync.saveRecords.mockImplementation(() => createPendingPromise());

        const promise = writeRemoteCloudKit({
            tasks: [{
                id: 'task-1',
                title: 'Task',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-05-01T00:00:00.000Z',
            }],
            projects: [],
            sections: [],
            areas: [],
            settings: {},
        }, { signal: controller.signal });
        await Promise.resolve();
        controller.abort(abortReason);

        await expect(promise).rejects.toBe(abortReason);
        expect(cloudKitSync.saveRecords).toHaveBeenCalled();
    });

    it('does not start CloudKit setup when the signal is already aborted', async () => {
        const { ensureCloudKitReady } = await import('./cloudkit-sync');
        const controller = new AbortController();
        controller.abort(new Error('Already cancelled'));

        await expect(ensureCloudKitReady({ signal: controller.signal })).rejects.toThrow('Already cancelled');
        expect(cloudKitSync.ensureZone).not.toHaveBeenCalled();
        expect(cloudKitSync.ensureSubscription).not.toHaveBeenCalled();
    });
});
