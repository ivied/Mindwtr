/**
 * Proposal expiry — flips long-pending proposals without recent activity to
 * `expired`. Pure logic; the scheduler that calls it daily lives in index.ts.
 *
 * A proposal is considered idle when:
 *   - status = 'pending'
 *   - created_at older than maxIdleDays
 *   - no proposal_messages within the last maxIdleDays days
 *
 * (Both conditions; comments restart the clock.)
 */

import type { DB } from '../context-store/db'
import type { ProposalStore } from './store'
import type { ProposalRecord } from './types'

export interface ExpiryConfig {
  /** Default idle window in days. May be overridden per source_agent. */
  defaultMaxIdleDays: number
  /** Per-source-agent overrides (in days). */
  perSourceAgentDays?: Record<string, number>
}

export const DEFAULT_EXPIRY_CONFIG: ExpiryConfig = {
  defaultMaxIdleDays: 7,
}

export interface ExpiryRunResult {
  expired: ProposalRecord[]
  scanned: number
}

/** Minimal row shape we read in the scan SQL. */
interface ScanRow {
  id: string
  source_agent: string
  created_at: string
  last_message_at: string | null
}

export class ProposalExpiryJob {
  constructor(
    private db: DB,
    private store: ProposalStore,
    private config: ExpiryConfig = DEFAULT_EXPIRY_CONFIG
  ) {}

  /** Run one pass. Returns proposals that were transitioned to expired. */
  run(now: Date = new Date()): ExpiryRunResult {
    const rows = this.db
      .query<ScanRow, []>(
        `SELECT
           p.id              AS id,
           p.source_agent    AS source_agent,
           p.created_at      AS created_at,
           (SELECT MAX(m.created_at) FROM proposal_messages m WHERE m.proposal_id = p.id) AS last_message_at
         FROM proposals p
         WHERE p.status = 'pending'`
      )
      .all()

    const expired: ProposalRecord[] = []
    for (const row of rows) {
      const maxDays = this.maxIdleDaysFor(row.source_agent)
      if (this.isIdle(row, maxDays, now)) {
        this.store.transition(row.id, 'expired', 'system', { maxIdleDays: maxDays })
        const refreshed = this.store.get(row.id)
        if (refreshed) expired.push(refreshed)
      }
    }
    return { expired, scanned: rows.length }
  }

  private maxIdleDaysFor(sourceAgent: string): number {
    return this.config.perSourceAgentDays?.[sourceAgent] ?? this.config.defaultMaxIdleDays
  }

  private isIdle(row: ScanRow, maxDays: number, now: Date): boolean {
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000
    const cutoff = now.getTime() - maxAgeMs
    if (Date.parse(row.created_at) > cutoff) return false
    if (row.last_message_at && Date.parse(row.last_message_at) > cutoff) return false
    return true
  }
}
