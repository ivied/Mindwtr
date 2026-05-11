/**
 * Merger — Phase B of the curator.
 *
 * The LLM extracts the same person/concept under multiple slugs:
 *   "sergey", "sergey-kurdyuk", "sergeykurdyuk"
 *   "polina", "polina-l" (last initial leaked through)
 *   "claude", "claude-ai", "claude-anthropic"
 *
 * This pass collapses near-duplicates into one canonical entity and
 * updates `related:` references in every surviving entity. Losers are
 * archived (not deleted) so a wrong merge can be undone by hand.
 *
 * Detection rules (intentionally conservative — false merges are worse
 * than false negatives because they corrupt the graph):
 *   1. Same normalized slug — strip [-_\s], lowercase. Covers the
 *      "sergey-kurdyuk" ↔ "sergeykurdyuk" case.
 *   2. One entity's normalized name/alias appears in another's
 *      normalized alias/name set. Covers the case where the LLM emits
 *      different slugs but the same human-readable name/alias.
 *
 * Canonical selection within a group: highest mention_count, ties
 * broken by earliest first_seen, then by shortest slug.
 *
 * Merge semantics:
 *   - aliases: union (canonical's order preserved, then unique additions)
 *   - mentionCount: sum across the group
 *   - firstSeen: min (earliest)
 *   - lastSeen: max (latest)
 *   - type: "person" wins if any member is type=person, else canonical's
 *   - related: merged by slug with counts summed; self-refs dropped
 *   - body: canonical's body kept verbatim (bodies are derivable, the
 *     synthesizer pass overwrites them anyway)
 *   - mentions.jsonl: concatenated, sorted by ts ascending
 */

import { readdir, readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseEntityMd,
  serializeEntityMd,
  type EntityFrontmatter,
  type ParsedEntity,
} from './entity-frontmatter'

export interface MergerOptions {
  wikiDir: string
  /** Skip groups whose total mention_count exceeds this — prevents merging two large unrelated entities by accident. Default 500 (the cap is mainly a guard against pathological groupings; real data shows the user themselves can accumulate hundreds of mentions across slug variants). */
  maxTotalMentionsForAutoMerge?: number
  /** When true, log decisions but don't move/write files. */
  dryRun?: boolean
  log?: (msg: string) => void
}

export interface MergeDecision {
  canonical: string
  losers: string[]
  reason: string
  totalMentions: number
  performed: boolean
}

export interface MergerResult {
  scanned: number
  groupsFound: number
  merged: number
  losersArchived: number
  refsRewritten: number
  decisions: MergeDecision[]
}

export async function runMerger(options: MergerOptions): Promise<MergerResult> {
  const maxTotal = options.maxTotalMentionsForAutoMerge ?? 500
  const log = options.log ?? (() => {})
  const dryRun = options.dryRun === true

  const entitiesDir = join(options.wikiDir, 'entities')
  const archiveDir = join(entitiesDir, '.archive')

  const result: MergerResult = {
    scanned: 0,
    groupsFound: 0,
    merged: 0,
    losersArchived: 0,
    refsRewritten: 0,
    decisions: [],
  }

  if (!existsSync(entitiesDir)) {
    log(`[merger] entities dir does not exist yet: ${entitiesDir}`)
    return result
  }

  const entries = await readdir(entitiesDir)
  const mdFiles = entries.filter((f) => f.endsWith('.md'))
  const entities = new Map<string, { parsed: ParsedEntity; path: string }>()

  for (const file of mdFiles) {
    const slug = file.slice(0, -'.md'.length)
    const path = join(entitiesDir, file)
    // skip directories named like X.md (shouldn't happen, but be defensive)
    try {
      const s = await stat(path)
      if (!s.isFile()) continue
    } catch {
      continue
    }
    const text = await readFile(path, 'utf-8')
    const parsed = parseEntityMd(text)
    if (!parsed) continue
    entities.set(slug, { parsed, path })
    result.scanned += 1
  }

  const groups = detectGroups(entities)
  result.groupsFound = groups.length

  // slug-renames maps loser-slug -> canonical-slug; used for related[] rewrite.
  const renames = new Map<string, string>()

  for (const group of groups) {
    const total = group.reduce(
      (sum, slug) => sum + (entities.get(slug)?.parsed.frontmatter.mentionCount ?? 0),
      0
    )
    const canonicalSlug = pickCanonical(group, entities)
    const losers = group.filter((s) => s !== canonicalSlug)

    const decision: MergeDecision = {
      canonical: canonicalSlug,
      losers,
      reason: explainReason(group, entities),
      totalMentions: total,
      performed: false,
    }

    if (total > maxTotal) {
      decision.reason += ` — skipped (total mentions ${total} > cap ${maxTotal})`
      result.decisions.push(decision)
      continue
    }

    decision.performed = !dryRun
    result.decisions.push(decision)

    if (dryRun) continue

    const canonicalEntry = entities.get(canonicalSlug)!
    const loserEntries = losers.map((s) => entities.get(s)!).filter(Boolean)
    const merged = mergeEntities(canonicalEntry.parsed, loserEntries.map((e) => e.parsed))
    await writeFile(canonicalEntry.path, serializeEntityMd(merged), 'utf-8')

    await mergeMentionsFiles(entitiesDir, canonicalSlug, losers, log)
    await archiveLosers(entitiesDir, archiveDir, losers, log)

    for (const loser of losers) {
      renames.set(loser, canonicalSlug)
    }
    result.merged += 1
    result.losersArchived += losers.length

    // Reflect the merge in our in-memory map so subsequent passes (refs
    // rewrite) see the new canonical state.
    entities.set(canonicalSlug, { parsed: merged, path: canonicalEntry.path })
    for (const loser of losers) entities.delete(loser)
  }

  if (!dryRun && renames.size > 0) {
    result.refsRewritten = await rewriteRelatedRefs(entitiesDir, entities, renames)
  }

  return result
}

