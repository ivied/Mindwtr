import { beforeEach, describe, expect, it, vi } from 'vitest';

import { processAudioCapture } from './speech-to-text';

const tauriMocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
    invoke: tauriMocks.invoke,
}));

describe('processAudioCapture desktop local ASR providers', () => {
    beforeEach(() => {
        tauriMocks.invoke.mockReset();
        (window as typeof window & { __TAURI__?: unknown }).__TAURI__ = {};
    });

    it('invokes the sherpa-onnx Parakeet command with local audio and model paths', async () => {
        tauriMocks.invoke.mockResolvedValueOnce(' Call Marc tomorrow. ');

        const result = await processAudioCapture(
            {
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'audio/wav',
                name: 'capture.wav',
                path: '/tmp/capture.wav',
            },
            {
                provider: 'parakeet',
                model: 'parakeet-tdt-0.6b-v3-int8',
                modelPath: '/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
                language: 'en',
            },
        );

        expect(result).toEqual({ transcript: 'Call Marc tomorrow.' });
        expect(tauriMocks.invoke).toHaveBeenCalledWith('transcribe_parakeet', {
            modelPath: '/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
            audioPath: '/tmp/capture.wav',
            language: 'en',
        });
    });

    it('extracts transcript text from structured local ASR JSON output', async () => {
        tauriMocks.invoke.mockResolvedValueOnce('{"lang":"","emotion":"","event":"","text":"Call Marc tomorrow."}');

        const result = await processAudioCapture(
            {
                bytes: new Uint8Array([1, 2, 3]),
                mimeType: 'audio/wav',
                name: 'capture.wav',
                path: '/tmp/capture.wav',
            },
            {
                provider: 'parakeet',
                model: 'parakeet-tdt-0.6b-v3-int8',
                modelPath: '/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
                language: 'en',
            },
        );

        expect(result).toEqual({ transcript: 'Call Marc tomorrow.' });
    });
});
