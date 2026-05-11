/**
 * Rollup pass over the append-only capture log.
 *
 * Reads new captures since the last run, extracts entities via LLM, and
 * (re)generates entity pages with backlinks to the source captures and
 * cross-links to co-occurring entities. Never touches existing capture
 * files — capture log is immutable.
 *
 * State: `<wikiRoot>/.rollup-state.json` tracks last processed timestamp.
 * Entity pages: `<wikiRoot>/entities/<slug>.md`.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join, relative } from 'node:path'
import { parseCaptureMd } from './frontmatter'
import { extractEntities, type Entity, type ExtractInput } from './entity-extractor'
import type { LlmClient } from './llm-client'

interface RollupState {
  lastTs: string
  totalProcessed: number
  totalEntitiesSeen: number
}

interface CaptureRef {
  path: string
  ts: string
  source: 'audio' | 'screen'
  app: string
  title: string
  url?: string
  body: string
}

interface EntityRecord {
  slug: string
  name: string
  type: string
  aliases: Set<string>
  firstSeen: string
  lastSeen: string
  mentions: Array<{ ts: string; capturePath: string; excerpt: string; source: string; app: string }>
  related: Map<string, number>
}

export interface RollupDeps {
  wikiRoot: string
  llm: LlmClient
  log?: (msg: string) => void
  /** Test seam — defaults to real clock. */
  now?: () => Date
}

export interface RollupResult {
  newCaptures: number
  entitiesUpdated: number
  skipped: number
}

const STATE_FILE = '.rollup-state.json'
const ENTITIES_DIR = 'entities'

export async function runRollup(deps: RollupDeps): Promise<RollupResult> {
  const log = deps.log ?? (() => {})
  const state = await loadState(deps.wikiRoot)
  const captures = await listNewCaptures(deps.wikiRoot, state.lastTs)
  log(`found ${captures.length} new capture(s) since ${state.lastTs}`)
  if (captures.length === 0) {
    return { newCaptures: 0, entitiesUpdated: 0, skipped: 0 }
  }

  // Extract entities for each capture (one LLM call per capture).
  // captureId → entity slugs (for co-occurrence)
  const captureEntities: Array<{ capture: CaptureRef; entities: Entity[] }> = []
  let skipped = 0
  for (const cap of captures) {
    try {
      const entities = await extractEntities(deps.llm, captureToInput(cap))
      captureEntities.push({ capture: cap, entities })
    } catch (err) {
      log(`extract failed for ${cap.path}: ${(err as Error).message}`)
      skipped++
    }
  }

  // Aggregate into entity records.
  const records = new Map<string, EntityRecord>()
  for (const { capture, entities } of captureEntities) {
    const slugsInThisCapture = new Set(entities.map((e) => e.slug))
    for (const e of entities) {
      const rec = records.get(e.slug) ?? newRecord(e, capture.ts)
      rec.aliases.add(e.name)
      if (capture.ts < rec.firstSeen) rec.firstSeen = capture.ts
      if (capture.ts > rec.lastSeen) rec.lastSeen = capture.ts
      rec.mentions.push({
        ts: capture.ts,
        capturePath: capture.path,
        excerpt: e.excerpt,
        source: capture.source,
        app: capture.app,
      })
      // co-occurrence: every other slug in this capture is "related"
      for (const other of slugsInThisCapture) {
        if (other === e.slug) continue
        rec.related.set(other, (rec.related.get(other) ?? 0) + 1)
      }
      records.set(e.slug, rec)
    }
  }

  // Merge with existing entity pages, then write back.
  for (const rec of records.values()) {
    await mergeAndWriteEntity(deps.wikiRoot, rec)
  }

  // Update state to the latest ts we processed.
  const lastTs = captures[captures.length - 1]!.ts
  const totalEntitiesSeen = state.totalEntitiesSeen + records.size
  const totalProcessed = state.totalProcessed + captures.length
  await saveState(deps.wikiRoot, {
    lastTs,
    totalProcessed,
    totalEntitiesSeen,
  })

  return {
    newCaptures: captures.length,
    entitiesUpdated: records.size,
    skipped,
  }
}

