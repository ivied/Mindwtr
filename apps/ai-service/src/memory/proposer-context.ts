/**
 * Adapter that lets the Commitment Proposer consume the memory module as
 * a compact RECENT_CONTEXT string. Designed for the hot-path: must be
 * cheap (one embed + SQL, no second LLM call) and fail open.
 *
 * Returns null when nothing useful was found — the Proposer just skips
 * the RECENT_CONTEXT block in that case.
 */

import type { HybridRetriever } from './retrieve'
import type { MemoryStore } from './store'

export interface ProposerContextOptions {
  store: MemoryStore
  retriever: HybridRetriever
  /** Max chars of assembled context. Default 800 — keeps Proposer prompt lean. */
  maxChars?: number
  /** How many recent events to fold in. Default 5. */
  eventCount?: number
  /** Window for retrieval. Default 30 days. */
  withinDays?: number
}

export interface ProposerContextProvider {
  getRecentContext(captureText: string): Promise<string | null>
}

export class MemoryProposerContext implements ProposerContextProvider {
  private readonly maxChars: number
  private readonly eventCount: number
  private readonly withinDays: number

  constructor(private readonly opts: ProposerContextOptions) {
    this.maxChars = opts.maxChars ?? 800
    this.eventCount = opts.eventCount ?? 5
    this.withinDays = opts.withinDays ?? 30
  }

  async getRecentContext(captureText: string): Promise<string | null> {
    const q = captureText.slice(0, 1500) // truncate huge OCR before embedding
    let events
    try {
      events = await this.opts.retriever.retrieve({
        query: q,
        limit: this.eventCount,
        withinDays: this.withinDays,
      })
    } catch {
      return null
    }
    if (events.length === 0) return null

    // Pull active facts for slugs mentioned in the retrieved events.
    const slugs = topSlugsForEvents(this.opts.store, events.map((e) => e.id))
    const facts = []
    for (const slug of slugs.slice(0, 6)) {
      const f = this.opts.store.activeFactsFor(slug)
      facts.push(...f.slice(0, 2))
    }

    const factLines = facts.slice(0, 10).map((f) => {
      const tag = f.factType ? `[${f.factType}]` : ''
      return `- ${tag} ${f.statement} (${f.entitySlug})`.trim()
    })
    const eventLines = events.slice(0, this.eventCount).map((e) => {
      const ts = e.ts.slice(0, 16)
      const excerpt = e.body.replace(/\s+/g, ' ').slice(0, 140)
      return `- [${ts}] ${e.app ?? '-'}/${e.title ?? '-'} — ${excerpt}`
    })

    const sections: string[] = []
    if (factLines.length > 0) sections.push(`Active facts:\n${factLines.join('\n')}`)
    if (eventLines.length > 0) sections.push(`Recent related events:\n${eventLines.join('\n')}`)
    const out = sections.join('\n\n').slice(0, this.maxChars)
    return out.length > 0 ? out : null
  }
}

function topSlugsForEvents(store: MemoryStore, ids: string[]): string[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = store.db
    .query<{ entity_slug: string; n: number }, string[]>(
      `SELECT entity_slug, COUNT(*) AS n
         FROM event_entities
        WHERE event_id IN (${placeholders})
        GROUP BY entity_slug
        ORDER BY n DESC
        LIMIT 8`
    )
    .all(...ids)
  return rows.map((r) => r.entity_slug)
}
