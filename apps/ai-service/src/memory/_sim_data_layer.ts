/**
 * TEMP data-layer simulation primitives (throwaway, runs in container on copy DB).
 *
 * Simulates the full prod data layer accumulating "day by day", window by window,
 * starting from EMPTY memory. Four layers grow together:
 *   1. entity_registry   (built by EntityRegistrar — reused as-is)
 *   2. entity_cards       (sectioned dossier per entity — this file)
 *   3. sim_facts          (typed claims attached to registry slugs — this file)
 *   4. glossary_questions (uncertainties the system would ask the user — this file)
 *
 * Card + facts + glossary-questions are produced by ONE LLM call per window
 * (CardSynthesizer), fed the window events + the cards of entities the registrar
 * just touched in that window.
 */

import type { Database } from 'bun:sqlite'
import type { LLMClient } from '../ai/client'
import type { Event } from './types'

// ---------------- schema ----------------

export function ensureSimTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_cards (
      slug TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      about TEXT NOT NULL DEFAULT '',
      open_tasks TEXT NOT NULL DEFAULT '',   -- markdown bullet list
      timeline TEXT NOT NULL DEFAULT '',     -- markdown bullet list, append-growing
      relations TEXT NOT NULL DEFAULT '',    -- markdown bullet list of real links
      version INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sim_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      statement TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      confidence REAL,
      window_end TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sim_facts_slug ON sim_facts(slug);
    CREATE TABLE IF NOT EXISTS glossary_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      kind TEXT NOT NULL,            -- same_entity | meaning | identity | other
      slugs TEXT NOT NULL DEFAULT '[]',
      window_end TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open'
    );
  `)
}

export function resetSimTables(db: Database): void {
  db.exec('DELETE FROM entity_cards; DELETE FROM sim_facts; DELETE FROM glossary_questions;')
}

// ---------------- card store ----------------

export interface Card {
  slug: string
  type: string
  about: string
  open_tasks: string
  timeline: string
  relations: string
  version: number
  first_seen: string
  last_seen: string
  updated_at: string
}

export class CardStore {
  constructor(private readonly db: Database) {}

  get(slug: string): Card | null {
    return (
      (this.db.query<Card, [string]>('SELECT * FROM entity_cards WHERE slug = ?').get(slug)) ?? null
    )
  }

  getMany(slugs: string[]): Card[] {
    if (slugs.length === 0) return []
    const ph = slugs.map(() => '?').join(',')
    return this.db.query<Card, string[]>(`SELECT * FROM entity_cards WHERE slug IN (${ph})`).all(...slugs)
  }

  upsert(c: {
    slug: string
    type: string
    about: string
    open_tasks: string
    timeline: string
    relations: string
    seenAt: string
  }): void {
    const existing = this.get(c.slug)
    const now = c.seenAt
    if (!existing) {
      this.db
        .query(
          `INSERT INTO entity_cards (slug,type,about,open_tasks,timeline,relations,version,first_seen,last_seen,updated_at)
           VALUES (?,?,?,?,?,?,1,?,?,?)`
        )
        .run(c.slug, c.type, c.about, c.open_tasks, c.timeline, c.relations, now, now, now)
    } else {
      this.db
        .query(
          `UPDATE entity_cards SET type=?, about=?, open_tasks=?, timeline=?, relations=?, version=version+1, last_seen=?, updated_at=? WHERE slug=?`
        )
        .run(c.type, c.about, c.open_tasks, c.timeline, c.relations, now, now, c.slug)
    }
  }

  count(): number {
    return (this.db.query<{ c: number }, []>('SELECT COUNT(*) c FROM entity_cards').get()?.c) ?? 0
  }
}

export function addFacts(
  db: Database,
  facts: { slug: string; statement: string; fact_type: string; confidence?: number }[],
  windowEnd: string
): void {
  const ins = db.prepare(
    'INSERT INTO sim_facts (slug,statement,fact_type,confidence,window_end) VALUES (?,?,?,?,?)'
  )
  for (const f of facts) ins.run(f.slug, f.statement, f.fact_type, f.confidence ?? null, windowEnd)
}

export function addQuestions(
  db: Database,
  qs: { question: string; kind: string; slugs: string[] }[],
  windowEnd: string
): void {
  const ins = db.prepare(
    'INSERT INTO glossary_questions (question,kind,slugs,window_end,status) VALUES (?,?,?,?,?)'
  )
  for (const q of qs) ins.run(q.question, q.kind, JSON.stringify(q.slugs), windowEnd, 'open')
}

// ---------------- CardSynthesizer ----------------

export interface CardUpdate {
  slug: string
  type: string
  about: string
  open_tasks: string
  timeline_additions: string
  relations: string
}

export interface SynthResult {
  cards: CardUpdate[]
  facts: { slug: string; statement: string; fact_type: string; confidence?: number }[]
  questions: { question: string; kind: string; slugs: string[] }[]
}

const SYNTH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_cards',
    description:
      'Update the dossier cards for the entities active in this window, extract typed facts, and surface uncertainties the system should ask the user about.',
    parameters: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string', description: 'Registry slug being updated.' },
              type: { type: 'string' },
              about: {
                type: 'string',
                description:
                  'Concise rewrite of what this entity IS (1-3 sentences). Refine the prior About using new info; keep durable facts, drop stale guesses.',
              },
              open_tasks: {
                type: 'string',
                description:
                  'Markdown bullet list of CURRENT open tasks/questions/blockers for this entity. Carry forward still-open items from prior, mark resolved ones done or remove, add new ones from this window.',
              },
              timeline_additions: {
                type: 'string',
                description:
                  'Markdown bullets of NEW significant events from THIS window only (dated). Empty if nothing significant. Do not repeat prior timeline.',
              },
              relations: {
                type: 'string',
                description:
                  'Markdown bullets of REAL relationships (to other entities/people), each with why. Only links actually evidenced. Carry forward + add.',
              },
            },
            required: ['slug', 'about'],
          },
        },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              statement: { type: 'string', description: 'Short present-tense claim the window supports.' },
              fact_type: {
                type: 'string',
                description: 'working_on|waiting_on|met_with|knows_about|role|status|other',
              },
              confidence: { type: 'number' },
            },
            required: ['slug', 'statement', 'fact_type'],
          },
        },
        questions: {
          type: 'array',
          description:
            'Uncertainties the system should ASK the user to confirm (do not block on them). E.g. "Is `sw` the same as Shiftwave?", "Are `amir` and `amir-red` the same person?", "What does acronym X mean?".',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              kind: { type: 'string', description: 'same_entity|meaning|identity|other' },
              slugs: { type: 'array', items: { type: 'string' } },
            },
            required: ['question', 'kind'],
          },
        },
      },
      required: ['cards'],
    },
  },
}

const SYNTH_SYSTEM = `You maintain rich DOSSIER CARDS for a developer's personal knowledge base, plus extract facts and surface uncertainties.

