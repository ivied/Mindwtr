/**
 * InboxTitlesProvider — supplies recent inbox-task titles to the Proposer for
 * semantic dedup. Pipeline calls `recentTitles(50)` before every Proposer run;
 * if the new proposed task matches one of the listed titles, the Proposer
 * sets `duplicate_of_title` and the pipeline reports `duplicate-of-existing`.
 *
 * Default implementation wraps a MindwtrClient with a short in-memory cache
 * (TTL 30s by default) so capture bursts don't hammer the cloud API.
 *
 * When a ProposalStore is provided, pending `create` proposal titles from
 * commitment-detector are merged in. This catches the "two duplicate
 * suggestions" case — the user hasn't approved the first one yet (so the
 * task isn't in Mindwtr inbox yet), but it's already in the pending queue
 * and a second look at the same conversation shouldn't re-propose it.
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { ProposalStore } from '../proposal-store/store'
import type { CreatePayload } from '../proposal-store/payloads'

export interface InboxTitlesProvider {
  recentTitles(limit: number): Promise<string[]>
}

export interface MindwtrInboxTitlesOptions {
  client: MindwtrClient
  /** When set, pending create-proposal titles are merged into the dedup pool. */
  proposalStore?: ProposalStore | null
  /** Cache TTL in ms — fresh titles within this window are reused. Default 30s. */
  ttlMs?: number
}

interface CacheEntry {
  titles: string[]
  fetchedAt: number
}

export class MindwtrInboxTitles implements InboxTitlesProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<string[]> | null = null
  private ttlMs: number

  constructor(private options: MindwtrInboxTitlesOptions) {
    this.ttlMs = options.ttlMs ?? 30_000
  }

  async recentTitles(limit: number): Promise<string[]> {
    const now = Date.now()
    const pendingTitles = this.collectPendingTitles(limit)

    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return mergeTitles(this.cache.titles, pendingTitles, limit)
    }
    if (this.inflight) {
      const titles = await this.inflight
      return mergeTitles(titles, pendingTitles, limit)
    }
    this.inflight = this.options.client
      .listTasks({ status: 'inbox', limit: Math.max(limit, 100) })
      .then((tasks) => {
        const titles = tasks
          .map((t) => (typeof t.title === 'string' ? t.title.trim() : ''))
          .filter((s) => s.length > 0)
        this.cache = { titles, fetchedAt: Date.now() }
        return titles
      })
      .finally(() => {
        this.inflight = null
      })
    const titles = await this.inflight
    return mergeTitles(titles, pendingTitles, limit)
  }

  /** For tests / manual cache busting. */
  invalidate(): void {
    this.cache = null
  }

  /**
   * Pending create-proposal titles — synchronous read from the local SQLite
   * proposal store (no network, no cache needed). Returned freshest-first
   * because listPending sorts by created_at DESC.
   */
  private collectPendingTitles(limit: number): string[] {
    if (!this.options.proposalStore) return []
    const proposals = this.options.proposalStore.listPending({
      type: 'create',
      sourceAgent: 'commitment-detector',
      limit: Math.max(limit, 100),
    })
    const titles: string[] = []
    for (const p of proposals) {
      const payload = p.currentPayload as CreatePayload | null
      if (!payload || payload.kind !== 'create') continue
      const title = payload.task?.title?.trim() ?? ''
      if (title.length > 0) titles.push(title)
    }
    return titles
  }
}

/** De-dup, freshest-first, capped at limit. */
function mergeTitles(inbox: string[], pending: string[], limit: number): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  // Pending first — they represent the most recent agent output and are the
  // ones the Proposer will most likely paraphrase on the next pass.
  for (const t of [...pending, ...inbox]) {
    const key = t.toLowerCase().replace(/\s+/g, ' ').trim()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(t)
    if (merged.length >= limit) break
  }
  return merged
}
