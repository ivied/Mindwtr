/**
 * Maps loose slugs (as the extractor invented them per-capture) to canonical
 * wiki slugs. The mapping comes from the wiki/entities/*.md files: each
 * canonical slug owns its frontmatter aliases. We build:
 *
 *   - direct: slug → slug (identity)
 *   - normalized: normalize(slug) → canonical_slug
 *   - normalized(alias) → canonical_slug
 *
 * `normalize` strips hyphens/underscores/diacritics and lowercases, same
 * function the wiki merger uses. Lookup order: direct → normalized slug →
 * normalized alias. Misses fall through (the loose slug stays as-is).
 *
 * Wired in two places:
 *   1. IngestService — canonicalize each extracted fact/entity slug BEFORE
 *      INSERT so new data stays clean.
 *   2. CLI sweep (canonicalize-facts-cli.ts) — one-time pass over existing
 *      facts + event_entities to fold historical drift.
 *
 * Loader reads the wiki directory once at construction; call rebuild() to
 * pick up changes (e.g. after a merger run).
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface SlugCanonicalizerOptions {
  wikiDir: string
  log?: (msg: string) => void
}

export class SlugCanonicalizer {
  /** Maps every loose form (canonical slug, normalized slug, normalized alias) to a canonical slug. */
  private map = new Map<string, string>()
  /** Set of canonical slugs (for membership tests). */
  private canonicalSet = new Set<string>()
  private readonly log: (msg: string) => void

  constructor(private readonly opts: SlugCanonicalizerOptions) {
    this.log = opts.log ?? (() => {})
  }

  async rebuild(): Promise<{ canonicalSlugs: number; mapEntries: number }> {
    const entitiesDir = join(this.opts.wikiDir, 'entities')
    const entries = await readdir(entitiesDir).catch(() => [] as string[])
    const mdFiles = (entries as string[]).filter((f) => f.endsWith('.md'))

    const map = new Map<string, string>()
    const canonicalSet = new Set<string>()
    for (const file of mdFiles) {
      const path = join(entitiesDir, file)
      try {
        const s = await stat(path)
        if (!s.isFile()) continue
      } catch {
        continue
      }
      const slug = file.slice(0, -'.md'.length)
      let text: string
      try {
        text = await readFile(path, 'utf-8')
      } catch {
        continue
      }
      const fm = parseFrontmatter(text)
      if (!fm) continue
      const canonical = fm.slug || slug
      canonicalSet.add(canonical)
      // identity: keep the canonical slug as-is
      map.set(canonical, canonical)
      map.set(normalize(canonical), canonical)
      // every alias maps to canonical
      for (const a of fm.aliases) {
        if (!a) continue
        const n = normalize(a)
        if (!n) continue
        // First-write-wins: if two entities share an alias, the wiki merger
        // should have already collapsed them. We don't silently overwrite.
        if (!map.has(n)) map.set(n, canonical)
      }
      // name itself, if different from slug
      if (fm.name) {
        const n = normalize(fm.name)
        if (n && !map.has(n)) map.set(n, canonical)
      }
    }

    this.map = map
    this.canonicalSet = canonicalSet
    this.log(
      `[slug-canonicalizer] loaded ${canonicalSet.size} canonical slugs, ${map.size} total mappings`
    )
    return { canonicalSlugs: canonicalSet.size, mapEntries: map.size }
  }

  /** Returns canonical slug if mapping found, else null. */
  canonicalOf(looseSlug: string): string | null {
    if (!looseSlug) return null
    // 1. Direct hit — already canonical
    const direct = this.map.get(looseSlug)
    if (direct) return direct
    // 2. Normalized hit
    const n = normalize(looseSlug)
    if (!n) return null
    const viaNorm = this.map.get(n)
    if (viaNorm) return viaNorm
    return null
  }

  /** Like canonicalOf, but returns the original slug if no mapping found (passthrough). */
  canonicalizeOrPassthrough(looseSlug: string): string {
    return this.canonicalOf(looseSlug) ?? looseSlug
  }

  has(canonical: string): boolean {
    return this.canonicalSet.has(canonical)
  }

  /** For diagnostics: returns the full reverse-map sample. */
  sampleMapping(n = 10): Array<[string, string]> {
    return [...this.map.entries()].slice(0, n)
  }
}

// ---------------- helpers ----------------

interface ParsedFrontmatter {
  slug: string
  name: string
  aliases: string[]
}

function parseFrontmatter(text: string): ParsedFrontmatter | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return null
  const fm = m[1] ?? ''
  const read = (key: string): string => {
    const r = fm.match(new RegExp(`^${escapeRe(key)}:\\s*(.+?)\\s*$`, 'm'))
    return r ? unquote(r[1] ?? '') : ''
  }
  const slug = read('slug')
  const name = read('name')
  // aliases: ["Foo", "Bar", "Baz"]
  const am = fm.match(/^aliases:\s*\[(.*?)\]\s*$/m)
  const aliases: string[] = []
  if (am) {
    const inner = am[1] ?? ''
    // split on commas not inside quoted strings
    const parts = inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    for (const p of parts) {
      const t = unquote(p.trim())
      if (t) aliases.push(t)
    }
  }
  if (!slug) return null
  return { slug, name, aliases }
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining marks
    .replace(/[-_\s.]/g, '')
}

function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return t
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
