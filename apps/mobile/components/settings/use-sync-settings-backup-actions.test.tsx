import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appLogMocks = vi.hoisted(() => ({
    clearLog: vi.fn(),
    ensureLogFilePath: vi.fn(),
    logInfo: vi.fn(),
}));

const sharingMocks = vi.hoisted(() => ({
    isAvailableAsync: vi.fn(),
    shareAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
    Alert: { alert: vi.fn() },
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: {} } },
}));

vi.mock('expo-sharing', () => sharingMocks);

vi.mock('@/lib/app-log', () => appLogMocks);

vi.mock('@/lib/settings-utils', () => ({
    logSettingsError: vi.fn(),
}));

vi.mock('@/lib/data-transfer', () => ({
    exportCurrentDataBackup: vi.fn(),
    importDgtData: vi.fn(),
    importOmniFocusData: vi.fn(),
    importTickTickData: vi.fn(),
    importTodoistData: vi.fn(),
    inspectBackupDocument: vi.fn(),
    inspectDgtDocument: vi.fn(),
    inspectOmniFocusDocument: vi.fn(),
    inspectTickTickDocument: vi.fn(),
    inspectTodoistDocument: vi.fn(),
    pickBackupDocument: vi.fn(),
    pickDgtDocument: vi.fn(),
    pickOmniFocusDocument: vi.fn(),
    pickTickTickDocument: vi.fn(),
    pickTodoistDocument: vi.fn(),
    restoreDataFromBackup: vi.fn(),
    restoreLocalDataSnapshot: vi.fn(),
}));

import { useSyncSettingsBackupActions } from './use-sync-settings-backup-actions';

type HookResult = ReturnType<typeof useSyncSettingsBackupActions>;

describe('useSyncSettingsBackupActions', () => {
    let latest: HookResult | null = null;
    const showToast = vi.fn();
    const showSettingsErrorToast = vi.fn();

    function Harness() {
        latest = useSyncSettingsBackupActions({
            areas: [],
            projects: [],
            refreshRecoverySnapshots: vi.fn(),
            sections: [],
            settings: {},
            setBackupAction: vi.fn(),
            showSettingsErrorToast,
            showSettingsWarning: vi.fn(),
            showToast,
            t: (key: string) => key,
            tasks: [],
            tr: (key: string) => key,
            updateSettings: vi.fn().mockResolvedValue(undefined),
        });
        return null;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        latest = null;
        appLogMocks.ensureLogFilePath.mockResolvedValue('file://logs/mindwtr.log');
        sharingMocks.isAvailableAsync.mockResolvedValue(true);
        sharingMocks.shareAsync.mockResolvedValue(undefined);
    });

    it('shows a warning instead of rejecting when Expo Go sharing fails', async () => {
        sharingMocks.isAvailableAsync.mockRejectedValue(new TypeError("Cannot read property 'replace' of undefined"));

        await act(async () => {
            create(<Harness />);
        });

        await expect(latest?.handleShareLog()).resolves.toBeUndefined();
        expect(showToast).toHaveBeenCalledWith({
            title: 'settings.debugLogging',
            message: 'settings.shareUnavailable',
            tone: 'warning',
        });
        expect(showSettingsErrorToast).not.toHaveBeenCalled();
    });

    it('shares the diagnostics log when sharing is available', async () => {
        await act(async () => {
            create(<Harness />);
        });

        await latest?.handleShareLog();

        expect(sharingMocks.shareAsync).toHaveBeenCalledWith('file://logs/mindwtr.log', { mimeType: 'text/plain' });
        expect(showToast).not.toHaveBeenCalled();
    });
});
