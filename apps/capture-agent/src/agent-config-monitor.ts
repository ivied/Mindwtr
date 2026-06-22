/**
 * AgentConfigMonitor — polls ai-service /v1/agent-config so the web Control
 * Center's pause switch takes effect on the capture-agent (Phase 3). Mirrors
 * RecordingMonitor: silent on transient errors, keeps last-known state so a
 * brief outage doesn't flip capture on/off.
 *
 * Fail-safe bias: if we've never reached the server, default to NOT paused
 * (observe) — but once we've seen a `true`, a network blip keeps it paused.
 */

export interface AgentConfigMonitorConfig {
  endpoint: string;
  authToken: string;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
}

export class AgentConfigMonitor {
  private capturePaused = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number;
  private readonly base: string;

  constructor(private readonly config: AgentConfigMonitorConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 5000;
    this.base = config.endpoint.replace(/\/$/, '');
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  isCapturePaused(): boolean {
    return this.capturePaused;
  }

  private async tick(): Promise<void> {
    try {
      const res = await fetch(`${this.base}/v1/agent-config`, {
        headers: { Authorization: `Bearer ${this.config.authToken}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { capturePaused?: boolean };
      const next = Boolean(data.capturePaused);
      if (next !== this.capturePaused) {
        this.capturePaused = next;
        this.config.log?.(`[agent-config] capture ${next ? 'PAUSED' : 'resumed'} (remote)`);
      }
    } catch {
      /* keep last-known state */
    }
  }
}
