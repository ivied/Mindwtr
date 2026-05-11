/**
 * WikiPersonsProvider — reads `<wiki>/entities/*.md` files written by the
 * capture-wiki rollup and surfaces the `type: person` entries as a list of
 * canonical persons the Proposer can normalize who_to against.
 *
 * Each entity file has YAML-ish frontmatter we care about:
 *
 *   ---
 *   slug: amir
 *   name: "Amir"
 *   type: person
 *   aliases: ["Amir", "Амир"]
 *   mention_count: 5
 *   ---
 *
 * We don't pull a full YAML parser for this — capture-wiki writes the
 * frontmatter via a tightly controlled template, so a few regex lines are
 * enough and avoid a dependency.
 *
 * Cache: persons list is rescanned at most every TTL ms (default 60s).
 * Concurrent reads coalesce into a single fs walk.
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface KnownPerson {
  slug: string
  name: string
  aliases: string[]
  mentionCount: number
}

export interface PersonsProvider {
  /** Recently-mentioned known persons, sorted by mention_count desc. */
  recentPersons(limit: number): Promise<KnownPerson[]>
}

export interface WikiPersonsProviderOptions {
  /** Path to the wiki root directory. Persons live under <wikiDir>/entities/. */
  wikiDir: string
  /** Cache TTL in ms. Default 60s. */
  ttlMs?: number
}

interface CacheEntry {
  persons: KnownPerson[]
  fetchedAt: number
}

export class WikiPersonsProvider implements PersonsProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<KnownPerson[]> | null = null
  private ttlMs: number

  constructor(private options: WikiPersonsProviderOptions) {
    this.ttlMs = options.ttlMs ?? 60_000
  }

  async recentPersons(limit: number): Promise<KnownPerson[]> {
    const now = Date.now()
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) {
      return this.cache.persons.slice(0, limit)
    }
    if (this.inflight) {
      const all = await this.inflight
      return all.slice(0, limit)
    }
    this.inflight = this.scan()
      .then((persons) => {
        this.cache = { persons, fetchedAt: Date.now() }
        return persons
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

  private async scan(): Promise<KnownPerson[]> {
    const dir = join(this.options.wikiDir, 'entities')
    if (!existsSync(dir)) return []
    let files: string[]
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    const mdFiles = files.filter((f) => f.endsWith('.md') && !f.endsWith('.mentions.jsonl'))
    const persons: KnownPerson[] = []
    for (const file of mdFiles) {
      try {
        const content = await readFile(join(dir, file), 'utf-8')
        const parsed = parsePersonFrontmatter(content)
        if (parsed) persons.push(parsed)
      } catch {
        // Skip unreadable / malformed entries — wiki rollup is async so we
        // may catch a half-written file. Best-effort.
      }
    }
    persons.sort((a, b) => b.mentionCount - a.mentionCount)
    return persons
  }
}

/**
 * Pulls just enough from the frontmatter for our prompt-injection use case:
 *   slug (required), name (required), type=person (required), aliases (optional list),
 *   mention_count (defaults to 0).
 *
 * Returns null when type != person or required fields are missing.
 */
export function parsePersonFrontmatter(md: string): KnownPerson | null {
  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fmMatch) return null
  const fm = fmMatch[1] ?? ''

  const type = readScalar(fm, 'type')
  if (type !== 'person') return null

  const slug = readScalar(fm, 'slug')
  const name = readScalar(fm, 'name')
  if (!slug || !name) return null

  const aliases = readList(fm, 'aliases')
  const mcRaw = readScalar(fm, 'mention_count')
  const mentionCount = mcRaw ? Number(mcRaw) || 0 : 0

  return { slug, name, aliases, mentionCount }
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
  // Split on commas not inside quotes — simple heuristic adequate for capture-wiki output.
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
