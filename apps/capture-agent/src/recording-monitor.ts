/**
 * RecordingMonitor — polls ai-service /v1/recordings/active so the agent
 * can switch into intensified mode (10s screenshots) while a task-grounded
 * recording session is live, and tag every capture with the session id.
 *
 * Stays silent on transient network errors — last-known state is kept so
 * a brief outage doesn't flip the agent in/out of intensified mode.
 */

export interface RecordingMonitorConfig {
  /** ai-service base URL, e.g. http://localhost:3030 */
  endpoint: string
  /** Bearer token. */
  authToken: string
  /** Poll interval. Default 5000ms. */
  pollIntervalMs?: number
  /** Log sink. */
  log?: (msg: string) => void
}

export interface ActiveRecording {
  sessionId: string
  taskId: string
  taskTitle: string | null
}

export class RecordingMonitor {
  private active: ActiveRecording | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly pollIntervalMs: number
  private readonly base: string

  constructor(private readonly config: RecordingMonitorConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 5000
    this.base = config.endpoint.replace(/\/$/, '')
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getActive(): ActiveRecording | null {
    return this.active
  }

  /** Source-meta block to merge into capture uploads while a session is live. */
  getCaptureMeta(): Record<string, unknown> | null {
    if (!this.active) return null
    return {
      recording_session_id: this.active.sessionId,
      task_id: this.active.taskId,
    }
  }

  private async tick(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/v1/recordings/active`, {
        headers: { Authorization: `Bearer ${this.config.authToken}` },
      })
      if (!res.ok) return
      const data = (await res.json()) as { session: { id: string; taskId: string; taskTitle: string | null } | null }
      const next = data.session
        ? { sessionId: data.session.id, taskId: data.session.taskId, taskTitle: data.session.taskTitle }
        : null
      const transitioned =
        (next?.sessionId ?? null) !== (this.active?.sessionId ?? null)
      this.active = next
      if (transitioned && this.config.log) {
        this.config.log(
          next
            ? `[recording] session active: ${next.taskTitle ?? next.taskId} (${next.sessionId.slice(0, 8)})`
            : `[recording] session ended`
        )
      }
    } catch {
      // Silent — keep last-known state across transient network blips.
    }
  }
}
