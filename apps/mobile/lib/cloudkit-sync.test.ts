import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ensureCloudKitReady,
    readRemoteCloudKit,
    writeRemoteCloudKit,
} from './cloudkit-sync';

const currentDir = dirname(fileURLToPath(import.meta.url));
const swiftMapperSource = readFileSync(
    resolve(currentDir, '../modules/cloudkit-sync/ios/CloudKitRecordMapper.swift'),
    'utf8',
);
const macosBridgeSource = readFileSync(
    resolve(currentDir, '../../desktop/src-tauri/src/macos_cloudkit_bridge.m'),
    'utf8',
);

const extractSourceBlock = (source: string, pattern: RegExp, label: string): string => {
    const match = source.match(pattern);
    if (!match?.[1]) throw new Error('Missing ' + label + ' field block');
    return match[1];
};

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

describe('CloudKit native field specs', () => {
    it('maps project purgedAt in Swift and macOS CloudKit mappers', () => {
        const swiftProjectFields = extractSourceBlock(
            swiftMapperSource,
            /private static let projectFieldSpecs: \[FieldSpec\] = \[([\s\S]*?)\n    \]/,
            'Swift project',
        );
        const macosProjectFields = extractSourceBlock(
            macosBridgeSource,
            /static const MWFieldSpec kProjectFields\[\] = \{([\s\S]*?)\n\};/,
            'macOS project',
        );

        expect(swiftProjectFields).toContain('purgedAt');
        expect(macosProjectFields).toContain('purgedAt');
    });

    it('maps project archive restore metadata in Swift and macOS CloudKit mappers', () => {
        const swiftTaskFields = extractSourceBlock(
            swiftMapperSource,
            /private static let taskFieldSpecs: \[FieldSpec\] = \[([\s\S]*?)\n    \]/,
            'Swift task',
        );
        const swiftSectionFields = extractSourceBlock(
            swiftMapperSource,
            /private static let sectionFieldSpecs: \[FieldSpec\] = \[([\s\S]*?)\n    \]/,
            'Swift section',
        );
        const macosTaskFields = extractSourceBlock(
            macosBridgeSource,
            /static const MWFieldSpec kTaskFields\[\] = \{([\s\S]*?)\n\};/,
            'macOS task',
        );
        const macosSectionFields = extractSourceBlock(
            macosBridgeSource,
            /static const MWFieldSpec kSectionFields\[\] = \{([\s\S]*?)\n\};/,
            'macOS section',
        );

        for (const field of [
            'statusBeforeProjectArchive',
            'completedAtBeforeProjectArchive',
            'isFocusedTodayBeforeProjectArchive',
            'projectArchivedAt',
        ]) {
            expect(swiftTaskFields).toContain(field);
            expect(macosTaskFields).toContain(field);
        }

        for (const field of ['deletedAtBeforeProjectArchive', 'projectArchivedAt']) {
            expect(swiftSectionFields).toContain(field);
            expect(macosSectionFields).toContain(field);
        }
    });
});

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
        const controller = new AbortController();
        controller.abort(new Error('Already cancelled'));

        await expect(ensureCloudKitReady({ signal: controller.signal })).rejects.toThrow('Already cancelled');
        expect(cloudKitSync.ensureZone).not.toHaveBeenCalled();
        expect(cloudKitSync.ensureSubscription).not.toHaveBeenCalled();
    });
});
