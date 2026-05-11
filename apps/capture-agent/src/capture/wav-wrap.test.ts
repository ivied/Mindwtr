import { describe, it, expect } from 'bun:test'
import { wrapPcmAsWav } from './wav-wrap'

describe('wrapPcmAsWav', () => {
  it('produces a canonical 44-byte header followed by the PCM payload', () => {
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0xff, 0x10, 0x00, 0xf0, 0xff])
    const wav = wrapPcmAsWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 })
    expect(wav.length).toBe(44 + pcm.length)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length)
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ')
    expect(wav.readUInt16LE(22)).toBe(1) // channels
    expect(wav.readUInt32LE(24)).toBe(16000) // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000 * 1 * 2) // byte rate
    expect(wav.readUInt16LE(34)).toBe(16) // bits per sample
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    expect(wav.subarray(44).equals(pcm)).toBe(true)
  })

  it('computes byte rate and block align from channels/bits', () => {
    const wav = wrapPcmAsWav(Buffer.alloc(0), { sampleRate: 48000, channels: 2, bitsPerSample: 24 })
    expect(wav.readUInt32LE(28)).toBe(48000 * 2 * 3)
    expect(wav.readUInt16LE(32)).toBe(2 * 3)
  })
})
