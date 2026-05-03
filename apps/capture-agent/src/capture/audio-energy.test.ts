import { describe, it, expect } from 'bun:test'
import { computeEnergy } from './audio-energy'

/** Build a fake WAV: 44-byte header + N int16 samples at given amplitude. */
function fakeWav(amplitudes: number[]): Buffer {
  const samples = amplitudes.length
  const header = Buffer.alloc(44)
  // We don't fill RIFF fields — computeEnergy only skips first 44 bytes.
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(amplitudes[i]!, i * 2)
  }
  return Buffer.concat([header, data])
}

describe('computeEnergy', () => {
  it('returns rms=0 when buffer is empty / header-only', () => {
    expect(computeEnergy(Buffer.alloc(40)).rms).toBe(0)
    expect(computeEnergy(Buffer.alloc(44)).rms).toBe(0)
    expect(computeEnergy(Buffer.alloc(44)).hasSignal).toBe(false)
  })

  it('returns rms~1.0 for max amplitude samples', () => {
    const buf = fakeWav([32767, -32768, 32767, -32768])
    const r = computeEnergy(buf)
    expect(r.rms).toBeGreaterThan(0.99)
    expect(r.hasSignal).toBe(true)
  })

  it('returns rms~0 for silence', () => {
    const buf = fakeWav([0, 0, 0, 0, 0, 0])
    const r = computeEnergy(buf)
    expect(r.rms).toBe(0)
    expect(r.hasSignal).toBe(false)
  })

  it('respects custom threshold', () => {
    // Quiet audio (small amplitude, RMS ~0.003)
    const buf = fakeWav([100, -100, 100, -100])
    const lowThreshold = computeEnergy(buf, 0.001)
    const highThreshold = computeEnergy(buf, 0.5)
    expect(lowThreshold.hasSignal).toBe(true)
    expect(highThreshold.hasSignal).toBe(false)
    expect(lowThreshold.rms).toBeCloseTo(highThreshold.rms, 6)
  })
})
