/**
 * InboxTitlesProvider — supplies recent inbox-task titles to the Proposer for
 * semantic dedup. Pipeline calls `recentTitles(50)` before every Proposer run;
 * if the new proposed task matches one of the listed titles, the Proposer
 * sets `duplicate_of_title` and the pipeline reports `duplicate-of-existing`.
 *
 * Default implementation wraps a MindwtrClient with a short in-memory cache
 * (TTL 30s by default) so capture bursts don't hammer the cloud API.
 */

import type { MindwtrClient } from '../api/mindwtr-client'

export interface InboxTitlesProvider {
  recentTitles(limit: number): Promise<string[]>
}

export interface MindwtrInboxTitlesOptions {
  client: MindwtrClient
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
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.titles.slice(0, limit)
    }
    if (this.inflight) {
      const titles = await this.inflight
      return titles.slice(0, limit)
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
    return titles.slice(0, limit)
  }

  /** For tests / manual cache busting. */
  invalidate(): void {
    this.cache = null
  }
}