function newRecord(e: Entity, ts: string): EntityRecord {
  return {
    slug: e.slug,
    name: e.name,
    type: e.type,
    aliases: new Set([e.name]),
    firstSeen: ts,
    lastSeen: ts,
    mentions: [],
    related: new Map(),
  }
}

function captureToInput(cap: CaptureRef): ExtractInput {
  return {
    app: cap.app,
    title: cap.title,
    url: cap.url,
    source: cap.source,
    body: cap.body,
  }
}

async function loadState(wikiRoot: string): Promise<RollupState> {
  const path = join(wikiRoot, STATE_FILE)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RollupState>
    return {
      lastTs: parsed.lastTs ?? '1970-01-01T00:00:00.000Z',
      totalProcessed: parsed.totalProcessed ?? 0,
      totalEntitiesSeen: parsed.totalEntitiesSeen ?? 0,
    }
  } catch {
    return { lastTs: '1970-01-01T00:00:00.000Z', totalProcessed: 0, totalEntitiesSeen: 0 }
  }
}

async function saveState(wikiRoot: string, state: RollupState): Promise<void> {
  await mkdir(wikiRoot, { recursive: true })
  await writeFile(join(wikiRoot, STATE_FILE), JSON.stringify(state, null, 2), 'utf8')
}

async function listNewCaptures(wikiRoot: string, sinceTs: string): Promise<CaptureRef[]> {
  const capturesRoot = join(wikiRoot, 'captures')
  const files: string[] = []
  await walkMd(capturesRoot, files)
  const refs: CaptureRef[] = []
  for (const f of files) {
    try {
      const text = await readFile(f, 'utf8')
      const { meta, body } = parseCaptureMd(text)
      const ts = String(meta.ts ?? '')
      if (!ts || ts <= sinceTs) continue
      const source = meta.source as 'audio' | 'screen' | undefined
      if (source !== 'audio' && source !== 'screen') continue
      refs.push({
        path: f,
        ts,
        source,
        app: String(meta.app ?? ''),
        title: String(meta.title ?? ''),
        url: meta.url ? String(meta.url) : undefined,
        body,
      })
    } catch {
      // skip unreadable files
    }
  }
  refs.sort((a, b) => (a.ts < b.ts ? -1 : 1))
  return refs
}

async function walkMd(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[]
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[]
  } catch {
    return
  }
  for (const e of entries) {
    const name = String(e.name)
    const full = join(dir, name)
    if (e.isDirectory()) await walkMd(full, out)
    else if (e.isFile() && name.endsWith('.md')) out.push(full)
  }
}