You are given: (a) the entities active in the current 4-hour window (with their CURRENT cards, which may be empty if new), and (b) the raw window activity (audio/screen/Slack). Update each active entity's card from the new activity.

Card sections (keep each focused, markdown):
- about: what the entity IS (role/purpose). Refine over time; don't lose durable facts.
- open_tasks: live tasks/questions/blockers. Carry forward open ones, resolve/remove done ones, add new.
- timeline_additions: ONLY new dated events from THIS window. Don't restate old timeline.
- relations: real, evidenced links to other entities/people (with the reason). Never invent a relation just because two names co-occur once.

Also:
- facts: parsimonious typed claims (0-3 per entity is normal) attached to a slug.
- questions: things you are NOT sure about and would ask the user — same-entity merges you're unsure of, ambiguous acronyms, identity confusions. Do NOT block; just record them.

Be honest: if the window has little real signal for an entity, make a minimal update. Do not fabricate depth. Call update_cards exactly once.`

export class CardSynthesizer {
  constructor(
    private readonly llm: LLMClient,
    private readonly model?: string
  ) {}

  async synthesize(
    events: Event[],
    activeCards: { slug: string; type: string; card: Card | null }[],
    windowEnd: string,
    maxEventLines = 200,
    maxBodyPerEvent = 320
  ): Promise<SynthResult> {
    const cardBlock = activeCards
      .map(({ slug, type, card }) => {
        if (!card || card.version === 0) return `### ${slug} [${type}] (NEW — no card yet)`
        return `### ${slug} [${type}] (v${card.version})
ABOUT: ${card.about}
OPEN_TASKS:
${card.open_tasks || '(none)'}
TIMELINE (recent):
${tailLines(card.timeline, 8) || '(none)'}
RELATIONS:
${card.relations || '(none)'}`
      })
      .join('\n\n')

    const eventBlock = renderEvents(events, maxEventLines, maxBodyPerEvent)

    const user = `WINDOW END: ${windowEnd}

ACTIVE ENTITIES (update these cards):
${cardBlock || '(none — but extract any facts/questions)'}

---
WINDOW ACTIVITY ([time] (source) app — text):
${eventBlock}

---
Call update_cards.`

    const res = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: SYNTH_SYSTEM },
        { role: 'user', content: user },
      ],
      tools: [SYNTH_TOOL],
      tool_choice: { type: 'function', function: { name: 'update_cards' } },
      max_tokens: 8000,
      temperature: 0.2,
      model: this.model,
    })

    const call = res.choices[0]?.message?.tool_calls?.[0]
    if (!call) return { cards: [], facts: [], questions: [] }
    return parseSynth(call.function.arguments)
  }
}

