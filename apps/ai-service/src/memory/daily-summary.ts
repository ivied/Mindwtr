/**
 * Nightly daily-summary job — one LLM call per calendar day.
 *
 * Reads all events for the day (UTC), reads any facts inserted that day,
 * asks the LLM for a ≤500-word "what happened today" summary. Stored at
 * daily_summary[date] with an embedding so weekly/monthly context can
 * be assembled cheaply via vec search.
 *
 * Idempotent: rerunning for the same date overwrites the row.
 */

import type { LLMClient } from '../ai/client'
import type { EmbeddingsProvider } from '../context-store/embeddings'
import type { MemoryStore } from './store'

export interface DailySummaryOptions {
  store: MemoryStore
  llm: LLMClient
  embeddings: EmbeddingsProvider | null
  /** Override clock — for tests. */
  now?: () => Date
}

export interface DailySummaryResult {
  date: string
  eventCount: number
  factsAdded: number
  wrote: boolean
  reason?: string
}

const MAX_EVENT_LINES = 60     // hard cap so the prompt stays sane
const MAX_BODY_PER_EVENT = 280

export class DailySummaryJob {
  constructor(private readonly opts: DailySummaryOptions) {}

  /** Summarize a single date (YYYY-MM-DD). */
  async runFor(date: string): Promise<DailySummaryResult> {
    const startIso = `${date}T00:00:00.000Z`
    const endIso = `${nextDate(date)}T00:00:00.000Z`
    const events = this.opts.store.eventsBetween(startIso, endIso, 5000)
    if (events.length === 0) {
      return { date, eventCount: 0, factsAdded: 0, wrote: false, reason: 'no events' }
    }

    const factsAddedRow = this.opts.store.db
      .query<{ n: number }, [string, string]>(
        'SELECT COUNT(*) AS n FROM facts WHERE created_at >= ? AND created_at < ?'
      )
      .get(startIso, endIso)
    const factsAdded = factsAddedRow?.n ?? 0

    const summary = await this.synthesize(date, events, factsAdded)
    if (!summary.trim()) {
      return { date, eventCount: events.length, factsAdded, wrote: false, reason: 'empty LLM output' }
    }

    const embedding = this.opts.embeddings ? await this.opts.embeddings.embed(summary) : null
    this.opts.store.upsertDailySummary(
      {
        date,
        summary,
        eventCount: events.length,
        factsAdded,
        createdAt: new Date().toISOString(),
      },
      embedding
    )
    return { date, eventCount: events.length, factsAdded, wrote: true }
  }

  /** Summarize all days that don't yet have a row, starting from N days ago. */
  async backfill(daysBack: number): Promise<DailySummaryResult[]> {
    const now = this.opts.now ? this.opts.now() : new Date()
    const results: DailySummaryResult[] = []
    for (let i = daysBack; i >= 1; i--) {
      const d = new Date(now.getTime() - i * 86_400_000)
      const date = d.toISOString().slice(0, 10)
      if (this.opts.store.getDailySummary(date)) continue
      const r = await this.runFor(date)
      results.push(r)
    }
    return results
  }

  private async synthesize(
    date: string,
    events: ReturnType<MemoryStore['eventsBetween']>,
    factsAdded: number
  ): Promise<string> {
    const head = events.slice(0, MAX_EVENT_LINES)
    const tail = events.length > MAX_EVENT_LINES ? events.length - MAX_EVENT_LINES : 0

    const eventLines = head.map((e, i) => {
      const tm = e.ts.slice(11, 16)
      const excerpt = e.body.replace(/\s+/g, ' ').slice(0, MAX_BODY_PER_EVENT)
      return `${i + 1}. [${tm}] ${e.app ?? '-'}/${e.title ?? '-'} — ${excerpt}`
    })

    const system = `You write a concise daily summary for a developer's personal knowledge graph.

Rules:
- 250-500 words. Plain text. No markdown, no bullets, no headers.
- Group by theme/project, not by time. Mention specific people, projects, and tools by name.
- Capture: what the user worked on, decisions made, things waiting on others, problems hit.
- Skip: UI chrome, repetitive captures of the same screen, generic browsing.
- If events are mostly OCR garbage, output exactly: SKIP
- Output ONLY the summary text. No preamble.`

    const user = `Date: ${date}
Total events: ${events.length}${tail > 0 ? ` (showing first ${head.length}; ${tail} more not included)` : ''}
Facts added this day: ${factsAdded}

Events:
${eventLines.join('\n')}`

    const res = await this.opts.llm.chatCompletion({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 800,
      temperature: 0.2,
    })
    const raw = (res.choices[0]?.message?.content ?? '').trim()
    if (/^SKIP\b/i.test(raw)) return ''
    return raw
  }
}

function nextDate(yyyymmdd: string): string {
  const d = new Date(`${yyyymmdd}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
