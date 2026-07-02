export type DesktopVisibilitySyncAction = 'focus' | 'blur' | null;

export function isDesktopSyncRuntimeActive(isAppActive: boolean): boolean {
    return isAppActive;
}

export function resolveVisibilitySyncAction(
    visibilityState: DocumentVisibilityState
): DesktopVisibilitySyncAction {
    if (visibilityState === 'visible') return 'focus';
    if (visibilityState === 'hidden') return 'blur';
    return null;
}

export function shouldHandleDesktopManualSyncShortcut({
    isEditableTarget,
    isShortcut,
}: {
    isEditableTarget: boolean;
    isShortcut: boolean;
}): boolean {
    return isShortcut && !isEditableTarget;
}
