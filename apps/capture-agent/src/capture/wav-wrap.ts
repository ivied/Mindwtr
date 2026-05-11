/**
 * Wrap raw PCM bytes in a minimal canonical WAV header (44 bytes,
 * RIFF/WAVE/fmt /data). Whisper accepts WAV uploads natively, so this
 * is how the native recorder makes its stdout pipe consumable by the
 * same code path as the ffmpeg recorder.
 */

export interface PcmFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export function wrapPcmAsWav(pcm: Buffer, fmt: PcmFormat): Buffer {
  const { sampleRate, channels, bitsPerSample } = fmt
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  const dataSize = pcm.length
  const header = Buffer.alloc(44)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')

  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size for PCM
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)

  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcm])
}
