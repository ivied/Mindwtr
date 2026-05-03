/**
 * Capture deduplicator.
 *
 * Same window stays open for hours; we don't want to flood inbox with
 * identical OCR snapshots. Track a fingerprint of the last sent capture
 * and require either:
 *   1) the fingerprint to differ (window/title changed, or OCR changed
 *      substantially), or
 *   2) the cooldown to elapse (so the same window does eventually get
 *      re-captured if user actively works there).
 *
 * Pure / synchronous so the runner stays trivial to test.
 */

import { createHash } from 'node:crypto'

export interface DedupConfig {
  /** Re-send the same fingerprint after this many ms even if unchanged. */
  cooldownMs: number
  /**
   * If > 0, include first N OCR chars in the fingerprint (catches "user
   * stayed in window but content changed"). For dynamic UIs (chat, IDE)
   * keep this at 0 so window-stickiness alone gates re-capture.
   */
  ocrPrefixChars: number
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  cooldownMs: 30 * 60 * 1000, // 30 min
  ocrPrefixChars: 0,
}

export interface DedupInput {
  app: string
  windowTitle: string
  ocrText: string
}

export class CaptureDeduper {
  private lastFingerprint: string | null = null
  private lastSentAt = 0

  constructor(
    private config: DedupConfig = DEFAULT_DEDUP_CONFIG,
    private now: () => number = () => Date.now()
  ) {}

  /**
   * Returns true when the capture is a duplicate of the last sent one
   * AND the cooldown has not elapsed.
   */
  isDuplicate(input: DedupInput): boolean {
    const fp = this.fingerprint(input)
    if (this.lastFingerprint !== fp) return false
    return this.now() - this.lastSentAt < this.config.cooldownMs
  }

  /** Mark this capture as sent (call after successful sink). */
  markSent(input: DedupInput): void {
    this.lastFingerprint = this.fingerprint(input)
    this.lastSentAt = this.now()
  }

  private fingerprint(input: DedupInput): string {
    const ocrSlice = input.ocrText.slice(0, this.config.ocrPrefixChars)
    const data = `${input.app}${input.windowTitle}${ocrSlice}`
    return createHash('sha1').update(data).digest('hex')
  }
}
