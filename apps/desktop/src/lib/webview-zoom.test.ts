import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
    DEFAULT_WEBVIEW_ZOOM,
    MAX_WEBVIEW_ZOOM,
    MIN_WEBVIEW_ZOOM,
    WEBVIEW_ZOOM_STORAGE_KEY,
    getNextWebviewZoom,
    getWebviewZoomShortcutAction,
    getWebviewZoomWheelAction,
    installWebviewZoomShortcuts,
    loadStoredWebviewZoom,
    restoreStoredWebviewZoom,
    saveStoredWebviewZoom,
} from './webview-zoom';

describe('webview zoom state', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('loads and sanitizes stored zoom values', () => {
        window.localStorage.setItem(WEBVIEW_ZOOM_STORAGE_KEY, JSON.stringify(0.8));
        expect(loadStoredWebviewZoom(window.localStorage)).toBe(0.8);

        window.localStorage.setItem(WEBVIEW_ZOOM_STORAGE_KEY, JSON.stringify(99));
        expect(loadStoredWebviewZoom(window.localStorage)).toBe(MAX_WEBVIEW_ZOOM);

        window.localStorage.setItem(WEBVIEW_ZOOM_STORAGE_KEY, '"bad"');
        expect(loadStoredWebviewZoom(window.localStorage)).toBe(DEFAULT_WEBVIEW_ZOOM);
    });

    it('stores non-default zoom and removes default zoom', () => {
        saveStoredWebviewZoom(0.8, window.localStorage);
        expect(JSON.parse(window.localStorage.getItem(WEBVIEW_ZOOM_STORAGE_KEY) || 'null')).toBe(0.8);

        saveStoredWebviewZoom(DEFAULT_WEBVIEW_ZOOM, window.localStorage);
        expect(window.localStorage.getItem(WEBVIEW_ZOOM_STORAGE_KEY)).toBeNull();
    });

    it('keeps shortcut zoom steps within supported bounds', () => {
        expect(getNextWebviewZoom(1, 'out')).toBe(0.9);
        expect(getNextWebviewZoom(1, 'in')).toBe(1.1);
        expect(getNextWebviewZoom(1.95, 'in')).toBe(MAX_WEBVIEW_ZOOM);
        expect(getNextWebviewZoom(0.55, 'out')).toBe(MIN_WEBVIEW_ZOOM);
        expect(getNextWebviewZoom(0.9, 'reset')).toBe(DEFAULT_WEBVIEW_ZOOM);
    });

    it('detects browser-style zoom shortcuts', () => {
        expect(getWebviewZoomShortcutAction(new KeyboardEvent('keydown', {
            key: '=',
            code: 'Equal',
            ctrlKey: true,
        }))).toBe('in');
        expect(getWebviewZoomShortcutAction(new KeyboardEvent('keydown', {
            key: '-',
            code: 'Minus',
            metaKey: true,
        }))).toBe('out');
        expect(getWebviewZoomShortcutAction(new KeyboardEvent('keydown', {
            key: '0',
            code: 'Digit0',
            ctrlKey: true,
        }))).toBe('reset');
        expect(getWebviewZoomShortcutAction(new KeyboardEvent('keydown', {
            key: '=',
            code: 'Equal',
            ctrlKey: true,
            altKey: true,
        }))).toBeNull();
    });

    it('detects browser-style wheel zoom gestures', () => {
        expect(getWebviewZoomWheelAction(new WheelEvent('wheel', {
            deltaY: -120,
            ctrlKey: true,
        }))).toBe('in');
        expect(getWebviewZoomWheelAction(new WheelEvent('wheel', {
            deltaY: 120,
            metaKey: true,
        }))).toBe('out');
        expect(getWebviewZoomWheelAction(new WheelEvent('wheel', {
            deltaY: 120,
        }))).toBeNull();
        expect(getWebviewZoomWheelAction(new WheelEvent('wheel', {
            deltaY: 120,
            ctrlKey: true,
            altKey: true,
        }))).toBeNull();
    });

    it('restores stored zoom on startup', async () => {
        const setZoom = vi.fn().mockResolvedValue(undefined);
        window.localStorage.setItem(WEBVIEW_ZOOM_STORAGE_KEY, JSON.stringify(0.8));

        await restoreStoredWebviewZoom({
            storage: window.localStorage,
            loadWebviewModule: async () => ({
                getCurrentWebview: () => ({ setZoom }),
            }),
        });

        expect(setZoom).toHaveBeenCalledWith(0.8);
    });

    it('persists and applies shortcut zoom changes', async () => {
        const setZoom = vi.fn().mockResolvedValue(undefined);
        const dispose = installWebviewZoomShortcuts({
            storage: window.localStorage,
            loadWebviewModule: async () => ({
                getCurrentWebview: () => ({ setZoom }),
            }),
        });

        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: '-',
            code: 'Minus',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }));

        await waitFor(() => expect(setZoom).toHaveBeenCalledWith(0.9));
        expect(JSON.parse(window.localStorage.getItem(WEBVIEW_ZOOM_STORAGE_KEY) || 'null')).toBe(0.9);

        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: '0',
            code: 'Digit0',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }));

        await waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(DEFAULT_WEBVIEW_ZOOM));
        expect(window.localStorage.getItem(WEBVIEW_ZOOM_STORAGE_KEY)).toBeNull();

        dispose();
    });

    it('persists and applies ctrl wheel zoom changes', async () => {
        const setZoom = vi.fn().mockResolvedValue(undefined);
        const dispose = installWebviewZoomShortcuts({
            storage: window.localStorage,
            loadWebviewModule: async () => ({
                getCurrentWebview: () => ({ setZoom }),
            }),
        });

        window.dispatchEvent(new WheelEvent('wheel', {
            deltaY: -40,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }));
        expect(setZoom).not.toHaveBeenCalled();

        window.dispatchEvent(new WheelEvent('wheel', {
            deltaY: -50,
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }));

        await waitFor(() => expect(setZoom).toHaveBeenCalledWith(1.1));
        expect(JSON.parse(window.localStorage.getItem(WEBVIEW_ZOOM_STORAGE_KEY) || 'null')).toBe(1.1);

        dispose();
    });
});
