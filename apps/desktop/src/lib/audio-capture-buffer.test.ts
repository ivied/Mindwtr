import { describe, expect, it } from 'vitest';

import {
    appendAudioChunkWithLimit,
    getMaxAudioSamples,
    MAX_AUDIO_RECORDING_SECONDS,
} from './audio-capture-buffer';

describe('audio capture buffer', () => {
    it('caps appended web audio chunks at the configured maximum sample count', () => {
        const chunks: Float32Array[] = [];

        const first = appendAudioChunkWithLimit({
            chunks,
            chunk: new Float32Array([1, 2, 3]),
            maxSamples: 4,
            sampleCount: 0,
        });
        const second = appendAudioChunkWithLimit({
            chunks,
            chunk: new Float32Array([4, 5, 6]),
            maxSamples: 4,
            sampleCount: first.sampleCount,
        });

        expect(first).toEqual({ sampleCount: 3, limitHit: false });
        expect(second).toEqual({ sampleCount: 4, limitHit: true });
        expect(chunks.map((chunk) => Array.from(chunk))).toEqual([[1, 2, 3], [4]]);
    });

    it('computes the maximum sample count from sample rate and duration', () => {
        expect(MAX_AUDIO_RECORDING_SECONDS).toBe(600);
        expect(getMaxAudioSamples(16_000)).toBe(9_600_000);
    });
});
