/**
 * Focus-context assembler — the read-side public API of the memory module.
 *
 * Given a query (a task title, a question, or a free-form string), returns
 * the relevant slice of the user's history that an LLM can use as context
 * to help execute the task:
 *
 *   1. Hybrid retrieval over events → top-K
 *   2. 1-hop expansion: pull active facts for entities mentioned in those events
 *   3. Optional LLM briefing synthesis from the assembled context
 *
 * Cheap path (no LLM): returns just the structured pieces. The caller
 * (Proposer, UI, /ask endpoint) decides whether to pay for synthesis.
 */

import type { LLMClient } from '../ai/client'
import type { HybridRetriever } from './retrieve'
import type { MemoryStore } from './store'
import type { Fact, FocusContext, RetrievedEvent } from './types'

export interface FocusContextOptions {
  store: MemoryStore
  retriever: HybridRetriever
  llm?: LLMClient | null
}

export interface AssembleArgs {
  query: string
  /** How many events to keep after RRF. Default 12. */
  eventLimit?: number
  /** Only include events within last N days. Default 30. */
  withinDays?: number
  /** Filter retrieval to these entity slugs. If given, narrows search. */
  entitySlugs?: string[]
  /** Set true to also call LLM for a one-paragraph briefing. */
  withBriefing?: boolean
}

export class FocusContextAssembler {
  constructor(private readonly opts: FocusContextOptions) {}

  async assemble(args: AssembleArgs): Promise<FocusContext> {
    const eventLimit = args.eventLimit ?? 12
    const withinDays = args.withinDays ?? 30

    const recentEvents = await this.opts.retriever.retrieve({
      query: args.query,
      limit: eventLimit,
      withinDays,
      entitySlugs: args.entitySlugs,
    })

    const relatedEntities = topEntitiesFromEvents(this.opts.store, recentEvents)
    const slugsForFacts = new Set<string>()
    if (args.entitySlugs) args.entitySlugs.forEach((s) => slugsForFacts.add(s))
    for (const e of relatedEntities.slice(0, 10)) slugsForFacts.add(e.slug)

    const activeFacts: Fact[] = []
    for (const slug of slugsForFacts) {
      activeFacts.push(...this.opts.store.activeFactsFor(slug))
    }

    const briefing =
      args.withBriefing && this.opts.llm
        ? await this.synthesizeBriefing(args.query, recentEvents, activeFacts).catch((err) => {
            console.warn(`[focus-context] briefing failed: ${(err as Error).message}`)
            return undefined
          })
        : undefined

    return { activeFacts, recentEvents, relatedEntities, briefing }
  }

  private async synthesizeBriefing(
    query: string,
    events: RetrievedEvent[],
    facts: Fact[]
  ): Promise<string> {
    if (!this.opts.llm) return ''
    const eventLines = events.slice(0, 12).map((e, i) => {
      const ts = e.ts.slice(0, 16)
      const excerpt = e.body.replace(/\s+/g, ' ').slice(0, 240)
      return `${i + 1}. [${ts}] ${e.app ?? '-'}/${e.title ?? '-'} — ${excerpt}`
    })
    const factLines = facts.slice(0, 30).map((f) => {
      const tag = f.factType ? `[${f.factType}]` : ''
      return `- ${tag} ${f.statement} (about ${f.entitySlug}, since ${f.validFrom.slice(0, 10)})`
    })

    const system = `You are a personal context briefer. Given a user task and relevant past events + active facts, write one tight paragraph (4-7 sentences) that tells the user what they need to remember to act on the task. Focus on:
- people involved, what they're waiting on
- open threads, last decisions
- recent activity that matters
Do NOT speculate beyond the input. Plain text, no markdown.`

    const user = `Task: ${query}

Active facts:
${factLines.join('\n') || '(none)'}

Recent events (most relevant first):
${eventLines.join('\n') || '(none)'}`

    const res = await this.opts.llm.chatCompletion({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 400,
      temperature: 0.2,
    })
    return (res.choices[0]?.message?.content ?? '').trim()
  }
}

// ---------------- helpers ----------------

function topEntitiesFromEvents(
  store: MemoryStore,
  events: RetrievedEvent[]
): Array<{ slug: string; mentions: number }> {
  if (events.length === 0) return []
  const placeholders = events.map(() => '?').join(',')
  const rows = store.db
    .query<{ entity_slug: string; n: number }, string[]>(
      `SELECT entity_slug, COUNT(*) AS n
         FROM event_entities
        WHERE event_id IN (${placeholders})
        GROUP BY entity_slug
        ORDER BY n DESC
        LIMIT 20`
    )
    .all(...events.map((e) => e.id))
  return rows.map((r) => ({ slug: r.entity_slug, mentions: r.n }))
}
