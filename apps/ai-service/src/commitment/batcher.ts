/**
 * Time-windowed batcher for the Commitment pipeline.
 *
 * High-volume pull sources (Slack across many workspaces) would otherwise fire
 * one LLM call per message. The batcher accumulates capture records and drains
 * them on a fixed interval, running the pipeline per record but spreading the
 * cost over time rather than reacting to every single message.
 *
 * It does NOT merge messages into one prompt — each capture still gets its own
 * Proposer evaluation (attribution/identity is per-message). The win is cadence
 * control: drain every flushIntervalMs instead of on arrival, with a cap on how
 * many run per drain so a burst can't stampede the LLM.
 */

import type { CommitmentPipeline } from './pipeline'
import type { CaptureRecord } from '../context-store/types'

export interface CommitmentBatcherConfig {
  /** How often to drain the queue. */
  flushIntervalMs: number
  /** Max records processed per drain; the rest wait for the next tick. */
  maxPerFlush: number
}

export const DEFAULT_BATCHER_CONFIG: CommitmentBatcherConfig = {
  flushIntervalMs: 5 * 60 * 1000,
  maxPerFlush: 30,
}

export class CommitmentBatcher {
  private queue: CaptureRecord[] = []
  /** Backfill/recovery records — drained only with spare capacity after `queue`. */
  private lowQueue: CaptureRecord[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false

  constructor(
    private pipeline: CommitmentPipeline,
    private config: CommitmentBatcherConfig = DEFAULT_BATCHER_CONFIG
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.drain(), this.config.flushIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Enqueue a record for the next drain. Non-blocking. */
  enqueue(record: CaptureRecord): void {
    this.queue.push(record)
  }

  /** Enqueue at low priority: live traffic always drains first, so a large
   *  backfill can't delay proposals for fresh captures. */
  enqueueLow(record: CaptureRecord): void {
    this.lowQueue.push(record)
  }

  get pending(): number {
    return this.queue.length + this.lowQueue.length
  }

  /**
   * Process up to maxPerFlush queued records. Runs sequentially so concurrent
   * LLM calls stay bounded; a single failing record is logged and skipped.
   * Re-entrancy guarded: a slow drain won't overlap the next tick.
   */
  async drain(): Promise<void> {
    if (this.draining || this.pending === 0) return
    this.draining = true
    try {
      const batch = this.queue.splice(0, this.config.maxPerFlush)
      batch.push(...this.lowQueue.splice(0, this.config.maxPerFlush - batch.length))
      console.log(
        `[commitment-batch] draining ${batch.length}/${batch.length + this.pending} queued`
      )
      for (const record of batch) {
        try {
          await this.pipeline.run(record)
        } catch (err) {
          console.error(`[commitment-batch] pipeline failed for ${record.id}:`, (err as Error).message)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
