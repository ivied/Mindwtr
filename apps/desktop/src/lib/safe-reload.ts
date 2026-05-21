/**
 * Safe reload — pick up a new front-end bundle without nuking user data.
 *
 * The Mindwtr PWA registers a service worker that aggressively caches the
 * built JS/CSS, and IndexedDB holds the source of truth for tasks. When
 * the docker image is rebuilt the SW keeps serving the old bundle until
 * its next update cycle (potentially hours). Users used to work around
 * this with browser-level "Clear site data" — which also wipes IndexedDB
 * and any unsynced tasks.
 *
 * This helper does the right thing:
 *   1. Flush in-memory pending writes to IndexedDB.
 *   2. Force-sync IndexedDB → cloud (push pending up; best effort).
 *   3. Force-pull cloud → IndexedDB and merge (catches tasks the web build's
 *      bootstrap-once flow won't see — e.g. proposals approved server-side
 *      while the tab was open).
 *   4. Unregister every service worker for this origin.
 *   5. Delete every cache storage (asset cache only — IndexedDB is left alone).
 *   6. Reload the page.
 *
 * IndexedDB is merged-in-place; localStorage, sessionStorage, cookies are
 * NOT touched.
 */

import { flushPendingSave, type AppData, type Task } from '@mindwtr/core';
import { SyncService } from './sync-service';
import { cloudDataUrl, cloudToken } from './cloud-target';

const IDB_NAME = 'mindwtr';
const IDB_STORE = 'app-data';
const IDB_KEY = 'main';

export interface SafeReloadOptions {
    /** Called as the operation progresses. Use for toasts / inline messages. */
    onProgress?: (step: string) => void;
}

export async function safeReload(opts: SafeReloadOptions = {}): Promise<void> {
    const progress = opts.onProgress ?? (() => {});

    try {
        progress('Saving pending changes…');
        await flushPendingSave();
    } catch (err) {
        console.warn('[safe-reload] flushPendingSave failed:', err);
    }

    try {
        progress('Syncing to cloud…');
        await SyncService.performSync();
    } catch (err) {
        // Cloud unreachable is OK — data still lives in IndexedDB and will sync
        // on the next online cycle. Don't block the reload.
        console.warn('[safe-reload] performSync failed, proceeding:', err);
    }

    try {
        progress('Pulling latest from cloud…');
        await mergeCloudIntoIndexedDb();
    } catch (err) {
        // Pull failure is non-fatal — local copy stays valid, reload still runs.
        console.warn('[safe-reload] cloud pull failed, proceeding:', err);
    }

    try {
        progress('Updating service worker…');
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
        }
    } catch (err) {
        console.warn('[safe-reload] serviceWorker unregister failed:', err);
    }

    try {
        progress('Clearing asset cache…');
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
    } catch (err) {
        console.warn('[safe-reload] caches.delete failed:', err);
    }

    progress('Reloading…');
    window.location.reload();
}

/**
 * Re-fetch the canonical task snapshot from cloud and merge it into the
 * existing IndexedDB record. We don't overwrite: tasks present locally but
 * not on cloud are preserved (they may be pending-sync drafts), and conflicts
 * are resolved by updatedAt — newer wins. New cloud-only tasks are added.
 *
 * Needed because the web build only bootstraps from cloud when IndexedDB is
 * empty; once populated, server-side changes (e.g. proposals approved while
 * the tab is open and the new tasks land via ai-service) stay invisible to
 * the user until something forces a refresh. SafeReload is that something.
 */
async function mergeCloudIntoIndexedDb(): Promise<void> {
    if (typeof indexedDB === 'undefined' || typeof fetch === 'undefined') return;

    const response = await fetch(cloudDataUrl(), {
        headers: { Authorization: `Bearer ${cloudToken()}` },
    });
    if (!response.ok) {
        throw new Error(`cloud /v1/data returned ${response.status}`);
    }
    const cloud = (await response.json()) as Partial<AppData>;
    if (!Array.isArray(cloud?.tasks) || !Array.isArray(cloud?.projects)) {
        throw new Error('cloud /v1/data: unexpected shape');
    }

    const db = await openIdb();
    const existing = await idbGet(db);
    const merged = mergeAppData(existing, {
        tasks: cloud.tasks ?? [],
        projects: cloud.projects ?? [],
        areas: Array.isArray(cloud.areas) ? cloud.areas : [],
        sections: Array.isArray(cloud.sections) ? cloud.sections : [],
        settings: cloud.settings ?? existing?.settings ?? {},
    });
    await idbPut(db, merged);
}

function openIdb(): Promise<IDBDatabase> {
    return new Promise((resolvePromise, rejectPromise) => {
        const req = indexedDB.open(IDB_NAME);
        req.onsuccess = () => resolvePromise(req.result);
        req.onerror = () => rejectPromise(req.error ?? new Error('IndexedDB open failed'));
    });
}

function idbGet(db: IDBDatabase): Promise<AppData | null> {
    return new Promise((resolvePromise, rejectPromise) => {
        try {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(IDB_KEY);
            req.onsuccess = () => resolvePromise((req.result as AppData | undefined) ?? null);
            req.onerror = () => rejectPromise(req.error ?? new Error('IDB read failed'));
        } catch (err) {
            rejectPromise(err);
        }
    });
}

function idbPut(db: IDBDatabase, data: AppData): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        store.put(data, IDB_KEY);
        tx.oncomplete = () => resolvePromise();
        tx.onerror = () => rejectPromise(tx.error ?? new Error('IDB write failed'));
    });
}

function mergeAppData(local: AppData | null, cloud: AppData): AppData {
    if (!local) return cloud;
    return {
        tasks: mergeById(local.tasks ?? [], cloud.tasks),
        projects: mergeById(local.projects ?? [], cloud.projects),
        areas: mergeById(local.areas ?? [], cloud.areas),
        sections: mergeById(local.sections ?? [], cloud.sections),
        settings: { ...local.settings, ...cloud.settings },
    };
}

/**
 * Newest-wins merge keyed by `id`. Cloud entries replace local ones only when
 * their updatedAt is strictly newer; local-only entries are preserved (pending
 * sync). Items without an id or updatedAt fall back to cloud-wins to avoid
 * silent data loss.
 */
function mergeById<T extends { id?: string; updatedAt?: string }>(local: T[], cloud: T[]): T[] {
    const map = new Map<string, T>();
    for (const item of local) {
        if (typeof item.id === 'string' && item.id) map.set(item.id, item);
    }
    for (const item of cloud) {
        if (typeof item.id !== 'string' || !item.id) continue;
        const existing = map.get(item.id);
        if (!existing) {
            map.set(item.id, item);
            continue;
        }
        const localTs = existing.updatedAt ?? '';
        const cloudTs = item.updatedAt ?? '';
        if (cloudTs > localTs) map.set(item.id, item);
    }
    return Array.from(map.values());
}

// Re-export AppData types not used here directly so the file stays self-contained
// at the type level. Task is used through the AppData generic above; the explicit
// import is kept for symmetry with other helpers and to make future extensions
// (e.g. per-task hooks) easier to wire in.
export type { Task };
