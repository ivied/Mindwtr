/**
 * Clusterer — Phase D of the curator.
 *
 * Reads the entity co-occurrence graph (every entity's `related: [...]`
 * list) and emits one page per topic at `wiki/topics/<slug>.md`. A
 * "topic" is a connected component of the graph after pruning weak
 * edges (weight < minEdgeWeight) and isolated nodes.
 *
 * Why no LLM here:
 *   - Connected-component clustering is deterministic and free.
 *   - The natural label is the highest-mention member's name, which
 *     reads fine for an internal nav page.
 *   - If/when a human-readable topic title matters more than nav, we
 *     can layer an LLM-naming step inside `pickClusterName` without
 *     restructuring the page format.
 *
 * Topic page format:
 *   ---
 *   slug, name, member_count, total_mentions, generated_at
 *   ---
 *
 *   # {topic name}
 *
 *   ## Members
 *   - [[slug]] · N mentions — first line of About / fallback excerpt
 *   ...
 *
 * The pass is fully idempotent: each run rewrites every topic page
 * from scratch and removes any topic pages that no longer correspond
 * to a current cluster.
 */

import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntityMd, type ParsedEntity } from './entity-frontmatter'

export interface ClustererOptions {
  wikiDir: string
  /** Drop edges weighted below this. Default 2 (an edge of weight 1 is one shared capture — too thin). */
  minEdgeWeight?: number
  /** Skip clusters smaller than this. Default 3. */
  minClusterSize?: number
  /** Skip clusters larger than this — usually the everything-blob. Default 50. */
  maxClusterSize?: number
  /** Skip clusters whose total mentions are below this. Default 8. */
  minClusterMentions?: number
  /** Override clock. */
  now?: () => Date
  /** When true, compute clusters but don't write topic pages. */
  dryRun?: boolean
  log?: (msg: string) => void
}

export interface ClusterSummary {
  slug: string
  name: string
  size: number
  totalMentions: number
  members: Array<{ slug: string; mentionCount: number }>
}

export interface ClustererResult {
  scanned: number
  clustersFound: number
  topicsWritten: number
  topicsRemoved: number
  clusters: ClusterSummary[]
}

