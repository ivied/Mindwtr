/**
 * TEMP data-layer simulation primitives v2 (throwaway, container, copy DB).
 *
 * Fixes the About-drift found in v1: a dry window no longer rewrites About from
 * scratch. Instead:
 *   - each window only ACCUMULATES raw signal: facts (dedup), timeline (dedup),
 *     open_tasks (live list). It never rewrites About/relations.
 *   - About + relations are RE-SYNTHESIZED separately from the entity's
 *     accumulated facts, on a cadence (every N touches / fact growth), so they
 *     reflect the whole history, not the latest dry window.
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
      open_tasks TEXT NOT NULL DEFAULT '',
      timeline TEXT NOT NULL DEFAULT '',
      relations TEXT NOT NULL DEFAULT '',
      facts_at_last_about INTEGER NOT NULL DEFAULT 0,
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
      kind TEXT NOT NULL,
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
  facts_at_last_about: number
  version: number
  first_seen: string
  last_seen: string
  updated_at: string
}

export class CardStore {
  constructor(private readonly db: Database) {}

  get(slug: string): Card | null {
    return this.db.query<Card, [string]>('SELECT * FROM entity_cards WHERE slug = ?').get(slug) ?? null
  }

  ensure(slug: string, type: string, seenAt: string): Card {
    const ex = this.get(slug)
    if (ex) return ex
    this.db
      .query(
        `INSERT INTO entity_cards (slug,type,about,open_tasks,timeline,relations,facts_at_last_about,version,first_seen,last_seen,updated_at)
         VALUES (?,?,'','','','',0,0,?,?,?)`
      )
      .run(slug, type, seenAt, seenAt, seenAt)
    return this.get(slug)!
  }

  /** Append accumulation produced by a window (timeline append + open_tasks replace; null = keep prior). */
  applyWindow(slug: string, type: string, timelineAdditions: string, openTasks: string | null, seenAt: string): void {
    const c = this.ensure(slug, type, seenAt)
    const timeline = timelineAdditions
      ? (c.timeline ? c.timeline + '\n' : '') + timelineAdditions
      : c.timeline
    this.db
      .query(
        `UPDATE entity_cards SET type=?, timeline=?, open_tasks=?, version=version+1, last_seen=?, updated_at=? WHERE slug=?`
      )
      .run(type || c.type, timeline, openTasks === null ? c.open_tasks : openTasks, seenAt, seenAt, slug)
  }

  /** Re-synthesized About/relations (from accumulated facts). */
  setAbout(slug: string, about: string, relations: string, factsCount: number, seenAt: string): void {
    this.db
      .query(`UPDATE entity_cards SET about=?, relations=?, facts_at_last_about=?, updated_at=? WHERE slug=?`)
      .run(about, relations, factsCount, seenAt, slug)
  }

  count(): number {
    return this.db.query<{ c: number }, []>('SELECT COUNT(*) c FROM entity_cards').get()?.c ?? 0
  }
}

export function factsFor(db: Database, slug: string, limit = 80): { statement: string; fact_type: string }[] {
  return db
    .query<{ statement: string; fact_type: string }, [string, number]>(
      'SELECT statement, fact_type FROM sim_facts WHERE slug = ? ORDER BY id DESC LIMIT ?'
    )
    .all(slug, limit)
}

export function factCount(db: Database, slug: string): number {
  return db.query<{ c: number }, [string]>('SELECT COUNT(*) c FROM sim_facts WHERE slug = ?').get(slug)?.c ?? 0
}

export function addFacts(
  db: Database,
  facts: { slug: string; statement: string; fact_type: string; confidence?: number }[],
  windowEnd: string
): void {
  const ins = db.prepare('INSERT INTO sim_facts (slug,statement,fact_type,confidence,window_end) VALUES (?,?,?,?,?)')
  for (const f of facts) ins.run(f.slug, f.statement, f.fact_type, f.confidence ?? null, windowEnd)
}

export function addQuestions(
  db: Database,
  qs: { question: string; kind: string; slugs: string[] }[],
  windowEnd: string
): void {
  const ins = db.prepare('INSERT INTO glossary_questions (question,kind,slugs,window_end,status) VALUES (?,?,?,?,?)')
  for (const q of qs) ins.run(q.question, q.kind, JSON.stringify(q.slugs), windowEnd, 'open')
}

// ---------------- WindowExtractor (accumulate only) ----------------

