import { describe, it, expect } from 'bun:test'
import { CaptureDeduper } from './dedup'

const sample = {
  app: 'Code',
  windowTitle: 'index.ts — GTD',
  ocrText: 'function main() { return 42 }',
}

describe('CaptureDeduper', () => {
  it('first capture is never a duplicate', () => {
    const d = new CaptureDeduper()
    expect(d.isDuplicate(sample)).toBe(false)
  })

  it('returns true when same capture replays inside cooldown', () => {
    let now = 1_000_000
    const d = new CaptureDeduper({ cooldownMs: 5 * 60 * 1000, ocrPrefixChars: 200 }, () => now)
    expect(d.isDuplicate(sample)).toBe(false)
    d.markSent(sample)
    now += 60_000 // 1 min later
    expect(d.isDuplicate(sample)).toBe(true)
  })

  it('returns false when cooldown elapses', () => {
    let now = 1_000_000
    const d = new CaptureDeduper({ cooldownMs: 5 * 60 * 1000, ocrPrefixChars: 200 }, () => now)
    d.markSent(sample)
    now += 6 * 60 * 1000
    expect(d.isDuplicate(sample)).toBe(false)
  })

  it('returns false when window title changes', () => {
    const d = new CaptureDeduper(undefined, () => 1_000_000)
    d.markSent(sample)
    expect(d.isDuplicate({ ...sample, windowTitle: 'other.ts' })).toBe(false)
  })

  it('returns false when app changes', () => {
    const d = new CaptureDeduper(undefined, () => 1_000_000)
    d.markSent(sample)
    expect(d.isDuplicate({ ...sample, app: 'Cursor' })).toBe(false)
  })

  it('treats OCR changes beyond prefix as the same fingerprint', () => {
    let now = 1_000_000
    const d = new CaptureDeduper({ cooldownMs: 60_000, ocrPrefixChars: 10 }, () => now)
    d.markSent({ ...sample, ocrText: 'AAAAAAAAAA followed by changing tail #1' })
    now += 1_000
    const dup = d.isDuplicate({ ...sample, ocrText: 'AAAAAAAAAA followed by changing tail #2' })
    expect(dup).toBe(true)
  })

  it('detects change when OCR prefix differs', () => {
    let now = 1_000_000
    const d = new CaptureDeduper({ cooldownMs: 60_000, ocrPrefixChars: 10 }, () => now)
    d.markSent({ ...sample, ocrText: 'AAAAAAAAAA tail' })
    now += 1_000
    const dup = d.isDuplicate({ ...sample, ocrText: 'BBBBBBBBBB tail' })
    expect(dup).toBe(false)
  })
})
