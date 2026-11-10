/**
 * Weekly subscription quota meter.
 *
 * The agents run under the user's Claude subscription, so what they really
 * spend is a share of the weekly limit, not dollars. Claude Code exposes the
 * numbers behind `/usage`; we read them before the first turn starts and after
 * each turn ends and attribute the growth to the agents. Anything the user did
 * in their own sessions meanwhile is counted too — the meter errs upward.
 *
 * Percentages come back as whole numbers, so a single cheap turn often shows
 * 0 and now and then 1; over a day the sum is right on average.
 */
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

/** Percent used per weekly window ("all", "Fable", …), 0–100. */
export type QuotaSample = Record<string, number>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Pull every weekly window out of the (experimental, loosely shaped) usage answer. */
export function weeklyWindows(rateLimits: unknown): QuotaSample {
  const out: QuotaSample = {}
  if (!rateLimits || typeof rateLimits !== 'object') return out
  const rl = rateLimits as Record<string, unknown>
  for (const [key, value] of Object.entries(rl)) {
    if (!key.startsWith('seven_day') || !value || typeof value !== 'object') continue
    const pct = num((value as { utilization?: unknown }).utilization)
    if (pct !== null) out[key] = pct
  }
  for (const list of [rl.limits, rl.model_scoped]) {
    if (!Array.isArray(list)) continue
    for (const row of list as Record<string, unknown>[]) {
      if (!row || typeof row !== 'object') continue
      if (row.group !== undefined && row.group !== 'weekly') continue
      const pct = num(row.percent) ?? num(row.utilization)
      if (pct === null) continue
      const scope = row.scope as { model?: { display_name?: unknown } } | null | undefined
      const label = String(row.display_name ?? scope?.model?.display_name ?? row.kind ?? 'weekly')
      out[`limit:${label}`] = pct
    }
  }
  return out
}

/** Growth between two samples: the window that grew the most. A window that reset counts from zero. */
export function quotaDelta(before: QuotaSample, after: QuotaSample): number {
  let delta = 0
  for (const [key, now] of Object.entries(after)) {
    const was = before[key]
    if (was === undefined) continue
    delta = Math.max(delta, now >= was ? now - was : now)
  }
  return delta
}

export type QuotaReader = () => Promise<QuotaSample | null>

/**
 * Ask Claude Code for the usage numbers without sending a prompt: the session
 * is opened, queried and closed, and costs no tokens.
 */
export const readQuota: QuotaReader = async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  async function* idle(): AsyncGenerator<never> {
    await gate
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = sdkQuery({ prompt: idle() as any, options: { settingSources: [], mcpServers: {} } }) as any
  try {
    const call = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (typeof call !== 'function') return null
    const answer = await Promise.race([
      call.call(q, { skipBehaviors: true }),
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ])
    if (!answer || !answer.rate_limits_available) return null
    const sample = weeklyWindows(answer.rate_limits)
    return Object.keys(sample).length ? sample : null
  } catch {
    return null
  } finally {
    release()
    try {
      for await (const _ of q) void _
    } catch {
      /* closing */
    }
  }
}

/** Attributes quota growth to turns without counting it twice when turns overlap. */
export class QuotaMeter {
  private active = 0
  private baseline: QuotaSample | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private read: QuotaReader = readQuota) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Call when a turn starts. */
  turnStarted(): Promise<void> {
    return this.serial(async () => {
      if (this.active++ === 0) this.baseline = await this.read()
    })
  }

  /** Call when a turn ends; returns the percent of the weekly quota used since the last reading, or null if unknown. */
  turnEnded(): Promise<number | null> {
    return this.serial(async () => {
      this.active = Math.max(0, this.active - 1)
      const now = await this.read()
      const before = this.baseline
      this.baseline = now
      return now && before ? quotaDelta(before, now) : null
    })
  }
}
