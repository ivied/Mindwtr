import { describe, expect, it } from 'vitest';
import { createWebdavSyncRateLimitController } from './sync-rate-limit';

describe('createWebdavSyncRateLimitController', () => {
    it('blocks repeated webdav sync attempts during the cooldown window', () => {
        let nowMs = 1_000;
        const controller = createWebdavSyncRateLimitController({
            now: () => nowMs,
            cooldownMs: 60_000,
        });

        expect(controller.noteError('webdav', { status: 429 })).toBe(true);
        expect(controller.getBlockedUntil()).toBe(61_000);

        expect(() => controller.assertReady('webdav')).toThrow('WebDAV rate limited for 60000ms');

        nowMs = 61_000;
        expect(() => controller.assertReady('webdav')).not.toThrow();
        expect(controller.getBlockedUntil()).toBe(0);
    });

    it('ignores non-webdav backends and non-rate-limit errors', () => {
        const controller = createWebdavSyncRateLimitController({
            now: () => 1_000,
            cooldownMs: 60_000,
        });

        expect(controller.noteError('cloud', { status: 429 })).toBe(false);
        expect(controller.noteError('webdav', new Error('other failure'))).toBe(false);
        expect(controller.getBlockedUntil()).toBe(0);
        expect(() => controller.assertReady('cloud')).not.toThrow();
        expect(() => controller.assertReady('webdav')).not.toThrow();
    });
});
