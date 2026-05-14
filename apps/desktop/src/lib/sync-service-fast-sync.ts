import {
    computeStableValueFingerprint,
    findPendingAttachmentUploads,
    normalizeCloudUrl,
    normalizeWebdavUrl,
    type AppData,
    type CloudProvider,
} from '@mindwtr/core';

import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import type { SyncBackend } from './sync-service-utils';

const FAST_SYNC_STATE_KEY = 'mindwtr-fast-sync-state-v1';

export type FastSyncState = {
    scope: string;
    localFingerprint: string;
    remoteFingerprint: string;
    checkedAt: string;
};

type FastSyncScopeContext = {
    backend: SyncBackend;
    webdavConfig: WebDavConfig | null;
    cloudProvider: CloudProvider;
    cloudConfig: CloudConfig | null;
    dropboxAppKey: string;
};

export function readFastSyncState(scope: string): FastSyncState | null {
    if (typeof localStorage === 'undefined') return null;
    try {
        const raw = localStorage.getItem(FAST_SYNC_STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FastSyncState>;
        if (
            parsed.scope !== scope
            || typeof parsed.localFingerprint !== 'string'
            || typeof parsed.remoteFingerprint !== 'string'
        ) {
            return null;
        }
        return parsed as FastSyncState;
    } catch {
        return null;
    }
}

export function writeFastSyncState(
    state: FastSyncState,
    logWarning: (message: string, error?: unknown) => void
): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(FAST_SYNC_STATE_KEY, JSON.stringify(state));
    } catch (error) {
        logWarning('Failed to cache sync fast-check state', error);
    }
}

export function clearFastSyncState(): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(FAST_SYNC_STATE_KEY);
    } catch {
        // Best-effort local cache cleanup.
    }
}

export function buildFastSyncScope(context: FastSyncScopeContext): string | null {
    if (context.backend === 'webdav' && context.webdavConfig?.url) {
        return computeStableValueFingerprint({
            backend: 'webdav',
            url: normalizeWebdavUrl(context.webdavConfig.url),
            username: context.webdavConfig.username || '',
        });
    }
    if (context.backend === 'cloud' && context.cloudProvider === 'selfhosted' && context.cloudConfig?.url) {
        return computeStableValueFingerprint({
            backend: 'cloud',
            provider: 'selfhosted',
            url: normalizeCloudUrl(context.cloudConfig.url),
            token: context.cloudConfig.token || '',
        });
    }
    if (context.backend === 'cloud' && context.cloudProvider === 'dropbox' && context.dropboxAppKey) {
        return computeStableValueFingerprint({
            backend: 'cloud',
            provider: 'dropbox',
            appKey: context.dropboxAppKey,
            path: '/data.json',
        });
    }
    return null;
}

export function hasPendingSyncSideEffects(data: AppData): boolean {
    return Boolean(data.settings.pendingRemoteWriteAt)
        || findPendingAttachmentUploads(data).length > 0
        || Boolean(data.settings.attachments?.pendingRemoteDeletes?.length);
}
