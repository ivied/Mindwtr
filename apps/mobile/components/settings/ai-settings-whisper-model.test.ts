import { describe, expect, it } from 'vitest';

import {
    describeWhisperDownloadUrl,
    downloadWhisperModelFile,
    resolveWhisperModelDownloadUrl,
    resolveWhisperNativeFsModule,
    isWhisperModelFileReady,
    isWhisperModelSafeDeleteTarget,
    verifyWhisperModelFileHash,
    type WhisperModelDescriptor,
} from './ai-settings-whisper-model';

const minBytes = 50 * 1024 * 1024;
const sizeBytes = 77691713;
const sha256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21';

const model: WhisperModelDescriptor = {
    id: 'whisper-tiny',
    fileName: 'ggml-tiny.bin',
    label: 'whisper-tiny',
    minBytes,
    sizeBytes,
    sha256,
};

describe('ai settings whisper model helpers', () => {
    it('requires a complete-looking model file before marking it ready', () => {
        expect(isWhisperModelFileReady(model, { exists: true, isDirectory: false, size: sizeBytes })).toBe(true);
        expect(isWhisperModelFileReady(model, { exists: true, isDirectory: false, size: sizeBytes - 1 })).toBe(false);
        expect(isWhisperModelFileReady(model, { exists: true, isDirectory: false, size: sizeBytes + 1 })).toBe(false);
        expect(isWhisperModelFileReady(model, { exists: true, isDirectory: true, size: sizeBytes })).toBe(false);
        expect(isWhisperModelFileReady(model, { exists: false, isDirectory: false, size: sizeBytes })).toBe(false);
    });

    it('accepts exact native bytesWritten when Expo file info omits size after streaming download', () => {
        const infoWithoutSize = { exists: true, isDirectory: false };

        expect(isWhisperModelFileReady(model, infoWithoutSize)).toBe(false);
        expect(isWhisperModelFileReady(model, infoWithoutSize, sizeBytes)).toBe(true);
        expect(isWhisperModelFileReady(model, infoWithoutSize, sizeBytes - 1)).toBe(false);
        expect(isWhisperModelFileReady(model, infoWithoutSize, sizeBytes + 1)).toBe(false);
    });

    it('only allows deletion of exact known model files', () => {
        const allowed = ['file:///document/whisper-models/ggml-tiny.bin'];

        expect(isWhisperModelSafeDeleteTarget({
            uri: 'file:///document/whisper-models/ggml-tiny.bin',
            fileName: model.fileName,
            allowedUris: allowed,
        })).toBe(true);
        expect(isWhisperModelSafeDeleteTarget({
            uri: 'file:///document/notes/ggml-tiny.bin',
            fileName: model.fileName,
            allowedUris: allowed,
        })).toBe(false);
        expect(isWhisperModelSafeDeleteTarget({
            uri: 'file:///document/whisper-models/other.bin',
            fileName: model.fileName,
            allowedUris: allowed,
        })).toBe(false);
    });

    it('rejects model files whose SHA-256 does not match the pinned digest', async () => {
        await expect(verifyWhisperModelFileHash(
            model,
            'file:///document/whisper-models/ggml-tiny.bin',
            async () => '0000000000000000000000000000000000000000000000000000000000000000'
        )).rejects.toThrow('Whisper model SHA-256 mismatch');

        await expect(verifyWhisperModelFileHash(
            model,
            'file:///document/whisper-models/ggml-tiny.bin',
            async () => sha256.toUpperCase()
        )).resolves.toBeUndefined();
    });

    it('describes download URLs without logging signed query tokens', () => {
        expect(describeWhisperDownloadUrl('https://cdn.example.test/signed/ggml-tiny.bin?token=secret')).toEqual({
            scheme: 'https',
            host: 'cdn.example.test',
            path: '/signed/ggml-tiny.bin',
            hasQuery: true,
        });
    });


    it('resolves a native downloader from a default-exported react-native-fs module', () => {
        const nativeFs = {
            downloadFile: () => ({
                promise: Promise.resolve({ statusCode: 200, bytesWritten: sizeBytes }),
            }),
        };

        expect(resolveWhisperNativeFsModule({ default: nativeFs })).toBe(nativeFs);
        expect(resolveWhisperNativeFsModule({ hash: async () => sha256 })).toBeNull();
    });

    it('does not fall back to Expo buffered downloads when native streaming is unavailable', async () => {
        let expoUsed = false;

        await expect(downloadWhisperModelFile({
            url: 'https://example.test/ggml-tiny.bin',
            targetFile: { uri: 'file:///document/whisper-models/ggml-tiny.bin' },
            nativeFs: null,
            expoDownloadFile: async (_url, targetFile) => {
                expoUsed = true;
                return targetFile;
            },
        })).rejects.toThrow('Native streaming Whisper model downloads are unavailable');
        expect(expoUsed).toBe(false);
    });

    it('resolves a Hugging Face redirect location from HEAD without downloading the model', async () => {
        const calls: Array<{ url: string; init: { method?: string; redirect?: string } }> = [];
        const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
        const resolved = await resolveWhisperModelDownloadUrl(
            'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
            async (url, init) => {
                calls.push({ url: String(url), init: init as { method?: string; redirect?: string } });
                return {
                    url: String(url),
                    headers: {
                        get: (name: string) => name.toLowerCase() === 'location'
                            ? 'https://cdn.example.test/signed/ggml-tiny.bin?token=abc'
                            : null,
                    },
                } as Response;
            },
            (event, details) => { logs.push({ event, details }); }
        );

        expect(resolved).toBe('https://cdn.example.test/signed/ggml-tiny.bin?token=abc');
        expect(calls).toEqual([expect.objectContaining({
            init: expect.objectContaining({ method: 'HEAD', redirect: 'manual' }),
        })]);
        expect(logs.map((entry) => entry.event)).toEqual([
            'resolve-url-head-start',
            'resolve-url-head-location',
            'resolve-url-complete',
        ]);
        expect(logs[1]?.details?.location).toEqual({
            scheme: 'https',
            host: 'cdn.example.test',
            path: '/signed/ggml-tiny.bin',
            hasQuery: true,
        });
    });

    it('uses a resolved final URL for native Whisper downloads', async () => {
        const calls: unknown[] = [];
        const logs: Array<{ event: string; details?: Record<string, unknown> }> = [];
        const targetFile = { uri: 'file:///document/whisper-models/ggml-tiny.bin' };

        await downloadWhisperModelFile({
            url: 'https://example.test/redirect/ggml-tiny.bin',
            targetFile,
            nativeFs: {
                downloadFile: (options: unknown) => {
                    calls.push(options);
                    return {
                        promise: Promise.resolve({ statusCode: 200, bytesWritten: sizeBytes }),
                    };
                },
            },
            resolveDownloadUrl: async () => 'https://cdn.example.test/final/ggml-tiny.bin?token=abc',
            logger: (event, details) => { logs.push({ event, details }); },
            expoDownloadFile: async () => {
                throw new Error('Expo download should not be used when native streaming is available');
            },
        });

        expect(calls).toEqual([expect.objectContaining({
            fromUrl: 'https://cdn.example.test/final/ggml-tiny.bin?token=abc',
        })]);
        expect(logs.map((entry) => entry.event)).toEqual([
            'native-download-start',
            'native-download-complete',
        ]);
        expect(logs[0]?.details?.finalUrlParts).toEqual({
            scheme: 'https',
            host: 'cdn.example.test',
            path: '/final/ggml-tiny.bin',
            hasQuery: true,
        });
    });

    it('prefers native streaming downloads for Whisper models', async () => {
        const calls: unknown[] = [];
        const targetFile = { uri: 'file:///document/whisper-models/ggml-tiny.bin' };
        const nativeFs = {
            downloadFile: (options: unknown) => {
                calls.push(options);
                return {
                    promise: Promise.resolve({ statusCode: 200, bytesWritten: sizeBytes }),
                };
            },
        };

        const result = await downloadWhisperModelFile({
            url: 'https://example.test/ggml-tiny.bin',
            targetFile,
            nativeFs,
            expoDownloadFile: async () => {
                throw new Error('Expo download should not be used when native streaming is available');
            },
        });

        expect(result.file).toBe(targetFile);
        expect(result.bytesWritten).toBe(sizeBytes);
        expect(calls).toEqual([expect.objectContaining({
            fromUrl: 'https://example.test/ggml-tiny.bin',
            toFile: '/document/whisper-models/ggml-tiny.bin',
        })]);
    });

    it('rejects non-2xx native Whisper downloads before file-size validation', async () => {
        let deleted = false;

        await expect(downloadWhisperModelFile({
            url: 'https://example.test/ggml-tiny.bin',
            targetFile: {
                uri: 'file:///document/whisper-models/ggml-tiny.bin',
                delete: () => { deleted = true; },
            },
            nativeFs: {
                downloadFile: () => ({
                    promise: Promise.resolve({ statusCode: 302, bytesWritten: 1093 }),
                }),
            },
            expoDownloadFile: async () => {
                throw new Error('Expo download should not be used when native streaming is available');
            },
        })).rejects.toThrow('HTTP 302');
        expect(deleted).toBe(true);
    });

});
