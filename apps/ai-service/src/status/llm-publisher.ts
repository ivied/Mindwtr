/**
 * LlmPublisher — writes the last N LLM verdicts (from Proposer and Enricher)
 * to a JSON snapshot file consumed by the macOS pipeline widget. Companion
 * to capture-agent's StatusPublisher: capture-agent publishes raw capture
 * state, this publishes what the LLM made of it.
 *
 * One file rather than two writers per file: avoids a write race on the
 * combined snapshot. Widget reads both and merges in-memory.
 *
 * Disabled when filePath is empty/undefined so unit tests and the no-status
 * deploys work unchanged.
 */

import { writeFile, rename } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'

export type LlmVerdictChannel = 'screen' | 'audio' | 'telegram' | 'enricher' | 'unknown'

export type LlmVerdictKind =
  | 'created'              // Proposer → confident actionable → Writer stored proposal
  | 'duplicate'            // Writer found existing proposal/inbox match
  | 'duplicate-of-existing'// Proposer flagged duplicate inline
  | 'completes-existing'   // Proposer says capture reports an existing item as done
  | 'not-actionable'
  | 'low-confidence'
  | 'wrong-role'
  | 'enriched-modify'      // Enricher patched task
  | 'enriched-split'       // Enricher split into project + sub-actions
  | 'enriched-noop'        // Enricher saw nothing to add
  | 'error'

export interface LlmVerdict {
  ts: string
  channel: LlmVerdictChannel
  kind: LlmVerdictKind
  title: string
  confidence?: number
  category?: string
  /** Reasoning excerpt (≤600 chars) — widget shows the latest in full. */
  reasoning?: string
  /** Comma-joined diff fields when Enricher patched a task. */
  diff?: string
}

export interface LlmSnapshot {
  updatedAt: string
  verdicts: LlmVerdict[]
}

export interface LlmPublisherOptions {
  filePath: string
  /** How many verdicts to keep in the ring buffer. Default 10. */
  capacity?: number
  /** Min ms between disk writes. Default 500. */
  debounceMs?: number
}

export class LlmPublisher {
  private readonly filePath: string
  private readonly capacity: number
  private readonly debounceMs: number
  private readonly verdicts: LlmVerdict[] = []
  private writeTimer: NodeJS.Timeout | null = null
  private writing = false
  private dirty = false

  constructor(opts: LlmPublisherOptions) {
    this.filePath = opts.filePath
    this.capacity = opts.capacity ?? 10
    this.debounceMs = opts.debounceMs ?? 500
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmPublisher | null {
    const p = env.LLM_STATUS_FILE
    if (!p) return null
    return new LlmPublisher({ filePath: p })
  }

  record(v: Omit<LlmVerdict, 'ts'> & Partial<Pick<LlmVerdict, 'ts'>>): void {
    const verdict: LlmVerdict = {
      ts: v.ts ?? new Date().toISOString(),
      channel: v.channel,
      kind: v.kind,
      title: (v.title ?? '').slice(0, 200),
      confidence: v.confidence,
      category: v.category,
      reasoning: v.reasoning ? v.reasoning.slice(0, 600) : undefined,
      diff: v.diff,
    }
    this.verdicts.unshift(verdict)
    if (this.verdicts.length > this.capacity) {
      this.verdicts.length = this.capacity
    }
    this.scheduleWrite()
  }

  private scheduleWrite(): void {
    this.dirty = true
    if (this.writeTimer) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.flush()
    }, this.debounceMs)
  }

  private async flush(): Promise<void> {
    if (this.writing) {
      this.scheduleWrite()
      return
    }
    if (!this.dirty) return
    this.writing = true
    this.dirty = false
    const snap: LlmSnapshot = {
      updatedAt: new Date().toISOString(),
      verdicts: this.verdicts,
    }
    const payload = JSON.stringify(snap, null, 2)
    // Temp file lives in the SAME directory as the target so rename(2) stays
    // on one device. In the docker container, /tmp is overlayfs and the
    // target is a bind mount — rename across them fails with EXDEV.
    const tmp = join(dirname(this.filePath), `.${basename(this.filePath)}.${process.pid}.tmp`)
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.filePath)
    } catch (err) {
      console.warn(`[llm-status] write failed: ${(err as Error).message}`)
    } finally {
      this.writing = false
    }
  }

  async shutdown(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    await this.flush()
  }
}

export function sourceChannelToVerdict(source: string | null | undefined): LlmVerdictChannel {
  switch (source) {
    case 'screen_capture': return 'screen'
    case 'audio_capture': return 'audio'
    case 'telegram': return 'telegram'
    case 'telegram_user_dm': return 'telegram'
    case 'telegram_group': return 'telegram'
    default: return 'unknown'
  }
}
