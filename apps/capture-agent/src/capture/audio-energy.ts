/**
 * Energy-based silence detector for raw audio chunks.
 *
 * We compute RMS (root-mean-square) over the PCM samples and compare against
 * a threshold. Below threshold = effectively silence → skip Whisper to save
 * cost and avoid empty transcripts.
 *
 * Default threshold (0.005) is calibrated for typical desk recording with
 * ambient room noise. Tune via env if needed.
 *
 * Pure function for trivial unit testing.
 */

/** Minimum WAV header length we expect before sample data. */
const WAV_HEADER_BYTES = 44

export interface EnergyResult {
  rms: number
  /** True when audio is loud enough to be worth transcribing */
  hasSignal: boolean
}

/**
 * Compute RMS of 16-bit signed PCM samples in a WAV file buffer.
 *
 * Assumes:
 *   - WAV format (skips first 44 bytes — standard PCM header)
 *   - 16-bit signed little-endian samples
 *   - mono (channel layout doesn't change RMS calc)
 */
export function computeEnergy(wavBuffer: Buffer, threshold = 0.005): EnergyResult {
  if (wavBuffer.length <= WAV_HEADER_BYTES) {
    return { rms: 0, hasSignal: false }
  }

  // Slice off WAV header
  const samples = wavBuffer.subarray(WAV_HEADER_BYTES)
  const sampleCount = Math.floor(samples.length / 2)
  if (sampleCount === 0) return { rms: 0, hasSignal: false }

  let sumSquares = 0
  for (let i = 0; i < sampleCount; i++) {
    // 16-bit signed little-endian → range [-32768, 32767]
    const sample = samples.readInt16LE(i * 2) / 32768
    sumSquares += sample * sample
  }

  const rms = Math.sqrt(sumSquares / sampleCount)
  return { rms, hasSignal: rms >= threshold }
}
