import type { WindowSettings } from '@mindwtr/core';

export type DesktopCloseBehavior = NonNullable<WindowSettings['closeBehavior']>;

export const getDefaultCloseBehavior = (isFlatpak: boolean): DesktopCloseBehavior => (
    isFlatpak ? 'tray' : 'ask'
);

export const resolveCloseBehavior = (
    closeBehavior: WindowSettings['closeBehavior'] | undefined,
    isFlatpak: boolean,
): DesktopCloseBehavior => closeBehavior ?? getDefaultCloseBehavior(isFlatpak);

export type DesktopCloseRequestAction = 'prompt' | 'tray' | 'quit';

export const resolveCloseRequestAction = (
    closeBehavior: WindowSettings['closeBehavior'] | undefined,
    showTray: WindowSettings['showTray'] | undefined,
    isFlatpak: boolean,
): DesktopCloseRequestAction => {
    const resolvedBehavior = resolveCloseBehavior(closeBehavior, isFlatpak);
    if (resolvedBehavior === 'quit') return 'quit';
    if (resolvedBehavior === 'tray') {
        return showTray === false ? 'quit' : 'tray';
    }
    return 'prompt';
};