async function mergeAndWriteEntity(wikiRoot: string, rec: EntityRecord): Promise<void> {
  const dir = join(wikiRoot, ENTITIES_DIR)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${rec.slug}.md`)

  let existing: { firstSeen?: string; mentionCount?: number; related?: Map<string, number>; aliases?: Set<string>; customBody?: string } = {}
  try {
    const text = await readFile(path, 'utf8')
    existing = parseExistingEntity(text)
  } catch {
    // new entity
  }

  if (existing.firstSeen && existing.firstSeen < rec.firstSeen) rec.firstSeen = existing.firstSeen
  if (existing.aliases) for (const a of existing.aliases) rec.aliases.add(a)
  if (existing.related) {
    for (const [slug, count] of existing.related) {
      rec.related.set(slug, (rec.related.get(slug) ?? 0) + count)
    }
  }
  const totalMentionCount = (existing.mentionCount ?? 0) + rec.mentions.length

  const md = renderEntityPage(rec, totalMentionCount, wikiRoot, path, existing.customBody)
  await writeFile(path, md, 'utf8')

  // Append new mentions to a separate _mentions.jsonl file (sourced for re-render later)
  const mentionsLog = join(dir, `${rec.slug}.mentions.jsonl`)
  const lines = rec.mentions.map((m) => JSON.stringify(m)).join('\n') + '\n'
  await appendFile(mentionsLog, lines)
}

async function appendFile(path: string, content: string): Promise<void> {
  const { appendFile: append } = await import('node:fs/promises')
  await append(path, content)
}

function parseExistingEntity(text: string): {
  firstSeen?: string
  mentionCount?: number
  related?: Map<string, number>
  aliases?: Set<string>
  customBody?: string
} {
  const out: { firstSeen?: string; mentionCount?: number; related?: Map<string, number>; aliases?: Set<string>; customBody?: string } = {}
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!fmMatch) return out
  const fm = fmMatch[1]!
  const body = fmMatch[2] ?? ''
  out.customBody = extractCustomSections(body)

  const firstSeen = fm.match(/^first_seen:\s*(.+)$/m)
  if (firstSeen) out.firstSeen = firstSeen[1]!.trim()
  const mc = fm.match(/^mention_count:\s*(\d+)/m)
  if (mc) out.mentionCount = Number(mc[1])

  const relatedMatch = fm.match(/^related:\s*\[(.*)\]/m)
  if (relatedMatch) {
    const map = new Map<string, number>()
    const items = relatedMatch[1]!.split(',').map((s) => s.trim()).filter(Boolean)
    for (const item of items) {
      const m = item.match(/^"([^"]+)"(?::(\d+))?$/)
      if (m) map.set(m[1]!, Number(m[2] ?? '1'))
    }
    out.related = map
  }

  const aliasesMatch = fm.match(/^aliases:\s*\[(.*)\]/m)
  if (aliasesMatch) {
    const set = new Set<string>()
    const items = aliasesMatch[1]!.split(',').map((s) => s.trim()).filter(Boolean)
    for (const item of items) {
      const m = item.match(/^"([^"]+)"$/)
      if (m) set.add(m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    }
    out.aliases = set
  }
  return out
}

/**
 * Pulls out body sections we want to preserve across rollup regenerations.
 * Rollup owns frontmatter, `# Title`, `## Related`, and `## Recent mentions`;
 * everything else (`## About`, `## Timeline`, user notes…) is round-tripped
 * verbatim. Without this, the curator's synthesized prose would be wiped on
 * the next rollup pass.
 */
export function extractCustomSections(body: string): string {
  const protectedHeaders = /^##\s+(Related|Recent mentions\b)/i
  const lines = body.split('\n')
  const out: string[] = []
  let inProtected = false
  let started = false
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inProtected = protectedHeaders.test(line)
      if (!inProtected) {
        started = true
        out.push(line)
      }
      continue
    }
    if (/^#\s+/.test(line)) {
      // top-level title — skip; rollup re-emits it
      inProtected = false
      continue
    }
    if (inProtected) continue
    if (!started) continue
    out.push(line)
  }
  // trim trailing blank lines
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop()
  return out.join('\n')
}

function renderEntityPage(
  rec: EntityRecord,
  totalMentionCount: number,
  wikiRoot: string,
  pagePath: string,
  customBody?: string
): string {
  const aliases = [...rec.aliases].slice(0, 10)
  const related = [...rec.related.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)

  const yamlList = (items: string[]) =>
    `[${items.map((s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ')}]`
  const yamlRelated = (entries: Array<[string, number]>) =>
    `[${entries.map(([s, c]) => `"${s}":${c}`).join(', ')}]`

  const fm = [
    '---',
    `slug: ${rec.slug}`,
    `name: "${rec.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    `type: ${rec.type}`,
    `aliases: ${yamlList(aliases)}`,
    `first_seen: ${rec.firstSeen}`,
    `last_seen: ${rec.lastSeen}`,
    `mention_count: ${totalMentionCount}`,
    `related: ${yamlRelated(related)}`,
    '---',
  ].join('\n')

  const lines: string[] = [fm, '', `# ${rec.name}`, '']

  if (customBody && customBody.trim().length > 0) {
    lines.push(customBody, '')
  }

  if (related.length) {
    lines.push('## Related', '')
    for (const [slug, count] of related) {
      lines.push(`- [[${slug}]] — co-occurs in ${count} capture${count === 1 ? '' : 's'}`)
    }
    lines.push('')
  }

  // Show only the most recent N mentions inline; full log is in <slug>.mentions.jsonl
  const recent = [...rec.mentions].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 30)
  if (recent.length) {
    lines.push(`## Recent mentions (last ${recent.length} of ${totalMentionCount})`, '')
    for (const m of recent) {
      const rel = relative(join(pagePath, '..'), m.capturePath)
      const tsShort = m.ts.replace(/T/, ' ').slice(0, 16)
      lines.push(`- ${tsShort} · ${m.source}/${m.app} · [capture](${rel}) — ${m.excerpt}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
