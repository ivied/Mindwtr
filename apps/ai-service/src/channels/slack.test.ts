import { describe, it, expect } from 'bun:test'
import { HistoryBudget } from './slack'

describe('HistoryBudget', () => {
  it('allows up to perMin spends within a rolling minute', () => {
    const b = new HistoryBudget(1)
    const t0 = 1_000_000
    expect(b.canSpend(t0)).toBe(true)
    b.spend(t0)
    // Second spend in the same window is refused.
    expect(b.canSpend(t0 + 1_000)).toBe(false)
  })

  it('refills after the 60s window slides past the spend', () => {
    const b = new HistoryBudget(1)
    const t0 = 1_000_000
    b.spend(t0)
    expect(b.canSpend(t0 + 59_000)).toBe(false)
    // 60s+ later the old timestamp is pruned → budget available again.
    expect(b.canSpend(t0 + 60_001)).toBe(true)
  })

  it('honors a Retry-After penalty regardless of window', () => {
    const b = new HistoryBudget(5) // plenty of budget
    const t0 = 1_000_000
    expect(b.canSpend(t0)).toBe(true)
    b.penalize(30, t0)
    expect(b.canSpend(t0 + 29_000)).toBe(false)
    expect(b.canSpend(t0 + 30_001)).toBe(true)
  })

  it('keeps the longest penalty when penalized twice', () => {
    const b = new HistoryBudget(5)
    const t0 = 1_000_000
    b.penalize(10, t0)
    b.penalize(60, t0)
    // Shorter second penalty must not shorten the active block.
    expect(b.canSpend(t0 + 30_000)).toBe(false)
    expect(b.canSpend(t0 + 60_001)).toBe(true)
  })

  it('supports a higher budget (Marketplace/internal tier)', () => {
    const b = new HistoryBudget(3)
    const t0 = 1_000_000
    b.spend(t0)
    b.spend(t0 + 100)
    expect(b.canSpend(t0 + 200)).toBe(true)
    b.spend(t0 + 200)
    expect(b.canSpend(t0 + 300)).toBe(false)
  })
})
