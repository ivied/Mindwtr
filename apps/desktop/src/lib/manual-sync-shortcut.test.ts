import { describe, expect, it } from 'vitest';
import {
    isEditableManualSyncShortcutTarget,
    isManualSyncShortcut,
} from './manual-sync-shortcut';

describe('manual sync shortcut', () => {
    it('matches Ctrl+Alt+S and Cmd+Option+S without Shift', () => {
        expect(isManualSyncShortcut(new KeyboardEvent('keydown', {
            altKey: true,
            code: 'KeyS',
            ctrlKey: true,
            key: 's',
        }))).toBe(true);
        expect(isManualSyncShortcut(new KeyboardEvent('keydown', {
            altKey: true,
            code: 'KeyS',
            key: 's',
            metaKey: true,
        }))).toBe(true);
        expect(isManualSyncShortcut(new KeyboardEvent('keydown', {
            altKey: true,
            code: 'KeyS',
            ctrlKey: true,
            key: 's',
            shiftKey: true,
        }))).toBe(false);
    });

    it('ignores editable targets', () => {
        const input = document.createElement('input');
        const button = document.createElement('button');

        expect(isEditableManualSyncShortcutTarget(input)).toBe(true);
        expect(isEditableManualSyncShortcutTarget(button)).toBe(false);
    });
});
