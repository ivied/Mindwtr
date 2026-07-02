/**
 * EntityRegistrar — LLM pass that maintains the clean entity registry.
 *
 * Runs over a time window of events (batch, not per-capture). It is shown the
 * CURRENT registry and asked to decide, for each significant entity in the
 * window, whether it MATCHES an existing registry entry (fold in, dedup by
 * meaning) or is NEW. It also assigns a type and, for sub-entities (a repo or
 * meeting of a project), a parent — building hierarchy.
 *
 * This replaces string-heuristic dedup (SlugCanonicalizer) with meaning-based
 * dedup: the LLM tells `sergey-kurd` from `sergey-kazakov` (variant vs different
 * person) the way a prefix match never could. See
 * GTD_automation/_bmad-output/planning-artifacts/handoff-entity-registry.md.
 *
 * Writes go to `entity_registry` (EntityRegistryStore) — a shadow table, NOT
 * the wiki, so we never write through the rollup's back. event_entities stays
 * as the raw mention log.
 */

import type { LLMClient } from '../ai/client'
import type { Event } from './types'
import type { MemoryStore } from './store'
import type { EntityRegistryStore, EntityType, RegistryEntity } from './entity-registry-store'

export interface EntityRegistrarOptions {
  registry: EntityRegistryStore
  memory: MemoryStore
  llm: LLMClient
  model?: string
  /** Show the LLM registry entries with at least this many mentions. Default 3. */
  minRegistryMentions?: number
  /** Hard cap on registry entries injected into the prompt. Default 400. */
  maxRegistryEntries?: number
  /** Hard cap on event lines per window. Default 220. */
  maxEventLines?: number
  /** Per-event body truncation. Default 300. */
  maxBodyPerEvent?: number
}

export interface WindowResult {
  startIso: string
  endIso: string
  eventCount: number
  decisions: RegistrarDecision[]
  applied: number
  reason?: string
}

export interface RegistrarDecision {
  decision: 'match' | 'new'
  /** For 'match': the existing registry slug. For 'new': the proposed slug. */
  slug: string
  name: string
  type: EntityType
  parent: string | null
  aliases: string[]
  description: string
}

const ENTITY_TYPES: EntityType[] = [
  'project',
  'person',
  'organization',
  'technology',
  'topic',
  'hobby',
]

const REGISTRAR_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_registry',
    description:
      'Report the significant entities found in this window and whether each matches an existing registry entry or is new.',
    parameters: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              decision: {
                type: 'string',
                enum: ['match', 'new'],
                description:
                  "'match' if this is an existing registry entity (use its exact slug); 'new' if genuinely not in the registry.",
              },
              slug: {
                type: 'string',
                description:
                  "For 'match': the EXACT existing registry slug. For 'new': a fresh lowercase-kebab slug.",
              },
              name: { type: 'string', description: 'Human display name.' },
              type: {
                type: 'string',
                enum: ENTITY_TYPES,
                description: 'Entity kind.',
              },
              parent: {
                type: 'string',
                description:
                  "Optional: slug of the parent entity if this is a sub-entity (a repo/meeting of a project). Empty string if top-level. NEVER set a parent for a person.",
              },
              aliases: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'ONLY names this entity is actually CALLED: spelling/slug variants, nicknames, abbreviations, translations of its name. NOT related terms, sub-concepts, in-game/domain vocabulary, or words that merely co-occur with it.',
              },
              description: {
                type: 'string',
                description:
                  'One short line that distinguishes this entity from similarly-named ones (role/what it is). Helps future dedup.',
              },
            },
            required: ['decision', 'slug', 'name', 'type'],
          },
        },
      },
      required: ['entities'],
    },
  },
}

function buildSystemPrompt(): string {
  return `You maintain a personal knowledge base's ENTITY REGISTRY — the clean canonical list of who and what is real in a developer's work and life (projects, people, organizations, technologies, topics, hobbies).

You are given the CURRENT registry and a window of raw captured activity (audio transcripts, screen OCR, Slack). Decide, for each SIGNIFICANT entity in the window, whether it matches an existing registry entry or is new. Call update_registry exactly once.

Rules for dedup (this is the whole point — judge by MEANING, not string similarity):
- If a name in the window is the SAME real entity as a registry entry (a spelling/slug variant, nickname, or abbreviation), use decision 'match' with the registry's EXACT slug, and put the variant in aliases. Example: window has "sergey-kurd" / "Sergey K." and registry has "sergey-kurdyuk" → match sergey-kurdyuk.
- If it is a DIFFERENT real entity that merely shares part of a name, use 'new'. Example: "sergey-kazakov" is NOT "sergey-kurdyuk" — different people. Never merge different people.
- Sub-entities: a repository, meeting, or component that belongs to a project is its own entry with parent = the project slug (e.g. shiftwave-supabase parent shiftwave). NEVER give a person a parent.
- aliases are ONLY alternative NAMES of the entity itself (variants, nicknames, abbreviations, its name in another language). Domain vocabulary is NOT an alias: for a game, unit/hero/map/mechanic names are NOT aliases of the game; for a project, its technologies and teammates are NOT aliases. When in doubt, leave it out.

Rules for what to register:
- Only register entities with REAL, durable signal in the window. A name that appears once in passing or ambient noise is NOT an entity.
- IGNORE entertainment/ambient noise UNLESS it is clearly a recurring personal hobby worth remembering (then type 'hobby'): one-off game-stream/sports/TV mentions, OCR window chrome ("File Edit View"), idle browsing.
- Do NOT invent. If the window is mostly noise, return few or zero entities.

Always provide a short 'description' that distinguishes the entity (role / what it is), so future windows can tell entities apart.`
}