// ---------------- detection ----------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .replace(/[-_\s.]/g, '')
}

function detectGroups(
  entities: Map<string, { parsed: ParsedEntity; path: string }>
): string[][] {
  // Union-find over slug strings.
  const parent = new Map<string, string>()
  for (const slug of entities.keys()) parent.set(slug, slug)

  function find(x: string): string {
    let cur = x
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur)!
      parent.set(cur, parent.get(p)!)
      cur = parent.get(cur)!
    }
    return cur
  }
  function union(a: string, b: string): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Same-type predicate. We don't merge across types unless one side is a
  // bland fallback like "concept"/"thing" — different types usually means
  // different things even if names collide (kate the person vs kate-notion
  // the integration).
  const blandTypes = new Set(['concept', 'thing', 'topic', 'misc', 'unknown', ''])
  function typesCompatible(a: string, b: string): boolean {
    if (a === b) return true
    if (blandTypes.has(a) || blandTypes.has(b)) return true
    return false
  }

  // Bucket by normalized slug.
  const bySlugNorm = new Map<string, string[]>()
  // Bucket by normalized alias/name token.
  const byNameNorm = new Map<string, string[]>()

  for (const [slug, { parsed }] of entities) {
    const slugKey = normalize(slug)
    if (slugKey.length >= 3) {
      bySlugNorm.set(slugKey, [...(bySlugNorm.get(slugKey) ?? []), slug])
    }
    const names = [parsed.frontmatter.name, ...parsed.frontmatter.aliases]
    for (const name of names) {
      const n = normalize(name)
      if (n.length < 3) continue
      byNameNorm.set(n, [...(byNameNorm.get(n) ?? []), slug])
    }
  }

  const tryUnion = (slugs: string[]) => {
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        const ti = entities.get(slugs[i]!)!.parsed.frontmatter.type
        const tj = entities.get(slugs[j]!)!.parsed.frontmatter.type
        if (typesCompatible(ti, tj)) union(slugs[i]!, slugs[j]!)
      }
    }
  }
  for (const slugs of bySlugNorm.values()) tryUnion(slugs)
  for (const slugs of byNameNorm.values()) tryUnion(slugs)

  // Group by root.
  const groups = new Map<string, string[]>()
  for (const slug of entities.keys()) {
    const root = find(slug)
    groups.set(root, [...(groups.get(root) ?? []), slug])
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

function pickCanonical(
  group: string[],
  entities: Map<string, { parsed: ParsedEntity; path: string }>
): string {
  return [...group].sort((a, b) => {
    const fa = entities.get(a)!.parsed.frontmatter
    const fb = entities.get(b)!.parsed.frontmatter
    if (fa.mentionCount !== fb.mentionCount) return fb.mentionCount - fa.mentionCount
    const ta = Date.parse(fa.firstSeen) || 0
    const tb = Date.parse(fb.firstSeen) || 0
    if (ta !== tb) return ta - tb
    if (a.length !== b.length) return a.length - b.length
    return a.localeCompare(b)
  })[0]!
}

function explainReason(
  group: string[],
  entities: Map<string, { parsed: ParsedEntity; path: string }>
): string {
  const slugNorms = new Set(group.map(normalize))
  if (slugNorms.size === 1) return 'identical normalized slug'
  // Otherwise it must be by shared name/alias.
  return 'shared normalized name/alias'
}

// ---------------- merge ----------------

function mergeEntities(canonical: ParsedEntity, losers: ParsedEntity[]): ParsedEntity {
  const fm: EntityFrontmatter = { ...canonical.frontmatter }

  // type=person sticks regardless of count.
  if (losers.some((l) => l.frontmatter.type === 'person') || fm.type === 'person') {
    fm.type = 'person'
  }

  // Aliases: union, preserving canonical order first.
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const a of [fm.name, ...fm.aliases]) {
    const key = normalize(a)
    if (key && !seen.has(key)) {
      seen.add(key)
      aliases.push(a)
    }
  }
  for (const l of losers) {
    for (const a of [l.frontmatter.name, ...l.frontmatter.aliases]) {
      const key = normalize(a)
      if (key && !seen.has(key)) {
        seen.add(key)
        aliases.push(a)
      }
    }
  }
  // Canonical name stays as its own slot — aliases excludes the name.
  fm.aliases = aliases.filter((a) => normalize(a) !== normalize(fm.name))

  fm.mentionCount = canonical.frontmatter.mentionCount +
    losers.reduce((s, l) => s + l.frontmatter.mentionCount, 0)

  const allFirsts = [fm.firstSeen, ...losers.map((l) => l.frontmatter.firstSeen)]
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t))
  if (allFirsts.length > 0) fm.firstSeen = new Date(Math.min(...allFirsts)).toISOString()

  const allLasts = [fm.lastSeen, ...losers.map((l) => l.frontmatter.lastSeen)]
    .map((s) => Date.parse(s))
    .filter((t) => Number.isFinite(t))
  if (allLasts.length > 0) fm.lastSeen = new Date(Math.max(...allLasts)).toISOString()

  // related: merge by slug, sum counts, drop self-refs.
  const relMap = new Map<string, number>()
  const loserSlugs = new Set(losers.map((l) => l.frontmatter.slug))
  for (const { slug, count } of [...canonical.frontmatter.related, ...losers.flatMap((l) => l.frontmatter.related)]) {
    if (slug === fm.slug || loserSlugs.has(slug)) continue
    relMap.set(slug, (relMap.get(slug) ?? 0) + count)
  }
  fm.related = [...relMap.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count)

  return { frontmatter: fm, body: canonical.body }
}

