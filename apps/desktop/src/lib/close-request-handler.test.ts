import { describe, expect, it, vi } from 'vitest';
import type { WindowSettings } from '@mindwtr/core';

import { handleDesktopCloseRequest } from './close-request-handler';

describe('close request handler', () => {
    const createHarness = (initialSettings: WindowSettings | undefined) => {
        let settings = initialSettings;
        const promptOpenRef = { current: false };
        const setPromptOpen = vi.fn((next: boolean) => {
            promptOpenRef.current = next;
        });
        return {
            get settings() {
                return settings;
            },
            set settings(next: WindowSettings | undefined) {
                settings = next;
            },
            hideToTray: vi.fn(async () => undefined),
            promptOpenRef,
            quitApp: vi.fn(async () => undefined),
            reportCloseError: vi.fn(),
            setPromptOpen,
            setPromptRemember: vi.fn(),
        };
    };

    it('uses the latest close behavior instead of stale listener state', async () => {
        const harness = createHarness({ closeBehavior: 'ask', showTray: true });
        harness.settings = { closeBehavior: 'tray', showTray: true };

        await handleDesktopCloseRequest({
            getWindowSettings: () => harness.settings,
            hideToTray: harness.hideToTray,
            isFlatpak: false,
            promptOpenRef: harness.promptOpenRef,
            quitApp: harness.quitApp,
            reportCloseError: harness.reportCloseError,
            setPromptOpen: harness.setPromptOpen,
            setPromptRemember: harness.setPromptRemember,
        });

        expect(harness.hideToTray).toHaveBeenCalledTimes(1);
        expect(harness.quitApp).not.toHaveBeenCalled();
        expect(harness.setPromptOpen).not.toHaveBeenCalled();
        expect(harness.setPromptRemember).not.toHaveBeenCalled();
    });

    it('opens the prompt only for ask behavior', async () => {
        const harness = createHarness({ closeBehavior: 'ask', showTray: true });

        await handleDesktopCloseRequest({
            getWindowSettings: () => harness.settings,
            hideToTray: harness.hideToTray,
            isFlatpak: false,
            promptOpenRef: harness.promptOpenRef,
            quitApp: harness.quitApp,
            reportCloseError: harness.reportCloseError,
            setPromptOpen: harness.setPromptOpen,
            setPromptRemember: harness.setPromptRemember,
        });

        expect(harness.setPromptRemember).toHaveBeenCalledWith(false);
        expect(harness.setPromptOpen).toHaveBeenCalledWith(true);
        expect(harness.hideToTray).not.toHaveBeenCalled();
        expect(harness.quitApp).not.toHaveBeenCalled();
    });

    it('quits instead of hiding when the tray is disabled', async () => {
        const harness = createHarness({ closeBehavior: 'tray', showTray: false });

        await handleDesktopCloseRequest({
            getWindowSettings: () => harness.settings,
            hideToTray: harness.hideToTray,
            isFlatpak: false,
            promptOpenRef: harness.promptOpenRef,
            quitApp: harness.quitApp,
            reportCloseError: harness.reportCloseError,
            setPromptOpen: harness.setPromptOpen,
            setPromptRemember: harness.setPromptRemember,
        });

        expect(harness.quitApp).toHaveBeenCalledTimes(1);
        expect(harness.hideToTray).not.toHaveBeenCalled();
        expect(harness.setPromptOpen).not.toHaveBeenCalled();
    });
});