export function parseSynth(args: string): SynthResult {
  let p: any
  try {
    p = JSON.parse(args)
  } catch {
    return { cards: [], facts: [], questions: [] }
  }
  const cards: CardUpdate[] = Array.isArray(p.cards)
    ? p.cards
        .filter((c: any) => c && typeof c.slug === 'string')
        .map((c: any) => ({
          slug: String(c.slug),
          type: typeof c.type === 'string' ? c.type : 'topic',
          about: str(c.about),
          open_tasks: str(c.open_tasks),
          timeline_additions: str(c.timeline_additions),
          relations: str(c.relations),
        }))
    : []
  const facts = Array.isArray(p.facts)
    ? p.facts
        .filter((f: any) => f && typeof f.slug === 'string' && typeof f.statement === 'string')
        .map((f: any) => ({
          slug: String(f.slug),
          statement: String(f.statement),
          fact_type: typeof f.fact_type === 'string' ? f.fact_type : 'other',
          confidence: typeof f.confidence === 'number' ? f.confidence : undefined,
        }))
    : []
  const questions = Array.isArray(p.questions)
    ? p.questions
        .filter((q: any) => q && typeof q.question === 'string')
        .map((q: any) => ({
          question: String(q.question),
          kind: typeof q.kind === 'string' ? q.kind : 'other',
          slugs: Array.isArray(q.slugs) ? q.slugs.filter((s: any) => typeof s === 'string') : [],
        }))
    : []
  return { cards, facts, questions }
}

// ---------------- helpers ----------------

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function tailLines(s: string, n: number): string {
  const lines = s.split('\n').filter((l) => l.trim())
  return lines.slice(-n).join('\n')
}

function renderEvents(events: Event[], maxLines: number, maxBody: number): string {
  const head = events.slice(0, maxLines)
  const tail = events.length > maxLines ? events.length - maxLines : 0
  const lines = head.map((e) => {
    const tm = e.ts.slice(11, 16)
    const body = e.body.replace(/\s+/g, ' ').slice(0, maxBody)
    return `[${tm}] (${e.source}) ${e.app ?? '-'} — ${body}`
  })
  if (tail > 0) lines.push(`… (${tail} more events not shown)`)
  return lines.join('\n')
}

/** Apply synthesizer card updates to the store (timeline append). */
export function applyCardUpdates(
  store: CardStore,
  updates: CardUpdate[],
  seenAt: string
): void {
  for (const u of updates) {
    const prev = store.get(u.slug)
    const timeline = u.timeline_additions
      ? (prev?.timeline ? prev.timeline + '\n' : '') + u.timeline_additions
      : (prev?.timeline ?? '')
    store.upsert({
      slug: u.slug,
      type: u.type || prev?.type || 'topic',
      about: u.about || prev?.about || '',
      open_tasks: u.open_tasks || prev?.open_tasks || '',
      timeline,
      relations: u.relations || prev?.relations || '',
      seenAt,
    })
  }
}
