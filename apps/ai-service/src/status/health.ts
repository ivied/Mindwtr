/**
 * HealthMonitor — real component checks behind GET /health, plus a
 * transition-based Telegram alerter. Replaces the static `{ok:true}`:
 * every prod incident so far (DB corruption, Slack 429 storm, capture
 * stall) was discovered by symptom because nothing watched the parts.
 */

import type { Database } from 'bun:sqlite'
import type { Bot } from 'grammy'

export interface HealthComponent {
  ok: boolean
  detail?: string
}

export interface HealthReport {
  ok: boolean
  components: Record<string, HealthComponent>
  checkedAt: string
}

export interface HealthMonitorOptions {
  db: Database
  cloudHealthCheck: () => Promise<boolean>
  /** Minutes without any new capture row before the capture feed is flagged. */
  captureStaleMinutes?: number
  now?: () => Date
}

const DEFAULT_CAPTURE_STALE_MINUTES = 240

export class HealthMonitor {
  private db: Database
  private cloudHealthCheck: () => Promise<boolean>
  private captureStaleMs: number
  private now: () => Date

  constructor(options: HealthMonitorOptions) {
    this.db = options.db
    this.cloudHealthCheck = options.cloudHealthCheck
    this.captureStaleMs =
      (options.captureStaleMinutes ?? DEFAULT_CAPTURE_STALE_MINUTES) * 60 * 1000
    this.now = options.now ?? (() => new Date())
  }

  async check(): Promise<HealthReport> {
    const components: Record<string, HealthComponent> = {
      db: this.checkDb(),
      cloud: await this.checkCloud(),
      captureFeed: this.checkCaptureFeed(),
      distiller: this.checkDistiller(),
    }
    return {
      ok: Object.values(components).every((c) => c.ok),
      components,
      checkedAt: this.now().toISOString(),
    }
  }

  private checkDb(): HealthComponent {
    try {
      this.db.query('SELECT 1').get()
      return { ok: true }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  private async checkCloud(): Promise<HealthComponent> {
    try {
      const ok = await this.cloudHealthCheck()
      return ok ? { ok: true } : { ok: false, detail: 'health check returned false' }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  private checkCaptureFeed(): HealthComponent {
    try {
      const row = this.db
        .query<{ last: string | null }, []>('SELECT MAX(received_at) AS last FROM captures')
        .get()
      if (!row?.last) return { ok: true, detail: 'no captures yet' }
      const ageMs = this.now().getTime() - new Date(row.last).getTime()
      const ageMin = Math.round(ageMs / 60_000)
      if (ageMs > this.captureStaleMs) {
        return { ok: false, detail: `last capture ${ageMin}m ago` }
      }
      return { ok: true, detail: `last capture ${ageMin}m ago` }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  private checkDistiller(): HealthComponent {
    try {
      const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000).toISOString()
      const row = this.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM recording_sessions
           WHERE distillation_status = 'failed' AND stopped_at >= ?`
        )
        .get(since)
      const failed = row?.n ?? 0
      if (failed > 0) return { ok: false, detail: `${failed} failed distillation(s) in 24h` }
      return { ok: true }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }
}

export interface HealthAlerterOptions {
  monitor: HealthMonitor
  bot: Bot
  notifyChatId: string
  intervalMs?: number
  log?: (msg: string) => void
}

/**
 * Polls the monitor and pings Telegram only on state transitions
 * (healthy→degraded with the failing components, degraded→healthy as
 * recovery). Component-level dedup: a component that stays broken is
 * reported once, not every tick.
 */
export class HealthAlerter {
  private monitor: HealthMonitor
  private bot: Bot
  private chatId: string
  private intervalMs: number
  private log: (msg: string) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFailing = new Set<string>()

  constructor(options: HealthAlerterOptions) {
    this.monitor = options.monitor
    this.bot = options.bot
    this.chatId = options.notifyChatId
    this.intervalMs = options.intervalMs ?? 5 * 60 * 1000
    this.log = options.log ?? ((msg) => console.log(msg))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    let report: HealthReport
    try {
      report = await this.monitor.check()
    } catch (err) {
      this.log(`[health] check crashed: ${(err as Error).message}`)
      return
    }

    const failing = new Set(
      Object.entries(report.components)
        .filter(([, c]) => !c.ok)
        .map(([name]) => name)
    )

    const newlyFailing = [...failing].filter((n) => !this.lastFailing.has(n))
    const recovered = [...this.lastFailing].filter((n) => !failing.has(n))
    this.lastFailing = failing

    if (newlyFailing.length === 0 && recovered.length === 0) return

    const lines: string[] = []
    if (newlyFailing.length > 0) {
      lines.push('🔴 <b>GTD health degraded</b>')
      for (const name of newlyFailing) {
        const detail = report.components[name]?.detail
        lines.push(`• ${name}${detail ? `: ${escapeHtml(detail)}` : ''}`)
      }
    }
    if (recovered.length > 0) {
      lines.push(`🟢 recovered: ${recovered.join(', ')}`)
    }

    try {
      await this.bot.api.sendMessage(this.chatId, lines.join('\n'), { parse_mode: 'HTML' })
    } catch (err) {
      this.log(`[health] TG alert failed: ${(err as Error).message}`)
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
