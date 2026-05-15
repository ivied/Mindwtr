import { describe, expect, test, vi } from 'vitest';

describe('timers-bootstrap', () => {
    test('installs immediate timer fallbacks when missing', async () => {
        vi.resetModules();

        const originalSetImmediate = (globalThis as any).setImmediate;
        const originalClearImmediate = (globalThis as any).clearImmediate;
        const originalSetTimeout = (globalThis as any).setTimeout;
        const originalClearTimeout = (globalThis as any).clearTimeout;

        try {
            (globalThis as any).setImmediate = undefined;
            (globalThis as any).clearImmediate = undefined;
            (globalThis as any).setTimeout = (...args: unknown[]) => originalSetTimeout(...args);
            (globalThis as any).clearTimeout = (id: number) => originalClearTimeout(id);

            await import('./timers-bootstrap');

            expect(typeof (globalThis as any).setImmediate).toBe('function');
            expect(typeof (globalThis as any).clearImmediate).toBe('function');
        } finally {
            (globalThis as any).setImmediate = originalSetImmediate;
            (globalThis as any).clearImmediate = originalClearImmediate;
            (globalThis as any).setTimeout = originalSetTimeout;
            (globalThis as any).clearTimeout = originalClearTimeout;
        }
    });
});
