import { describe, expect, it } from 'vitest';
import {
    isDesktopSyncRuntimeActive,
    resolveVisibilitySyncAction,
    shouldHandleDesktopManualSyncShortcut,
} from './desktop-sync-runtime';

describe('desktop sync runtime helpers', () => {
    it('keeps auto sync active for the browser/PWA shell while the app is active', () => {
        expect(isDesktopSyncRuntimeActive(true)).toBe(true);
    });

    it('pauses sync after the app shell is disposed', () => {
        expect(isDesktopSyncRuntimeActive(false)).toBe(false);
    });

    it('maps tab visibility changes onto existing focus and blur sync hooks', () => {
        expect(resolveVisibilitySyncAction('visible')).toBe('focus');
        expect(resolveVisibilitySyncAction('hidden')).toBe('blur');
    });

    it('allows the manual sync shortcut in browser/PWA when the target is not editable', () => {
        expect(shouldHandleDesktopManualSyncShortcut({
            isEditableTarget: false,
            isShortcut: true,
        })).toBe(true);
    });

    it('ignores manual sync shortcuts inside editable controls', () => {
        expect(shouldHandleDesktopManualSyncShortcut({
            isEditableTarget: true,
            isShortcut: true,
        })).toBe(false);
        expect(shouldHandleDesktopManualSyncShortcut({
            isEditableTarget: false,
            isShortcut: false,
        })).toBe(false);
    });
});