export interface WindowEntityOut {
  slug: string
  type: string
  timeline_additions: string
  open_tasks: string
}
export interface ExtractResult {
  entities: WindowEntityOut[]
  facts: { slug: string; statement: string; fact_type: string; confidence?: number }[]
  questions: { question: string; kind: string; slugs: string[] }[]
}

const EXTRACT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'record_window',
    description:
      'Record what THIS window adds for each active entity: new dated timeline events, the current open-tasks list, typed facts, and uncertainties to ask the user. Do NOT write an About summary here.',
    parameters: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              type: { type: 'string' },
              timeline_additions: {
                type: 'string',
                description:
                  'Markdown bullets of NEW significant dated events from THIS window only — things that HAPPENED (decision, conversation, commit, fix, agreement). Passive presence ("tab open", "remained visible in background", "unread badge shown") is NOT an event. Empty if nothing new or significant. Do NOT repeat events already in the prior timeline shown to you.',
              },
              open_tasks: {
                type: 'string',
                description:
                  'ONLY for project entities and for persons (delegated/expected-from-them work). Empty string for organizations, technologies, topics, hobbies, and for the KB owner himself. The FULL current list (markdown bullets): carry forward still-open prior items, drop/resolve done ones, add new ONLY with explicit commitment evidence. This REPLACES the stored list.',
              },
            },
            required: ['slug'],
          },
        },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slug: { type: 'string' },
              statement: { type: 'string', description: 'Short present-tense durable claim the window supports.' },
              fact_type: { type: 'string', description: 'working_on|waiting_on|met_with|knows_about|role|status|other' },
              confidence: { type: 'number' },
            },
            required: ['slug', 'statement', 'fact_type'],
          },
        },
        questions: {
          type: 'array',
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
      required: ['entities', 'facts', 'questions'],
    },
  },
}

const EXTRACT_SYSTEM = `You record raw signal for a developer's personal knowledge base from one 4-hour activity window. You do NOT write entity descriptions here (that is done elsewhere from accumulated facts).

For each active entity, output:
- timeline_additions: ONLY new dated events from THIS window where something actually HAPPENED: a decision, conversation, commit, fix, agreement, delivery, meeting. NOT passive presence — "tab stayed open", "context remained visible", "sidebar showed an unread badge", "app was in the background" are NOT events; leave empty instead. If the prior timeline (shown) already covers it, leave empty. Never restate old events.
- open_tasks: a task lives ONLY on its most specific owner, and ONLY if there is explicit commitment evidence in the captures: someone asked for it, the user said he would do it, or an open ticket/PR names it. An unread badge, an open tab, or "might be worth reviewing" is NOT a task — never write "review X if actionable / if still relevant" hedges; if you cannot state the task without a hedge, do not write it.
  - project: real open work items of that project.
  - person: ONLY work delegated to or expected FROM that person. NOT reminders for the user to read/reply to their messages.
  - organization, technology, topic, hobby: ALWAYS empty — channels and hubs do not own tasks; their tasks belong to a project or person.
  - the knowledge-base owner (the user himself): ALWAYS empty — his tasks live in his GTD system, not on his card.
  Carry forward prior items that are still clearly open under these rules; DROP prior items that violate them.
Also output:
- facts: parsimonious durable typed claims (0-3 per entity). These accumulate and later drive the entity's description, so make them factual and self-contained ("Farid works on Biothrive within Shiftwave"), not window-narration ("Slack showed a thread").
- questions: genuine uncertainties to ask the user (same-entity merges, ambiguous acronyms, identity confusion). Do not block.

If a window is dry for an entity (e.g. just a time-tracking line), it is fine to add a fact line but you MUST NOT invent depth. Call record_window exactly once.`

export class WindowExtractor {
  constructor(
    private readonly llm: LLMClient,
    private readonly model?: string
  ) {}

