import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';

import { useAiSettings } from './useAiSettings';

type HookResult = ReturnType<typeof useAiSettings>;

const fsMocks = vi.hoisted(() => ({
    exists: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    size: vi.fn(),
    writeFile: vi.fn(),
}));

const pathMocks = vi.hoisted(() => ({
    dataDir: vi.fn(),
    join: vi.fn(),
}));

const tauriCoreMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
    listen: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 'Data' },
    exists: fsMocks.exists,
    mkdir: fsMocks.mkdir,
    remove: fsMocks.remove,
    size: fsMocks.size,
    writeFile: fsMocks.writeFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
    dataDir: pathMocks.dataDir,
    join: pathMocks.join,
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriCoreMocks.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: eventMocks.listen,
}));

const settingsWithSpeech = (speechToText: NonNullable<NonNullable<AppData['settings']['ai']>['speechToText']>): AppData['settings'] => ({
    ai: {
        speechToText,
    },
});

describe('useAiSettings speech provider changes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fsMocks.exists.mockResolvedValue(false);
        fsMocks.mkdir.mockResolvedValue(undefined);
        fsMocks.remove.mockResolvedValue(undefined);
        fsMocks.size.mockResolvedValue(0);
        fsMocks.writeFile.mockResolvedValue(undefined);
        pathMocks.dataDir.mockResolvedValue('/home/dd/.local/share');
        pathMocks.join.mockImplementation(async (...parts: string[]) => parts.join('/'));
        tauriCoreMocks.invoke.mockResolvedValue(null);
        eventMocks.listen.mockResolvedValue(vi.fn());
    });

    it('does not reuse a Whisper model file path when switching to Parakeet', () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const settings = settingsWithSpeech({
            provider: 'whisper',
            model: 'whisper-base',
            offlineModelPath: '/home/dd/.local/share/mindwtr/whisper-models/ggml-base.bin',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: false,
                settings,
                updateSettings,
                showSaved: vi.fn(),
                enabled: false,
            });
            return null;
        }

        render(<Probe />);

        act(() => {
            result?.onSpeechProviderChange('parakeet');
        });

        expect(updateSettings).toHaveBeenCalledWith({
            ai: {
                speechToText: {
                    provider: 'parakeet',
                    model: 'parakeet-tdt-0.6b-v3-int8',
                    offlineModelPath: undefined,
                },
            },
        });
    });

    it('shows the default Parakeet model folder without marking it ready before install', async () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const settings = settingsWithSpeech({
            provider: 'parakeet',
            model: 'parakeet-tdt-0.6b-v3-int8',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings,
                showSaved: vi.fn(),
            });
            return (
                <output data-testid="speech-state">
                    {JSON.stringify({
                        path: result.speechOfflineModelPath,
                        ready: result.speechOfflineReady,
                    })}
                </output>
            );
        }

        render(<Probe />);

        await waitFor(() => {
            expect(screen.getByTestId('speech-state').textContent).toContain('/home/dd/.local/share/mindwtr/parakeet-model');
        });
        expect(JSON.parse(screen.getByTestId('speech-state').textContent ?? '{}')).toMatchObject({
            path: '/home/dd/.local/share/mindwtr/parakeet-model',
            ready: false,
        });
        expect(updateSettings).not.toHaveBeenCalled();
    });


    it('tracks Parakeet download progress events', async () => {
        let result: HookResult | null = null;
        let progressHandler: ((event: { payload: { stage: string; loaded: number; total: number; percent: number } }) => void) | null = null;
        eventMocks.listen.mockImplementation(async (_event: string, handler: typeof progressHandler) => {
            progressHandler = handler;
            return vi.fn();
        });
        const settings = settingsWithSpeech({
            provider: 'parakeet',
            model: 'parakeet-tdt-0.6b-v3-int8',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings: vi.fn(async () => undefined),
                showSaved: vi.fn(),
            });
            return null;
        }

        render(<Probe />);

        await waitFor(() => {
            expect(eventMocks.listen).toHaveBeenCalledWith('parakeet-model-download-progress', expect.any(Function));
        });

        act(() => {
            progressHandler?.({
                payload: {
                    stage: 'model_download',
                    loaded: 50,
                    total: 100,
                    percent: 50,
                },
            });
        });

        const readResult = () => result as unknown as HookResult;
        expect(readResult().speechDownloadProgress).toEqual({
            stage: 'model_download',
            loaded: 50,
            total: 100,
            percent: 50,
        });
    });

    it('tracks Whisper download progress events', async () => {
        let result: HookResult | null = null;
        let progressHandler: ((event: { payload: { stage: string; loaded: number; total: number; percent: number } }) => void) | null = null;
        eventMocks.listen.mockImplementation(async (event: string, handler: typeof progressHandler) => {
            if (event === 'whisper-model-download-progress') {
                progressHandler = handler;
            }
            return vi.fn();
        });
        const settings = settingsWithSpeech({
            provider: 'whisper',
            model: 'whisper-tiny',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings: vi.fn(async () => undefined),
                showSaved: vi.fn(),
            });
            return null;
        }

        render(<Probe />);

        await waitFor(() => {
            expect(eventMocks.listen).toHaveBeenCalledWith('whisper-model-download-progress', expect.any(Function));
        });

        act(() => {
            progressHandler?.({
                payload: {
                    stage: 'model_download',
                    loaded: 50,
                    total: 100,
                    percent: 50,
                },
            });
        });

        const readResult = () => result as unknown as HookResult;
        expect(readResult().speechDownloadProgress).toEqual({
            stage: 'model_download',
            loaded: 50,
            total: 100,
            percent: 50,
        });
    });

    it('downloads Whisper through the native command and stores the installed model path', async () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const showSaved = vi.fn();
        const installedPath = '/home/dd/.local/share/mindwtr/whisper-models/ggml-tiny.bin';
        tauriCoreMocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'download_whisper_model') return installedPath;
            return null;
        });
        const settings = settingsWithSpeech({
            provider: 'whisper',
            model: 'whisper-tiny',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings,
                showSaved,
            });
            return null;
        }

        render(<Probe />);

        await act(async () => {
            await result?.onDownloadWhisperModel();
        });

        expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('download_whisper_model', {
            model: 'whisper-tiny',
        });
        expect(updateSettings).toHaveBeenCalledWith({
            ai: {
                speechToText: {
                    provider: 'whisper',
                    model: 'whisper-tiny',
                    offlineModelPath: installedPath,
                },
            },
        });
        expect(showSaved).toHaveBeenCalled();
    });

    it('downloads Parakeet into the default folder and stores the installed model path', async () => {
        let result: HookResult | null = null;
        const updateSettings = vi.fn(async () => undefined);
        const showSaved = vi.fn();
        const installedPath = '/home/dd/.local/share/mindwtr/parakeet-model';
        tauriCoreMocks.invoke.mockImplementation(async (command: string) => {
            if (command === 'download_parakeet_model') return installedPath;
            return null;
        });
        const settings = settingsWithSpeech({
            provider: 'parakeet',
            model: 'parakeet-tdt-0.6b-v3-int8',
        });

        function Probe() {
            result = useAiSettings({
                isTauri: true,
                settings,
                updateSettings,
                showSaved,
            });
            return null;
        }

        render(<Probe />);

        await waitFor(() => {
            expect(result?.speechOfflineModelPath).toBe(installedPath);
        });

        await act(async () => {
            await result?.onDownloadWhisperModel();
        });

        expect(tauriCoreMocks.invoke).toHaveBeenCalledWith('download_parakeet_model', {
            model: 'parakeet-tdt-0.6b-v3-int8',
        });
        expect(updateSettings).toHaveBeenCalledWith({
            ai: {
                speechToText: {
                    provider: 'parakeet',
                    model: 'parakeet-tdt-0.6b-v3-int8',
                    offlineModelPath: installedPath,
                },
            },
        });
        expect(showSaved).toHaveBeenCalled();
    });
});
