import { describe, expect, it } from 'vitest';
import { buildFastSyncScope, parseFastSyncState, serializeFastSyncState, type FastSyncState } from './sync-fast-sync';

describe('sync fast state helpers', () => {
    it('parses only matching fast-sync state records', () => {
        const state: FastSyncState = {
            scope: 'scope-a',
            localFingerprint: 'local',
            remoteFingerprint: 'remote',
            checkedAt: '2026-06-10T00:00:00.000Z',
        };
        const raw = serializeFastSyncState(state);

        expect(parseFastSyncState(raw, 'scope-a')).toEqual(state);
        expect(parseFastSyncState(raw, 'scope-b')).toBeNull();
        expect(parseFastSyncState('{"scope":"scope-a"}', 'scope-a')).toBeNull();
        expect(parseFastSyncState('not-json', 'scope-a')).toBeNull();
    });

    it('builds stable scopes for remote sync backends', () => {
        const firstWebdav = buildFastSyncScope({
            backend: 'webdav',
            webdavConfig: { url: 'https://example.com/sync/', username: 'u' },
            cloudProvider: 'selfhosted',
            cloudConfig: null,
        });
        const secondWebdav = buildFastSyncScope({
            backend: 'webdav',
            webdavConfig: { url: 'https://example.com/sync/data.json', username: 'u' },
            cloudProvider: 'selfhosted',
            cloudConfig: null,
        });
        const dropbox = buildFastSyncScope({
            backend: 'cloud',
            webdavConfig: null,
            cloudProvider: 'dropbox',
            cloudConfig: null,
            dropboxClientId: 'client-id',
        });

        expect(firstWebdav).toBe(secondWebdav);
        expect(dropbox).toBeTruthy();
        expect(buildFastSyncScope({
            backend: 'file',
            webdavConfig: null,
            cloudProvider: 'selfhosted',
            cloudConfig: null,
        })).toBeNull();
    });
});
