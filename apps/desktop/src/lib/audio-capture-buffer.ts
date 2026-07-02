export const MAX_AUDIO_RECORDING_SECONDS = 10 * 60;

export const getMaxAudioSamples = (sampleRate: number, durationSeconds = MAX_AUDIO_RECORDING_SECONDS): number => (
    Math.max(1, Math.floor(Math.max(1, sampleRate) * durationSeconds))
);

export const appendAudioChunkWithLimit = ({
    chunks,
    chunk,
    maxSamples,
    sampleCount,
}: {
    chunks: Float32Array[];
    chunk: Float32Array;
    maxSamples: number;
    sampleCount: number;
}): { sampleCount: number; limitHit: boolean } => {
    const remaining = Math.max(0, maxSamples - sampleCount);
    if (remaining === 0) {
        return { sampleCount, limitHit: true };
    }
    if (chunk.length <= remaining) {
        chunks.push(new Float32Array(chunk));
        const nextSampleCount = sampleCount + chunk.length;
        return { sampleCount: nextSampleCount, limitHit: nextSampleCount >= maxSamples };
    }
    chunks.push(new Float32Array(chunk.slice(0, remaining)));
    return { sampleCount: maxSamples, limitHit: true };
};
