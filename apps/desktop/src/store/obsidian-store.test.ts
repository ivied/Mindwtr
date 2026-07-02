import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizeObsidianConfig, type ObsidianConfig, type ObsidianScanResult } from '../lib/obsidian-scanner';

const scanVaultMock = vi.hoisted(() => vi.fn());
const setConfigMock = vi.hoisted(() => vi.fn());
const startWatcherMock = vi.hoisted(() => vi.fn());
const stopWatcherMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/obsidian-service', async () => {
    return {
        ObsidianService: {
            getConfig: vi.fn(),
            hasVaultMarker: vi.fn(),
            scanVault: scanVaultMock,
            setConfig: setConfigMock,
            startWatcher: startWatcherMock,
            stopWatcher: stopWatcherMock,
        },
    };
});

import { useObsidianStore } from './obsidian-store';

const initialState = useObsidianStore.getState();

const enabledConfig: ObsidianConfig = normalizeObsidianConfig({
    vaultPath: '/Vault',
    enabled: true,
    scanFolders: ['/'],
});

const emptyScanResult: ObsidianScanResult = {
    tasks: [],
    scannedFileCount: 0,
    scannedRelativePaths: [],
    taskNotesDetectedPaths: [],
    warnings: [],
    importMode: 'inline',
};

const resetStore = () => {
    useObsidianStore.setState(initialState, true);
    useObsidianStore.setState((state) => ({
        ...state,
        config: enabledConfig,
        isScanning: false,
        hasScannedThisSession: false,
        error: null,
    }));
};

beforeEach(() => {
    resetStore();
    scanVaultMock.mockReset();
    setConfigMock.mockReset();
    startWatcherMock.mockReset();
    stopWatcherMock.mockReset();
    setConfigMock.mockImplementation(async (config: Partial<ObsidianConfig>) => normalizeObsidianConfig(config));
});

afterEach(() => {
    resetStore();
    vi.restoreAllMocks();
});

describe('useObsidianStore', () => {
    it('shares an in-flight rescan for repeated requests against the same vault', async () => {
        let resolveScan!: (result: ObsidianScanResult) => void;
        scanVaultMock.mockReturnValueOnce(new Promise<ObsidianScanResult>((resolve) => {
            resolveScan = resolve;
        }));

        const firstScan = useObsidianStore.getState().rescan();
        const secondScan = useObsidianStore.getState().rescan();

        expect(scanVaultMock).toHaveBeenCalledTimes(1);
        expect(useObsidianStore.getState().isScanning).toBe(true);

        resolveScan(emptyScanResult);
        await Promise.all([firstScan, secondScan]);

        expect(setConfigMock).toHaveBeenCalledTimes(1);
        expect(useObsidianStore.getState()).toMatchObject({
            error: null,
            hasScannedThisSession: true,
            isScanning: false,
            scannedFileCount: 0,
        });
    });
});