// ---------------- file ops ----------------

async function mergeMentionsFiles(
  entitiesDir: string,
  canonical: string,
  losers: string[],
  log: (m: string) => void
): Promise<void> {
  const lines: string[] = []
  for (const slug of [canonical, ...losers]) {
    const p = join(entitiesDir, `${slug}.mentions.jsonl`)
    if (!existsSync(p)) continue
    try {
      const text = await readFile(p, 'utf-8')
      for (const line of text.split('\n')) {
        if (line.trim()) lines.push(line)
      }
    } catch (err) {
      log(`[merger] read mentions failed for ${slug}: ${(err as Error).message}`)
    }
  }
  lines.sort((a, b) => {
    const ta = extractTs(a)
    const tb = extractTs(b)
    return ta.localeCompare(tb)
  })
  if (lines.length > 0) {
    await writeFile(join(entitiesDir, `${canonical}.mentions.jsonl`), lines.join('\n') + '\n', 'utf-8')
  }
}

function extractTs(jsonLine: string): string {
  const m = jsonLine.match(/"ts"\s*:\s*"([^"]+)"/)
  return m?.[1] ?? ''
}

async function archiveLosers(
  entitiesDir: string,
  archiveDir: string,
  losers: string[],
  log: (m: string) => void
): Promise<void> {
  if (losers.length === 0) return
  if (!existsSync(archiveDir)) await mkdir(archiveDir, { recursive: true })
  for (const slug of losers) {
    const md = join(entitiesDir, `${slug}.md`)
    const mentions = join(entitiesDir, `${slug}.mentions.jsonl`)
    try {
      if (existsSync(md)) await rename(md, join(archiveDir, `${slug}.md`))
      if (existsSync(mentions)) await rename(mentions, join(archiveDir, `${slug}.mentions.jsonl`))
    } catch (err) {
      log(`[merger] archive failed for ${slug}: ${(err as Error).message}`)
    }
  }
}

async function rewriteRelatedRefs(
  entitiesDir: string,
  entities: Map<string, { parsed: ParsedEntity; path: string }>,
  renames: Map<string, string>
): Promise<number> {
  let rewritten = 0
  for (const [slug, { parsed, path }] of entities) {
    const next: typeof parsed.frontmatter.related = []
    const seen = new Map<string, number>()
    let dirty = false
    for (const ref of parsed.frontmatter.related) {
      const target = renames.get(ref.slug) ?? ref.slug
      if (target !== ref.slug) dirty = true
      if (target === slug) {
        // self-ref after rename — drop it
        dirty = true
        continue
      }
      seen.set(target, (seen.get(target) ?? 0) + ref.count)
    }
    for (const [s, c] of seen) next.push({ slug: s, count: c })
    if (!dirty) continue
    parsed.frontmatter.related = next.sort((a, b) => b.count - a.count)
    await writeFile(path, serializeEntityMd(parsed), 'utf-8')
    rewritten += 1
  }
  return rewritten
}