  async extract(
    events: Event[],
    active: { slug: string; type: string; timelineTail: string; openTasks: string }[],
    windowEnd: string,
    ownerSlug = 'sergey-kurdyuk',
    maxEventLines = 200,
    maxBodyPerEvent = 320
  ): Promise<ExtractResult> {
    const ctx = active
      .map(
        (a) =>
          `### ${a.slug} [${a.type}]\nPRIOR_TIMELINE (recent):\n${a.timelineTail || '(none)'}\nOPEN_TASKS:\n${a.openTasks || '(none)'}`
      )
      .join('\n\n')
    const eventBlock = renderEvents(events, maxEventLines, maxBodyPerEvent)
    const user = `WINDOW END: ${windowEnd}
KB OWNER: ${ownerSlug} (his open_tasks must always be empty)

ACTIVE ENTITIES (record additions for these):
${ctx || '(none, but still extract facts/questions)'}

---
WINDOW ACTIVITY ([time] (source) app - text):
${eventBlock}

---
Call record_window.`

    const res = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: user },
      ],
      tools: [EXTRACT_TOOL],
      tool_choice: 'required',
      max_tokens: 6000,
      model: this.model,
    })
    const call = res.choices[0]?.message?.tool_calls?.[0]
    if (!call) return { entities: [], facts: [], questions: [] }
    return parseExtract(call.function.arguments)
  }
}

export function parseExtract(args: string): ExtractResult {
  let p: any
  try {
    p = JSON.parse(args)
  } catch {
    return { entities: [], facts: [], questions: [] }
  }
  const entities: WindowEntityOut[] = Array.isArray(p.entities)
    ? p.entities
        .filter((e: any) => e && typeof e.slug === 'string')
        .map((e: any) => ({
          slug: String(e.slug),
          type: typeof e.type === 'string' ? e.type : 'topic',
          timeline_additions: str(e.timeline_additions),
          open_tasks: str(e.open_tasks),
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
  return { entities, facts, questions }
}

// ---------------- AboutSynthesizer (from accumulated facts) ----------------

const ABOUT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'write_about',
    description: "Write the entity's stable About description and real relations FROM its accumulated facts.",
    parameters: {
      type: 'object',
      properties: {
        about: {
          type: 'string',
          description:
            '1-3 sentence stable description of what this entity IS, synthesized from ALL the facts. Prefer durable, repeated signal over one-off mentions. Do not hedge ("unclear") if the facts collectively define it.',
        },
        relations: {
          type: 'string',
          description:
            'Markdown bullets of REAL relationships to other entities/people, each with the reason, drawn from the facts. Only evidenced links.',
        },
      },
      required: ['about'],
    },
  },
}

const ABOUT_SYSTEM = `You write the stable description of ONE entity in a developer's knowledge base, synthesized from its accumulated facts (collected over weeks). 

Rules:
- Use the WHOLE fact set; weight durable/repeated facts over one-off ones. A single dry time-tracking line must not override an earlier rich definition.
- about: what the entity IS (role/purpose/scope). Be concrete. Do NOT say "scope unclear" if the facts collectively make it clear.
- relations: only real, evidenced links to other named entities, each with a short reason.
Call write_about exactly once.`

export class AboutSynthesizer {
  constructor(
    private readonly llm: LLMClient,
    private readonly model?: string
  ) {}

  async synth(
    slug: string,
    type: string,
    facts: { statement: string; fact_type: string }[]
  ): Promise<{ about: string; relations: string }> {
    if (facts.length === 0) return { about: '', relations: '' }
    const factBlock = facts.map((f) => `- [${f.fact_type}] ${f.statement}`).join('\n')
    const user = `ENTITY: ${slug} [${type}]\n\nACCUMULATED FACTS (newest first):\n${factBlock}\n\nCall write_about.`
    const res = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: ABOUT_SYSTEM },
        { role: 'user', content: user },
      ],
      tools: [ABOUT_TOOL],
      tool_choice: 'required',
      max_tokens: 1500,
      model: this.model,
    })
    const call = res.choices[0]?.message?.tool_calls?.[0]
    if (!call) return { about: '', relations: '' }
    try {
      const o = JSON.parse(call.function.arguments)
      return { about: str(o.about), relations: str(o.relations) }
    } catch {
      return { about: '', relations: '' }
    }
  }
}

// ---------------- helpers ----------------

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function timelineTail(s: string, n = 8): string {
  return s
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n')
}

function renderEvents(events: Event[], maxLines: number, maxBody: number): string {
  const head = events.slice(0, maxLines)
  const tail = events.length > maxLines ? events.length - maxLines : 0
  const lines = head.map((e) => {
    const tm = e.ts.slice(11, 16)
    const body = e.body.replace(/\s+/g, ' ').slice(0, maxBody)
    return `[${tm}] (${e.source}) ${e.app ?? '-'} - ${body}`
  })
  if (tail > 0) lines.push(`... (${tail} more events not shown)`)
  return lines.join('\n')
}

