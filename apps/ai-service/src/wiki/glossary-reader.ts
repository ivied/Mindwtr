/**
 * Glossary / decoder-ring provider — surfaces the NON-person entities the
 * capture-wiki rollup knows about (project codenames, internal terms,
 * acronyms, technologies, organizations) so the Proposer / Enricher can
 * decode shorthand the same way KNOWN_PERSONS decodes who_to.
 *
 * Two sources are joined:
 *   1. wiki/entities/<slug>.md frontmatter — the canonical `name`, `aliases`,
 *      and `type` (project|term|technology|organization). This is the only
 *      place the entity TYPE lives; the DB intentionally stores just slugs.
 *   2. The memory module's active facts — the most recent active fact for the
 *      entity supplies the EXPANSION ("Phoenix → миграция БД на PostgreSQL").
 *      Without a fact we still emit the name + kind, which already tells the
 *      LLM "Phoenix is a project codename".
 *
 * Cache: glossary list is rescanned at most every TTL ms (default 60s),
 * matching WikiPersonsProvider. Concurrent reads coalesce into one fs walk.
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Entity types we treat as decodable shorthand (everything except person). */
export type GlossaryKind = 'project' | 'term' | 'technology' | 'organization'

const GLOSSARY_KINDS: ReadonlySet<string> = new Set<GlossaryKind>([
  'project',
  'term',
  'technology',
  'organization',
])

export interface GlossaryEntry {
  slug: string
  /** Canonical term/name as the user knows it (e.g. "Phoenix", "СБП"). */
  term: string
  /** Alternative spellings / acronym expansions seen in past captures. */
  aliases: string[]
  kind: GlossaryKind
  /** One-line decode of the term, sourced from the entity's active fact.
   *  Empty when no fact is known yet. */
  expansion: string
  mentionCount: number
}

/** Parsed-from-wiki entity before its expansion fact is attached. */
export interface WikiEntity {
  slug: string
  term: string
  aliases: string[]
  kind: GlossaryKind
  mentionCount: number
}

/** Supplies an expansion (active fact statement) for an entity slug. */
export interface ExpansionSource {
  expansionFor(slug: string): string | null
}

/** Minimal slice of MemoryStore the expansion source needs. */
export interface ActiveFactsReader {
  activeFactsFor(entitySlug: string): Array<{ statement: string; factType: string | null }>
}

/**
 * Expansion source backed by the memory module's active facts. Picks the most
 * descriptive active fact for the entity — preferring fact types that explain
 * WHAT a thing is (status / knows_about / working_on / role) over relational
 * ones — and uses its statement as the decode sentence.
 */
export class MemoryExpansionSource implements ExpansionSource {
  constructor(private readonly facts: ActiveFactsReader) {}

  expansionFor(slug: string): string | null {
    const active = this.facts.activeFactsFor(slug)
    if (active.length === 0) return null
    const ranked = [...active].sort(
      (a, b) => factTypeRank(b.factType) - factTypeRank(a.factType)
    )
    return ranked[0]?.statement?.trim() || null
  }
}

const EXPANSION_FACT_RANK: Record<string, number> = {
  status: 5,
  knows_about: 4,
  working_on: 3,
  role: 2,
  location: 1,
}

function factTypeRank(factType: string | null): number {
  if (!factType) return 0
  return EXPANSION_FACT_RANK[factType] ?? 0
}

export interface GlossaryProvider {
  /** Recently-mentioned glossary terms, sorted by mention_count desc. */
  recentGlossary(limit: number): Promise<GlossaryEntry[]>
}

export interface WikiGlossaryProviderOptions {
  /** Path to the wiki root directory. Entities live under <wikiDir>/entities/. */
  wikiDir: string
  /** Supplies expansions from the memory module. Optional — without it the
   *  glossary still carries term + kind (no decode sentence). */
  expansions?: ExpansionSource | null
  /** Cache TTL in ms. Default 60s. */
  ttlMs?: number
}

interface CacheEntry {
  entries: GlossaryEntry[]
  fetchedAt: number
}

export class WikiGlossaryProvider implements GlossaryProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<GlossaryEntry[]> | null = null
  private ttlMs: number

  constructor(private options: WikiGlossaryProviderOptions) {
    this.ttlMs = options.ttlMs ?? 60_000
  }

  async recentGlossary(limit: number): Promise<GlossaryEntry[]> {
    const now = Date.now()
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.entries.slice(0, limit)
    }
    if (this.inflight) {
      const all = await this.inflight
      return all.slice(0, limit)
    }
    this.inflight = this.scan()
      .then((entries) => {
        this.cache = { entries, fetchedAt: Date.now() }
        return entries
      })
      .finally(() => {
        this.inflight = null
      })
    const all = await this.inflight
    return all.slice(0, limit)
  }

  /** Force-reread on next call. */
  invalidate(): void {
    this.cache = null
  }

  private async scan(): Promise<GlossaryEntry[]> {
    const dir = join(this.options.wikiDir, 'entities')
    if (!existsSync(dir)) return []
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const mdFiles = files.filter((f) => f.endsWith('.md') && !f.endsWith('.mentions.jsonl'))
    const entries: GlossaryEntry[] = []
    for (const file of mdFiles) {
      try {
        const content = await readFile(join(dir, file), 'utf-8')
        const entity = parseGlossaryFrontmatter(content)
        if (!entity) continue
        // Expansion is best-effort: the memory module may not have a fact yet.
        const expansion = this.options.expansions?.expansionFor(entity.slug) ?? ''
        entries.push({ ...entity, expansion })
      } catch {
        // Skip unreadable / half-written files — wiki rollup is async.
      }
    }
    entries.sort((a, b) => b.mentionCount - a.mentionCount)
    return entries
  }
}

/**
 * Pulls a non-person entity from the frontmatter:
 *   slug (required), name (required), type ∈ glossary kinds (required),
 *   aliases (optional list), mention_count (defaults to 0).
 *
 * Returns null for type=person (those are KNOWN_PERSONS) or any type outside
 * the glossary set, or when required fields are missing.
 */
export function parseGlossaryFrontmatter(md: string): WikiEntity | null {
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return null
  const fm = fmMatch[1] ?? ''

  const type = readScalar(fm, 'type')
  if (!type || !GLOSSARY_KINDS.has(type)) return null

  const slug = readScalar(fm, 'slug')
  const name = readScalar(fm, 'name')
  if (!slug || !name) return null

  const aliases = readList(fm, 'aliases')
  const mcRaw = readScalar(fm, 'mention_count')
  const mentionCount = mcRaw ? Number(mcRaw) || 0 : 0

  return { slug, term: name, aliases, kind: type as GlossaryKind, mentionCount }
}

/** Read a `key: value` from YAML frontmatter, stripping quotes. */
function readScalar(fm: string, key: string): string | null {
  const re = new RegExp(`^${escapeRegex(key)}:\\s*(.+?)\\s*$`, 'm')
  const m = fm.match(re)
  if (!m) return null
  return unquote(m[1] ?? '')
}

/** Read a JSON-like list (`aliases: ["a", "b"]`). Returns [] when absent/malformed. */
function readList(fm: string, key: string): string[] {
  const re = new RegExp(`^${escapeRegex(key)}:\\s*\\[(.*?)\\]\\s*$`, 'm')
  const m = fm.match(re)
  if (!m) return []
  const inner = m[1] ?? ''
  if (!inner.trim()) return []
  return inner
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((p) => unquote(p.trim()))
    .filter((s) => s.length > 0)
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  return s
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