export class EntityRegistrar {
  private readonly minRegistryMentions: number
  private readonly maxRegistryEntries: number
  private readonly maxEventLines: number
  private readonly maxBodyPerEvent: number

  constructor(private readonly opts: EntityRegistrarOptions) {
    this.minRegistryMentions = opts.minRegistryMentions ?? 3
    this.maxRegistryEntries = opts.maxRegistryEntries ?? 400
    this.maxEventLines = opts.maxEventLines ?? 220
    this.maxBodyPerEvent = opts.maxBodyPerEvent ?? 300
  }

  /** Process one time window [startIso, endIso). */
  async runWindow(startIso: string, endIso: string): Promise<WindowResult> {
    const events = this.opts.memory.eventsBetween(startIso, endIso, 5000)
    if (events.length === 0) {
      return { startIso, endIso, eventCount: 0, decisions: [], applied: 0, reason: 'no events' }
    }

    const decisions = await this.classify(events)
    const applied = this.apply(decisions, endIso)
    return { startIso, endIso, eventCount: events.length, decisions, applied }
  }

  /**
   * Walk [fromIso, toIso) in fixed windows, oldest first, calling runWindow on
   * each. Used for the backfill simulation (handoff §6). `onWindow` is invoked
   * after each window so callers can log/inspect progress; `pauseMs` throttles
   * for rate limits.
   */
  async backfill(
    fromIso: string,
    toIso: string,
    windowHours = 4,
    onWindow?: (r: WindowResult) => void,
    pauseMs = 0
  ): Promise<WindowResult[]> {
    const results: WindowResult[] = []
    const stepMs = windowHours * 3_600_000
    let cursor = Date.parse(fromIso)
    const end = Date.parse(toIso)
    while (cursor < end) {
      const wStart = new Date(cursor).toISOString()
      const wEnd = new Date(Math.min(cursor + stepMs, end)).toISOString()
      const r = await this.runWindow(wStart, wEnd)
      results.push(r)
      onWindow?.(r)
      cursor += stepMs
      if (pauseMs > 0 && cursor < end) await sleep(pauseMs)
    }
    return results
  }

  private async classify(events: Event[]): Promise<RegistrarDecision[]> {
    const registry = this.opts.registry.list(this.minRegistryMentions, this.maxRegistryEntries)
    const registryBlock = renderRegistry(registry)
    const eventBlock = renderEvents(events, this.maxEventLines, this.maxBodyPerEvent)

    const user = `CURRENT REGISTRY (${registry.length} entries shown, mention_count ≥ ${this.minRegistryMentions}):
${registryBlock || '(empty — registry is being built from scratch)'}

---
WINDOW CAPTURES (chronological, format [time] (source) app — text):
${eventBlock}

---
Call update_registry with the significant entities in this window.`

    const res = await this.opts.llm.chatCompletion({
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: user },
      ],
      tools: [REGISTRAR_TOOL],
      tool_choice: 'required',
      max_tokens: 4000,
      model: this.opts.model,
    })

    const call = res.choices[0]?.message?.tool_calls?.[0]
    if (!call) return []
    return parseRegistrarOutput(call.function.arguments)
  }

  /** Apply decisions to the registry store. Returns count applied. */
  private apply(decisions: RegistrarDecision[], seenAt: string): number {
    let applied = 0
    for (const d of decisions) {
      const parentSlug = d.parent && d.parent.trim() ? slugify(d.parent) : null
      // A person must never carry a parent (guard against LLM slips).
      const safeParent = d.type === 'person' ? null : parentSlug
      this.opts.registry.upsert({
        slug: d.slug,
        name: d.name,
        type: d.type,
        aliases: d.aliases,
        parentSlug: safeParent,
        description: d.description,
        seenAt,
        mentions: 1,
      })
      applied++
    }
    return applied
  }
}

// ---------------- rendering ----------------

function renderRegistry(entries: RegistryEntity[]): string {
  return entries
    .map((e) => {
      const parent = e.parentSlug ? ` ⊂ ${e.parentSlug}` : ''
      const aliases = e.aliases.length ? ` (aka: ${e.aliases.slice(0, 6).join(', ')})` : ''
      const desc = e.description ? ` — ${e.description}` : ''
      return `- ${e.slug} [${e.type}]${parent}${aliases}${desc}`
    })
    .join('\n')
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

// ---------------- parsing ----------------

export function parseRegistrarOutput(args: string): RegistrarDecision[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const obj = parsed as { entities?: unknown }
  if (!Array.isArray(obj.entities)) return []
  return obj.entities.flatMap(normalizeDecision)
}

function normalizeDecision(raw: unknown): RegistrarDecision[] {
  if (typeof raw !== 'object' || raw === null) return []
  const o = raw as Record<string, unknown>
  const decision = o.decision === 'match' ? 'match' : o.decision === 'new' ? 'new' : null
  const slug = typeof o.slug === 'string' ? slugify(o.slug) : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const type = typeof o.type === 'string' && (ENTITY_TYPES as string[]).includes(o.type)
    ? (o.type as EntityType)
    : 'topic'
  if (!decision || !slug || !name) return []
  const parentRaw = typeof o.parent === 'string' ? o.parent.trim() : ''
  const parent = parentRaw ? parentRaw : null
  const aliases = Array.isArray(o.aliases)
    ? o.aliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim())
    : []
  const description = typeof o.description === 'string' ? o.description.trim().slice(0, 200) : ''
  return [{ decision, slug, name, type, parent, aliases, description }]
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
