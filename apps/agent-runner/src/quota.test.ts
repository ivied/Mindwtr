import { describe, expect, it } from 'bun:test'
import { QuotaMeter, quotaDelta, weeklyWindows, type QuotaSample } from './quota'

describe('weekly windows', () => {
  it('reads the overall and the per-model weekly limits, ignoring everything else', () => {
    const sample = weeklyWindows({
      five_hour: { utilization: 80 },
      seven_day: { utilization: 10, resets_at: 'x' },
      seven_day_opus: null,
      extra_usage: { is_enabled: false, utilization: null },
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 10 },
        { kind: 'weekly_scoped', group: 'weekly', percent: 13, scope: { model: { display_name: 'Fable' } } },
        { kind: 'session', group: 'session', percent: 70 },
      ],
    })
    expect(sample).toEqual({ seven_day: 10, 'limit:weekly_all': 10, 'limit:Fable': 13 })
    expect(weeklyWindows(null)).toEqual({})
  })

  it('takes the window that grew the most and restarts from zero after a reset', () => {
    expect(quotaDelta({ a: 10, b: 13 }, { a: 11, b: 16 })).toBe(3)
    expect(quotaDelta({ a: 97 }, { a: 2 })).toBe(2)
    expect(quotaDelta({ a: 10 }, { a: 10, fresh: 40 })).toBe(0)
  })
})

describe('meter', () => {
  const reader = (values: (QuotaSample | null)[]) => {
    let i = 0
    return async () => values[Math.min(i++, values.length - 1)] ?? null
  }

  it('does not count the same growth twice when turns overlap', async () => {
    const meter = new QuotaMeter(reader([{ w: 10 }, { w: 12 }, { w: 15 }]))
    await meter.turnStarted() // reads 10
    await meter.turnStarted() // overlapping: no new baseline
    expect(await meter.turnEnded()).toBe(2)
    expect(await meter.turnEnded()).toBe(3)
  })

  it('ignores what happened between turns', async () => {
    const meter = new QuotaMeter(reader([{ w: 10 }, { w: 11 }, { w: 30 }, { w: 31 }]))
    await meter.turnStarted()
    expect(await meter.turnEnded()).toBe(1)
    await meter.turnStarted() // the user spent 19% on their own in between
    expect(await meter.turnEnded()).toBe(1)
  })

  it('reports nothing when the numbers are unavailable', async () => {
    const meter = new QuotaMeter(reader([null, { w: 5 }]))
    await meter.turnStarted()
    expect(await meter.turnEnded()).toBeNull()
  })
})
