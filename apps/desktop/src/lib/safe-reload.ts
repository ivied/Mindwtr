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
 *   2. Force-sync IndexedDB → cloud (best effort).
 *   3. Unregister every service worker for this origin.
 *   4. Delete every cache storage (asset cache only — IndexedDB is left alone).
 *   5. Reload the page.
 *
 * IndexedDB, localStorage, sessionStorage, cookies are NOT touched.
 */

import { flushPendingSave } from '@mindwtr/core';
import { SyncService } from './sync-service';

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