export async function runClusterer(options: ClustererOptions): Promise<ClustererResult> {
  const minEdgeWeight = options.minEdgeWeight ?? 2
  const minSize = options.minClusterSize ?? 3
  const maxSize = options.maxClusterSize ?? 50
  const minTotalMentions = options.minClusterMentions ?? 8
  const now = options.now ? options.now() : new Date()
  const log = options.log ?? (() => {})
  const dryRun = options.dryRun === true

  const entitiesDir = join(options.wikiDir, 'entities')
  const topicsDir = join(options.wikiDir, 'topics')

  const result: ClustererResult = {
    scanned: 0,
    clustersFound: 0,
    topicsWritten: 0,
    topicsRemoved: 0,
    clusters: [],
  }

  if (!existsSync(entitiesDir)) {
    log(`[cluster] entities dir does not exist yet: ${entitiesDir}`)
    return result
  }

  // Load all entities.
  const entries = await readdir(entitiesDir)
  const mdFiles = entries.filter((f) => f.endsWith('.md'))
  const entities = new Map<string, ParsedEntity>()
  for (const file of mdFiles) {
    const slug = file.slice(0, -'.md'.length)
    const path = join(entitiesDir, file)
    try {
      const s = await stat(path)
      if (!s.isFile()) continue
    } catch {
      continue
    }
    const text = await readFile(path, 'utf-8')
    const parsed = parseEntityMd(text)
    if (!parsed) continue
    entities.set(slug, parsed)
    result.scanned += 1
  }

  // Build graph. Edges are symmetric — A.related contains B and B.related
  // may or may not contain A; we OR the two directions and keep the max
  // count to avoid double-counting if both sides report it.
  const adjacency = new Map<string, Map<string, number>>()
  for (const [slug, parsed] of entities) {
    if (!adjacency.has(slug)) adjacency.set(slug, new Map())
    for (const ref of parsed.frontmatter.related) {
      if (!entities.has(ref.slug)) continue // dangling ref (stale)
      if (ref.count < minEdgeWeight) continue
      const a = adjacency.get(slug)!
      a.set(ref.slug, Math.max(a.get(ref.slug) ?? 0, ref.count))
      if (!adjacency.has(ref.slug)) adjacency.set(ref.slug, new Map())
      const b = adjacency.get(ref.slug)!
      b.set(slug, Math.max(b.get(slug) ?? 0, ref.count))
    }
  }

  // Connected components.
  const visited = new Set<string>()
  const components: string[][] = []
  for (const slug of entities.keys()) {
    if (visited.has(slug)) continue
    if ((adjacency.get(slug)?.size ?? 0) === 0) {
      visited.add(slug)
      continue // isolated node
    }
    const stack = [slug]
    const component: string[] = []
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (visited.has(cur)) continue
      visited.add(cur)
      component.push(cur)
      for (const nbr of adjacency.get(cur)?.keys() ?? []) {
        if (!visited.has(nbr)) stack.push(nbr)
      }
    }
    if (component.length >= 2) components.push(component)
  }

  // Build cluster summaries, filter by size/total mentions.
  const candidates: ClusterSummary[] = []
  for (const comp of components) {
    if (comp.length < minSize || comp.length > maxSize) continue
    const members = comp
      .map((s) => ({
        slug: s,
        mentionCount: entities.get(s)!.frontmatter.mentionCount,
      }))
      .sort((a, b) => b.mentionCount - a.mentionCount)
    const totalMentions = members.reduce((sum, m) => sum + m.mentionCount, 0)
    if (totalMentions < minTotalMentions) continue
    const topMember = entities.get(members[0]!.slug)!
    const clusterName = pickClusterName(topMember)
    const clusterSlug = members[0]!.slug
    candidates.push({
      slug: clusterSlug,
      name: clusterName,
      size: comp.length,
      totalMentions,
      members,
    })
  }

  // De-dupe by slug — multiple components could theoretically pick the same
  // top member if data is weird. Keep largest.
  const bySlug = new Map<string, ClusterSummary>()
  for (const c of candidates) {
    const prev = bySlug.get(c.slug)
    if (!prev || c.totalMentions > prev.totalMentions) bySlug.set(c.slug, c)
  }
  result.clusters = [...bySlug.values()].sort((a, b) => b.totalMentions - a.totalMentions)
  result.clustersFound = result.clusters.length

  if (dryRun) return result

  const haveTopicsDir = existsSync(topicsDir)
  if (!haveTopicsDir) {
    if (result.clusters.length === 0) return result
    await mkdir(topicsDir, { recursive: true })
  }

  const expectedFiles = new Set(result.clusters.map((c) => `${c.slug}.md`))
  const existingTopics = haveTopicsDir
    ? (await readdir(topicsDir)).filter((f) => f.endsWith('.md'))
    : []

  for (const cluster of result.clusters) {
    const page = renderTopicPage(cluster, entities, now)
    await writeFile(join(topicsDir, `${cluster.slug}.md`), page, 'utf-8')
    result.topicsWritten += 1
  }

  for (const f of existingTopics) {
    if (!expectedFiles.has(f)) {
      try {
        await unlink(join(topicsDir, f))
        result.topicsRemoved += 1
      } catch (err) {
        log(`[cluster] failed to remove stale topic ${f}: ${(err as Error).message}`)
      }
    }
  }

  return result
}

function pickClusterName(topMember: ParsedEntity): string {
  return topMember.frontmatter.name
}

function renderTopicPage(
  cluster: ClusterSummary,
  entities: Map<string, ParsedEntity>,
  now: Date
): string {
  const memberLines = cluster.members.map((m) => {
    const parsed = entities.get(m.slug)!
    const preview = extractFirstAbout(parsed.body) ?? ''
    return `- [[${m.slug}]] · ${m.mentionCount} mentions${preview ? ` — ${preview}` : ''}`
  })
  const fm = [
    '---',
    `slug: ${cluster.slug}`,
    `name: "${escapeStr(cluster.name)}"`,
    `member_count: ${cluster.size}`,
    `total_mentions: ${cluster.totalMentions}`,
    `generated_at: ${now.toISOString()}`,
    `members: [${cluster.members.map((m) => `"${m.slug}":${m.mentionCount}`).join(', ')}]`,
    '---',
  ].join('\n')
  return `${fm}\n\n# ${cluster.name}\n\n## Members\n${memberLines.join('\n')}\n`
}

function extractFirstAbout(body: string): string | null {
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+about\b/i.test(lines[i]!)) {
      for (let j = i + 1; j < lines.length; j++) {
        const text = lines[j]!.trim()
        if (!text) continue
        if (text.startsWith('#')) break
        return text.slice(0, 120)
      }
      return null
    }
  }
  return null
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
