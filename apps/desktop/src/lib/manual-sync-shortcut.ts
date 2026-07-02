type ManualSyncShortcutEvent = Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>;

export const MANUAL_SYNC_SHORTCUT_DISPLAY = 'Ctrl+Alt+S / Cmd+Option+S';

export function isManualSyncShortcut(event: ManualSyncShortcutEvent): boolean {
    if (!event.altKey || event.shiftKey) return false;
    if (!event.ctrlKey && !event.metaKey) return false;
    return event.code === 'KeyS' || event.key.toLowerCase() === 's';
}

export function isEditableManualSyncShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}
