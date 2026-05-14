/**
 * RecentItemsProvider — supplies the Proposer's dedup pool with the user's
 * recent decisions on similar topics. Three sources, surfaced as labelled
 * entries so the Proposer prompt can apply per-signal nuance rather than
 * lumping everything as "duplicate of inbox":
 *
 *  1. Mindwtr inbox tasks — open work the user hasn't dispatched. The
 *     classic "this is already on my plate" signal. Labelled `[in inbox]`.
 *  2. Pending create-proposals from commitment-detector — the agent already
 *     proposed this topic, the user hasn't decided yet. Labelled
 *     `[pending AI review]`. Catches paraphrase bursts.
 *  3. Recently-resolved create-proposals — user approved / rejected /
 *     already-done / not-applicable within a per-status window. Labelled
 *     with the resolution kind + age so the Proposer can:
 *       - SUPPRESS near-replays of the same topic ("user just dealt with
 *         this, don't bounce it back"),
 *       - ALLOW legitimate recurrence (weekly meeting > window → fresh),
 *       - DOWNWEIGHT rejected/false-positive signatures more aggressively
 *         than already-done ones.
 *
 * Suppression windows (resolved sources, configurable):
 *
 *   | Resolution             | Default window | Why                          |
 *   | rejected (kind=rejected)|  7 days         | strong "AI was wrong" signal |
 *   | rejected (already-done) |  3 days         | true positive, user did it   |
 *   | rejected (not-applicable)| 5 days         | context shifted              |
 *   | approved                |  1 day          | task should already be in    |
 *   |                         |                 | inbox; window covers the gap |
 *   |                         |                 | between completion and a     |
 *   |                         |                 | new capture cycle            |
 *
 * Default cache TTL 30s so capture bursts don't hammer the cloud API.
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { ProposalRecord } from '../proposal-store/types'
import type { ProposalStore } from '../proposal-store/store'
import type { CreatePayload } from '../proposal-store/payloads'

export type RecentItemSource = 'inbox' | 'pending' | 'resolved'
export type RecentResolutionKind =
  | 'approved'
  | 'rejected'
  | 'already-done'
  | 'not-applicable'

export interface RecentItem {
  title: string
  source: RecentItemSource
  /** Set when source='resolved'. */
  resolution?: RecentResolutionKind
  /** ms since the item was resolved (only when source='resolved'). */
  ageMs?: number
}

export interface RecentItemsProvider {
  recentItems(limit: number): Promise<RecentItem[]>
}

/** Legacy alias — older callers only need titles. Kept for backward compat. */
export interface InboxTitlesProvider {
  recentTitles(limit: number): Promise<string[]>
}

export interface MindwtrInboxTitlesOptions {
  client: MindwtrClient
  /** When set, pending + recently-resolved create-proposal titles are merged in. */
  proposalStore?: ProposalStore | null
  /** Cache TTL in ms for Mindwtr inbox fetch. Default 30s. */
  ttlMs?: number
  /** Suppression window per resolved kind. Defaults: see file header. */
  suppressMs?: Partial<Record<RecentResolutionKind, number>>
}

const DEFAULT_SUPPRESS_MS: Record<RecentResolutionKind, number> = {
  rejected: 7 * 24 * 60 * 60 * 1000,
  'already-done': 3 * 24 * 60 * 60 * 1000,
  'not-applicable': 5 * 24 * 60 * 60 * 1000,
  approved: 24 * 60 * 60 * 1000,
}

interface CacheEntry {
  titles: string[]
  fetchedAt: number
}

