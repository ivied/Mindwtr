import { describe, it, expect } from 'bun:test'
import { ProposalStore } from './store'
import type { CapturedItem } from '../capture/normalizer'

const item: CapturedItem = {
  text: 'hi',
  sourceChannel: 'screen_capture',
  type: 'text',
  timestamp: '2026-04-24T10:00:00Z',
}
const proposal = {
  is_actionable: true,
  title: 'Do thing',
  reasoning: 'r',
  confidence: 0.9,
}

describe('ProposalStore', () => {
  it('adds and takes a proposal once', () => {
    const s = new ProposalStore()
    const entry = s.add(item, proposal)
    expect(entry.id).toBeDefined()
    expect(s.size()).toBe(1)
    const taken = s.take(entry.id)
    expect(taken?.proposal.title).toBe('Do thing')
    expect(s.size()).toBe(0)
    expect(s.take(entry.id)).toBeNull()
  })

  it('returns null for unknown id', () => {
    const s = new ProposalStore()
    expect(s.take('missing')).toBeNull()
  })

  it('evicts oldest when over capacity', () => {
    const s = new ProposalStore({ capacity: 2, ttlMs: 60_000 })
    const a = s.add(item, proposal)
    const b = s.add(item, proposal)
    const c = s.add(item, proposal)
    expect(s.size()).toBe(2)
    expect(s.take(a.id)).toBeNull()
    expect(s.take(b.id)).not.toBeNull()
    expect(s.take(c.id)).not.toBeNull()
  })

  it('evicts entries older than TTL on access', () => {
    let now = 1_000_000
    const s = new ProposalStore({ capacity: 10, ttlMs: 1_000 }, () => now)
    const a = s.add(item, proposal)
    now += 2_000
    expect(s.size()).toBe(0)
    expect(s.take(a.id)).toBeNull()
  })
})
