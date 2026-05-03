import { describe, it, expect } from 'bun:test'
import { l0Filter } from './l0-filter'

describe('l0Filter', () => {
  it('rejects too-short text', () => {
    const r = l0Filter('hi')
    expect(r.pass).toBe(false)
    expect(r.reasons).toContain('too-short')
  })

  it('passes on EN commitment verb', () => {
    const r = l0Filter("I'll send the report tomorrow morning before standup")
    expect(r.pass).toBe(true)
    expect(r.reasons.some((x) => x.startsWith('verb:'))).toBe(true)
  })

  it('passes on RU commitment verb', () => {
    const r = l0Filter('Завтра позвоню Алисе по поводу проекта Q4')
    expect(r.pass).toBe(true)
    expect(r.reasons.some((x) => x.startsWith('verb:'))).toBe(true)
  })

  it('passes on deadline word alone', () => {
    const r = l0Filter('Project deadline is approaching for the team this week')
    expect(r.pass).toBe(true)
    expect(r.reasons.some((x) => x.startsWith('deadline:'))).toBe(true)
  })

  it('passes on money pattern', () => {
    const r = l0Filter('Acme invoice for $500.00 received from finance team')
    expect(r.pass).toBe(true)
    expect(r.reasons).toContain('money')
  })

  it('rejects neutral text without any cues', () => {
    const r = l0Filter('The weather is nice and the cat is sleeping peacefully on the rug')
    expect(r.pass).toBe(false)
    expect(r.reasons.length).toBe(0)
  })

  it('rejects code-looking content with no commitment cues', () => {
    const r = l0Filter('function main() { return 42 + 1; } // comment about arithmetic')
    expect(r.pass).toBe(false)
  })

  it('passes on phone number pattern', () => {
    const r = l0Filter('Customer called from +1 415 555 0123 about service question')
    expect(r.pass).toBe(true)
    expect(r.reasons).toContain('phone')
  })
})