export class MindwtrInboxTitles implements RecentItemsProvider, InboxTitlesProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<string[]> | null = null
  private ttlMs: number
  private suppressMs: Record<RecentResolutionKind, number>

  constructor(private options: MindwtrInboxTitlesOptions) {
    this.ttlMs = options.ttlMs ?? 30_000
    this.suppressMs = { ...DEFAULT_SUPPRESS_MS, ...(options.suppressMs ?? {}) }
  }

  /**
   * Backward-compat: bare list of titles only, no labels. Suited for older
   * callers that don't render per-source nuance. New code should use
   * `recentItems` to get the richer enrichment.
   */
  async recentTitles(limit: number): Promise<string[]> {
    const items = await this.recentItems(limit)
    return items.map((i) => i.title)
  }

  async recentItems(limit: number): Promise<RecentItem[]> {
    const now = Date.now()
    const pending = this.collectPendingItems()
    const resolved = this.collectResolvedItems()

    let inboxTitles: string[]
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      inboxTitles = this.cache.titles
    } else if (this.inflight) {
      inboxTitles = await this.inflight
    } else {
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
      inboxTitles = await this.inflight
    }

    const inbox: RecentItem[] = inboxTitles.map((t) => ({ title: t, source: 'inbox' }))
    return mergeItems([pending, resolved, inbox], limit)
  }

  /** For tests / manual cache busting. */
  invalidate(): void {
    this.cache = null
  }

  private collectPendingItems(): RecentItem[] {
    if (!this.options.proposalStore) return []
    const proposals = this.options.proposalStore.listPending({
      type: 'create',
      sourceAgent: 'commitment-detector',
      limit: 100,
    })
    return proposals.flatMap((p) => {
      const title = extractCreateProposalTitle(p)
      return title ? [{ title, source: 'pending' as const }] : []
    })
  }

  private collectResolvedItems(): RecentItem[] {
    if (!this.options.proposalStore) return []
    const maxWindow = Math.max(...Object.values(this.suppressMs))
    const records = this.options.proposalStore.listRecentlyResolved(
      'commitment-detector',
      maxWindow,
      200
    )
    const now = Date.now()
    const out: RecentItem[] = []
    for (const p of records) {
      if (p.type !== 'create') continue
      const resolution = pickResolutionKind(p)
      const window = this.suppressMs[resolution]
      const resolvedTs = p.resolvedAt ? Date.parse(p.resolvedAt) : NaN
      if (!Number.isFinite(resolvedTs)) continue
      const ageMs = now - resolvedTs
      if (ageMs > window) continue
      const title = extractCreateProposalTitle(p)
      if (!title) continue
      out.push({ title, source: 'resolved', resolution, ageMs })
    }
    return out
  }
}

function extractCreateProposalTitle(p: ProposalRecord): string | null {
  const payload = p.currentPayload as CreatePayload | null
  if (!payload || payload.kind !== 'create') return null
  const title = payload.task?.title?.trim() ?? ''
  return title.length > 0 ? title : null
}

/**
 * Map a resolved proposal record to one of the four resolution kinds. The
 * `kind` field lives in the audit row's event_meta — exposed via the
 * `resolutionMeta` field on records from `listRecentlyResolved`. Falls back
 * to the proposal's `status` when meta is missing (older proposals from
 * before the 'kind' parameter existed).
 */
function pickResolutionKind(
  p: ProposalRecord & { resolutionMeta?: Record<string, unknown> | null }
): RecentResolutionKind {
  if (p.status === 'approved') return 'approved'
  const metaKind = p.resolutionMeta?.kind
  if (
    metaKind === 'already-done' ||
    metaKind === 'not-applicable' ||
    metaKind === 'rejected'
  ) {
    return metaKind
  }
  return 'rejected'
}

/** De-dup by normalized title, freshest-first across sources in given order. */
function mergeItems(sources: RecentItem[][], limit: number): RecentItem[] {
  const seen = new Set<string>()
  const merged: RecentItem[] = []
  for (const source of sources) {
    for (const item of source) {
      const key = item.title.toLowerCase().replace(/\s+/g, ' ').trim()
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      merged.push(item)
      if (merged.length >= limit) return merged
    }
  }
  return merged
}
