import { AppData, StorageAdapter } from '@mindwtr/core';
import { reportError } from './report-error';

const DB_NAME = 'mindwtr';
const STORE_NAME = 'app-data';
const RECORD_KEY = 'main';
const LEGACY_LOCAL_STORAGE_KEY = 'mindwtr-data';
const DB_VERSION = 1;

// Auto-bootstrap config (dev: hardcoded; prod would use VITE_* env vars at build time).
const BOOTSTRAP_CLOUD_URL = 'http://localhost:8787/v1/data';
const BOOTSTRAP_CLOUD_TOKEN = 'dev-token-gtd-automation-2026';

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

const ensureSyncSettingsConfigured = (): void => {
    if (typeof localStorage === 'undefined') return;
    const currentBackend = localStorage.getItem(SYNC_BACKEND_KEY);
    if (currentBackend && currentBackend !== 'off') return;
    localStorage.setItem(SYNC_BACKEND_KEY, 'cloud');
    localStorage.setItem(CLOUD_PROVIDER_KEY, 'selfhosted');
    localStorage.setItem(CLOUD_URL_KEY, BOOTSTRAP_CLOUD_URL);
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(CLOUD_TOKEN_KEY, BOOTSTRAP_CLOUD_TOKEN);
    } else {
        localStorage.setItem(CLOUD_TOKEN_KEY, BOOTSTRAP_CLOUD_TOKEN);
    }
};

const tryBootstrapFromCloud = async (): Promise<AppData | null> => {
    if (!BOOTSTRAP_CLOUD_URL || !BOOTSTRAP_CLOUD_TOKEN) return null;
    try {
        const response = await fetch(BOOTSTRAP_CLOUD_URL, {
            headers: { Authorization: `Bearer ${BOOTSTRAP_CLOUD_TOKEN}` },
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
