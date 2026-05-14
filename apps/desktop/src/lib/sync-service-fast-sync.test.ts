import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppData, SyncBackend } from '@mindwtr/core';

import {
    buildFastSyncScope,
    clearFastSyncState,
    hasPendingSyncSideEffects,
    readFastSyncState,
    writeFastSyncState,
    type FastSyncState,
} from './sync-service-fast-sync';

const emptyData = (settings: AppData['settings'] = {}): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings,
});

const baseScopeContext = {
    backend: 'off' as SyncBackend,
    webdavConfig: null,
    cloudProvider: 'selfhosted' as const,
    cloudConfig: null,
    dropboxAppKey: '',
};

describe('sync-service fast sync helpers', () => {
    afterEach(() => {
        clearFastSyncState();
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('stores and reads scoped fast-sync state', () => {
        const state: FastSyncState = {
            scope: 'scope-a',
            localFingerprint: 'local-a',
            remoteFingerprint: 'remote-a',
            checkedAt: '2026-01-01T00:00:00.000Z',
        };

        writeFastSyncState(state, vi.fn());

        expect(readFastSyncState('scope-a')).toEqual(state);
        expect(readFastSyncState('scope-b')).toBeNull();
    });

    it('normalizes backend configuration into stable scopes', () => {
        const firstWebdav = buildFastSyncScope({
            ...baseScopeContext,
            backend: 'webdav',
            webdavConfig: {
                url: 'https://example.com/mindwtr/',
                username: 'user',
            },
        });
        const secondWebdav = buildFastSyncScope({
            ...baseScopeContext,
            backend: 'webdav',
            webdavConfig: {
                url: 'https://example.com/mindwtr',
                username: 'user',
            },
        });
        const cloud = buildFastSyncScope({
            ...baseScopeContext,
            backend: 'cloud',
            cloudConfig: {
                url: 'https://cloud.example.com/sync/',
                token: 'token',
            },
        });

        expect(firstWebdav).toBe(secondWebdav);
        expect(cloud).toBeTruthy();
        expect(buildFastSyncScope(baseScopeContext)).toBeNull();
    });

    it('blocks fast unchanged skips when local side effects are pending', () => {
        expect(hasPendingSyncSideEffects(emptyData())).toBe(false);
        expect(hasPendingSyncSideEffects(emptyData({ pendingRemoteWriteAt: '2026-01-01T00:00:00.000Z' }))).toBe(true);
        expect(hasPendingSyncSideEffects(emptyData({
            attachments: {
                pendingRemoteDeletes: [{ cloudKey: 'attachments/old.txt' }],
            },
        }))).toBe(true);
        expect(hasPendingSyncSideEffects({
            ...emptyData(),
            tasks: [{
                id: 'task-1',
                title: 'Task',
                status: 'inbox',
                tags: [],
                contexts: [],
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                attachments: [{
                    id: 'att-1',
                    kind: 'file',
                    title: 'doc.txt',
                    uri: '/local/doc.txt',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }],
            }],
        })).toBe(true);
    });
});
