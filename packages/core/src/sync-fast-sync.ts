import { computeStableValueFingerprint, normalizeCloudUrl, normalizeWebdavUrl } from './sync-helpers';
import type { CloudProvider } from './sync-client-helpers';

export type FastSyncState = {
    scope: string;
    localFingerprint: string;
    remoteFingerprint: string;
    checkedAt: string;
};

export type FastSyncScopeContext = {
    backend: string;
    webdavConfig: { url?: string | null; username?: string | null } | null;
    cloudProvider: CloudProvider | string;
    cloudConfig: { url?: string | null; token?: string | null } | null;
    dropboxAppKey?: string | null;
    dropboxClientId?: string | null;
};

export const parseFastSyncState = (raw: string | null | undefined, scope: string): FastSyncState | null => {
    if (!raw) return null;
    try {
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
};

export const serializeFastSyncState = (state: FastSyncState): string => JSON.stringify(state);

export const buildFastSyncScope = (context: FastSyncScopeContext): string | null => {
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
    const dropboxAppKey = context.dropboxAppKey || context.dropboxClientId || '';
    if (context.backend === 'cloud' && context.cloudProvider === 'dropbox' && dropboxAppKey) {
        return computeStableValueFingerprint({
            backend: 'cloud',
            provider: 'dropbox',
            appKey: dropboxAppKey,
            path: '/data.json',
        });
    }
    return null;
};
