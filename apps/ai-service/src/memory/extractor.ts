/**
 * Unified per-capture LLM extractor.
 *
 * Returns BOTH entities (for backward-compat with the existing wiki) AND
 * typed facts (for the new memory module). One LLM call per capture
 * instead of two. The wiki rollup keeps using entities to (re)generate
 * `wiki/entities/<slug>.md`; the memory module persists facts with
 * validity windows.
 *
 * Prompt design notes:
 *   - JSON-only output via tool-call-style fenceless object
 *   - Conservative entity rules carried over from the existing wiki
 *     entity-extractor — same EntityType enum, same noise filters
 *   - Facts are extracted with a fact_type hint list, but the LLM may
 *     emit "other" for things that don't fit (we don't enforce)
 */

import type { LLMClient } from '../ai/client'

export type EntityType =
  | 'project'
  | 'person'
  | 'repository'
  | 'technology'
  | 'place'
  | 'deadline'
  | 'organization'
  | 'topic'

export type FactType =
  | 'working_on'
  | 'waiting_on'
  | 'met_with'
  | 'knows_about'
  | 'location'
  | 'role'
  | 'status'
  | 'other'

export interface ExtractedEntity {
  slug: string
  name: string
  type: EntityType
  excerpt: string
}

export interface ExtractedFact {
  /** Human-readable statement; what we'll store + show to LLM later. */
  statement: string
  /** Slug of the entity this fact attaches to (must be in the entities[] list). */
  entity_slug: string
  /** From the FactType list, but the model may emit "other". */
  fact_type: FactType | string
  /** 0..1; how strongly the mention supports the fact. */
  confidence?: number
  /** True if the fact replaces a previous active fact of the same (slug, type). */
  supersedes_previous?: boolean
}

export interface ExtractInput {
  app: string
  title: string
  url?: string
  source: 'audio' | 'screen'
  body: string
}

export interface ExtractOutput {
  entities: ExtractedEntity[]
  facts: ExtractedFact[]
}

const SYSTEM_PROMPT = `You extract entities AND facts from one screen-capture or speech-transcript snippet for a developer's personal knowledge graph.

Output strict JSON in this exact shape (no prose, no fences):
{
  "entities": [
    {"slug": "lowercase-kebab", "name": "Human Name", "type": "project|person|repository|technology|place|deadline|organization|topic", "excerpt": "<=80 chars from body justifying this entity"}
  ],
  "facts": [
    {"statement": "<short factual statement, present tense>", "entity_slug": "<must match one of the entities[]>", "fact_type": "working_on|waiting_on|met_with|knows_about|location|role|status|other", "confidence": 0.0-1.0, "supersedes_previous": false}
  ]
}

Entity rules:
- Only NAMED, SPECIFIC entities. Skip generic concepts ("task", "code", "feature", "bug").
- Skip UI chrome and OCR garbage. If body is noise, return {"entities": [], "facts": []}.
- Same canonical slug across captures (prefer the most specific real name).

Fact rules:
- A fact is a CLAIM the snippet supports — not a description of the snippet itself.
  Good:  "Sergey is working on Phase 4c audio capture"
  Bad:   "There is a VSCode window open with audio code"
- Be parsimonious. 0-3 facts is normal. If nothing concrete, return facts: [].
- "supersedes_previous": true ONLY when the fact clearly invalidates a previous state
  (e.g. "switched from X to Y"). Default false.
- confidence ≤ 0.7 unless the statement is stated outright in body.
- Skip facts about the act of capturing itself (no "user opened VSCode at 12:04").

Output ONLY the JSON object. No preamble, no markdown.`

export class UnifiedExtractor {
  constructor(private readonly llm: LLMClient) {}

  async extract(input: ExtractInput): Promise<ExtractOutput> {
    const userPrompt = buildUserPrompt(input)
    const res = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1500,
      temperature: 0,
    })
    const raw = res.choices[0]?.message?.content ?? ''
    return parseExtractorOutput(raw)
  }
}

function buildUserPrompt(input: ExtractInput): string {
  const trimmed = input.body.slice(0, 4000)
  const urlLine = input.url ? `URL: ${input.url}\n` : ''
  return `Source: ${input.source}
App: ${input.app}
Title: ${input.title}
${urlLine}Body:
${trimmed}`
}

export function parseExtractorOutput(raw: string): ExtractOutput {
  const cleaned = stripFences(raw).trim()
  if (!cleaned) return { entities: [], facts: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { entities: [], facts: [] }
  }
  if (typeof parsed !== 'object' || parsed === null) return { entities: [], facts: [] }
  const obj = parsed as { entities?: unknown; facts?: unknown }
  return {
    entities: Array.isArray(obj.entities) ? obj.entities.flatMap(normalizeEntity) : [],
    facts: Array.isArray(obj.facts) ? obj.facts.flatMap(normalizeFact) : [],
  }
}

function normalizeEntity(raw: unknown): ExtractedEntity[] {
  if (typeof raw !== 'object' || raw === null) return []
  const o = raw as Record<string, unknown>
  const slug = typeof o.slug === 'string' ? slugify(o.slug) : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const type = typeof o.type === 'string' ? (o.type as EntityType) : 'topic'
  const excerpt = typeof o.excerpt === 'string' ? o.excerpt.slice(0, 80) : ''
  if (!slug || !name) return []
  return [{ slug, name, type, excerpt }]
}

function normalizeFact(raw: unknown): ExtractedFact[] {
  if (typeof raw !== 'object' || raw === null) return []
  const o = raw as Record<string, unknown>
  const statement = typeof o.statement === 'string' ? o.statement.trim().slice(0, 500) : ''
  const slug =
    typeof o.entity_slug === 'string' ? slugify(o.entity_slug) : ''
  const fact_type =
    typeof o.fact_type === 'string' ? (o.fact_type as FactType) : 'other'
  const conf = typeof o.confidence === 'number' ? clamp01(o.confidence) : undefined
  const sup = typeof o.supersedes_previous === 'boolean' ? o.supersedes_previous : false
  if (!statement || !slug) return []
  return [
    {
      statement,
      entity_slug: slug,
      fact_type,
      confidence: conf,
      supersedes_previous: sup,
    },
  ]
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
}
