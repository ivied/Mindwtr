import { describe, expect, it } from 'vitest';

import { resolveCloseBehavior, resolveCloseRequestAction } from './window-behavior';

describe('window behavior', () => {
    it('defaults Flatpak window close handling to the tray', () => {
        expect(resolveCloseBehavior(undefined, true)).toBe('tray');
    });

    it('keeps the standard default close prompt outside Flatpak', () => {
        expect(resolveCloseBehavior(undefined, false)).toBe('ask');
    });

    it('preserves an explicit close behavior', () => {
        expect(resolveCloseBehavior('quit', true)).toBe('quit');
        expect(resolveCloseBehavior('tray', false)).toBe('tray');
    });

    it('resolves close requests without prompting when a remembered behavior exists', () => {
        expect(resolveCloseRequestAction('tray', true, false)).toBe('tray');
        expect(resolveCloseRequestAction('tray', undefined, false)).toBe('tray');
        expect(resolveCloseRequestAction('tray', false, false)).toBe('quit');
        expect(resolveCloseRequestAction('quit', true, false)).toBe('quit');
        expect(resolveCloseRequestAction('ask', true, false)).toBe('prompt');
    });
});
