import { AppData, StorageAdapter } from '@mindwtr/core';
import { reportError } from './report-error';
import { cloudDataUrl, cloudToken, isOriginMismatchedUrl } from './cloud-target';

const DB_NAME = 'mindwtr';
const STORE_NAME = 'app-data';
const RECORD_KEY = 'main';
const LEGACY_LOCAL_STORAGE_KEY = 'mindwtr-data';
const DB_VERSION = 1;

// LocalStorage keys read by sync-service-config.ts
const SYNC_BACKEND_KEY = 'mindwtr-sync-backend';
const CLOUD_URL_KEY = 'mindwtr-cloud-url';
const CLOUD_TOKEN_KEY = 'mindwtr-cloud-token';
const CLOUD_PROVIDER_KEY = 'mindwtr-cloud-provider';

const EMPTY_DATA: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolvePromise, rejectPromise) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolvePromise(request.result);
        request.onerror = () => rejectPromise(request.error ?? new Error('IndexedDB open failed'));
        request.onblocked = () => rejectPromise(new Error('IndexedDB open blocked'));
    });
    return dbPromise;
};

const idbGet = async (): Promise<AppData | null> => {
    const db = await openDb();
    return new Promise<AppData | null>((resolvePromise, rejectPromise) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(RECORD_KEY);
        req.onsuccess = () => resolvePromise((req.result as AppData | undefined) ?? null);
        req.onerror = () => rejectPromise(req.error ?? new Error('IndexedDB read failed'));
    });
};

const idbPut = async (data: AppData): Promise<void> => {
    const db = await openDb();
    return new Promise<void>((resolvePromise, rejectPromise) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(data, RECORD_KEY);
        tx.oncomplete = () => resolvePromise();
        tx.onerror = () => rejectPromise(tx.error ?? new Error('IndexedDB write failed'));
        tx.onabort = () => rejectPromise(tx.error ?? new Error('IndexedDB write aborted'));
    });
};

const setCloudToken = (token: string): void => {
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(CLOUD_TOKEN_KEY, token);
    } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CLOUD_TOKEN_KEY, token);
    }
};

const hasCloudToken = (): boolean => {
    const fromSession = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(CLOUD_TOKEN_KEY) : null;
    const fromLocal = typeof localStorage !== 'undefined' ? localStorage.getItem(CLOUD_TOKEN_KEY) : null;
    return Boolean(fromSession || fromLocal);
};

// Auto-configure self-hosted cloud sync so a fresh browser (or one carrying a
// stale config from another origin) syncs without any manual Settings step.
// Origin-aware: localhost → localhost:8787, gtd.kurdy.uk → api.kurdy.uk.
const ensureSyncSettingsConfigured = (): void => {
    if (typeof localStorage === 'undefined') return;
    const desiredUrl = cloudDataUrl();
    const currentBackend = localStorage.getItem(SYNC_BACKEND_KEY);
    const currentUrl = localStorage.getItem(CLOUD_URL_KEY);

    // First-time seed: nothing configured yet.
    if (!currentBackend || currentBackend === 'off') {
        localStorage.setItem(SYNC_BACKEND_KEY, 'cloud');
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted');
        localStorage.setItem(CLOUD_URL_KEY, desiredUrl);
        setCloudToken(cloudToken());
        return;
    }

    // Self-heal: a config left over from a different origin (e.g. a
    // localhost URL while now served from gtd.kurdy.uk) would fail with
    // mixed-content / unreachable. Rewrite it to this origin's target.
    if (isOriginMismatchedUrl(currentUrl)) {
        localStorage.setItem(CLOUD_URL_KEY, desiredUrl);
        localStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted');
    }

    // The token lives in sessionStorage (cleared on tab close), so re-seed it
    // whenever it's missing — otherwise sync silently 401s after a restart.
    if (!hasCloudToken()) setCloudToken(cloudToken());
};

const tryBootstrapFromCloud = async (): Promise<AppData | null> => {
    const bootstrapUrl = cloudDataUrl();
    const bootstrapToken = cloudToken();
    if (!bootstrapUrl || !bootstrapToken) return null;
    try {
        const response = await fetch(bootstrapUrl, {
            headers: { Authorization: `Bearer ${bootstrapToken}` },
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!Array.isArray(data?.tasks) || !Array.isArray(data?.projects)) return null;
        data.areas = Array.isArray(data.areas) ? data.areas : [];
        data.sections = Array.isArray(data.sections) ? data.sections : [];
        await idbPut(data);
        // eslint-disable-next-line no-console
        console.log(`[mindwtr] auto-bootstrapped from cloud: ${data.tasks.length} tasks, ${data.projects.length} projects, ${data.areas.length} areas`);
        return data as AppData;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[mindwtr] cloud bootstrap failed', error);
        return null;
    }
};

const migrateFromLocalStorageOnce = async (): Promise<AppData | null> => {
    if (typeof localStorage === 'undefined') return null;
    const legacy = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
    if (!legacy) return null;
    try {
        const data = JSON.parse(legacy);
        if (!Array.isArray(data?.tasks) || !Array.isArray(data?.projects)) return null;
        data.areas = Array.isArray(data.areas) ? data.areas : [];
        data.sections = Array.isArray(data.sections) ? data.sections : [];
        await idbPut(data);
        localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
        return data as AppData;
    } catch {
        return null;
    }
};

export const webStorage: StorageAdapter = {
    getData: async (): Promise<AppData> => {
        if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return EMPTY_DATA;
        try {
            const existing = await idbGet();
            if (existing) {
                if (!Array.isArray(existing.tasks) || !Array.isArray(existing.projects)) {
                    throw new Error('Invalid data format');
                }
                existing.areas = Array.isArray(existing.areas) ? existing.areas : [];
                existing.sections = Array.isArray(existing.sections) ? existing.sections : [];
                ensureSyncSettingsConfigured();
                return existing;
            }
            const migrated = await migrateFromLocalStorageOnce();
            if (migrated) {
                ensureSyncSettingsConfigured();
                return migrated;
            }
            const bootstrapped = await tryBootstrapFromCloud();
            if (bootstrapped) {
                ensureSyncSettingsConfigured();
                return bootstrapped;
            }
            return EMPTY_DATA;
        } catch (error) {
            reportError('Failed to load local data', error);
            throw new Error('Data appears corrupted. Please restore from backup.');
        }
    },
    saveData: async (data: AppData): Promise<void> => {
        if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
        try {
            await idbPut(data);
        } catch (error) {
            reportError('Failed to save local data', error);
            throw new Error('Failed to save data.');
        }
    },
};
