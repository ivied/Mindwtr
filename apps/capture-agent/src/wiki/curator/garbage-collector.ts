/**
 * Garbage Collector — Phase A of the curator.
 *
 * The rollup is liberal: OCR noise creates ~2k entity files per day, most
 * with mention_count=1 and never seen again. This pass archives the long
 * tail so downstream curator passes (merger, synthesizer, clusterer) work
 * on a manageable set, and so the wiki/entities/ directory stays
 * navigable for a human.
 *
 * Rules:
 *   - If mention_count >= keepMinMentions → keep
 *   - If type === 'person' → keep regardless of count (any human mention
 *     is potentially load-bearing; we'd rather over-keep people than miss
 *     a recurring counterparty)
 *   - If last_seen is newer than staleAfterMs → keep (might grow soon)
 *   - Otherwise → archive (move to wiki/entities/.archive/<slug>.{md,mentions.jsonl})
 *
 * Archive is reversible — a file moved into `.archive/` keeps its content
 * verbatim, and a future "restore-from-archive" tool (or manual `mv`)
 * brings it back. The pass is idempotent: a second run skips already-
 * archived entities.
 */

import { readdir, readFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntityMd } from './entity-frontmatter'

export interface GarbageCollectorOptions {
  wikiDir: string
  /** Keep any entity with mention_count >= this. Default 2. */
  keepMinMentions?: number
  /** Keep entities whose last_seen is within this window (ms). Default 7 days. */
  staleAfterMs?: number
  /** Entity types that are never archived regardless of count. Default ['person']. */
  protectedTypes?: string[]
  /** Test seam — defaults to wall clock. */
  now?: () => Date
  /** When true, log decisions but don't move files. */
  dryRun?: boolean
  log?: (msg: string) => void
}

export interface GarbageCollectorResult {
  scanned: number
  kept: number
  archived: number
  protected: number
  /** Entities for which the .md couldn't be parsed — left alone. */
  unparsable: number
  /** Per-slug archive decision log (only emitted in dryRun for review). */
  decisions?: Array<{ slug: string; reason: 'archived' | 'kept'; rationale: string }>
}

export async function runGarbageCollector(
  options: GarbageCollectorOptions
): Promise<GarbageCollectorResult> {
  const keepMin = options.keepMinMentions ?? 2
  const staleMs = options.staleAfterMs ?? 7 * 24 * 60 * 60 * 1000
  const protectedTypes = new Set(options.protectedTypes ?? ['person'])
  const now = options.now ? options.now() : new Date()
  const log = options.log ?? (() => {})
  const dryRun = options.dryRun === true

  const entitiesDir = join(options.wikiDir, 'entities')
  const archiveDir = join(entitiesDir, '.archive')

  const result: GarbageCollectorResult = {
    scanned: 0,
    kept: 0,
    archived: 0,
    protected: 0,
    unparsable: 0,
  }
  if (dryRun) result.decisions = []

  if (!existsSync(entitiesDir)) {
    log(`[gc] entities dir does not exist yet: ${entitiesDir}`)
    return result
  }

  let files: string[]
  try {
    files = await readdir(entitiesDir)
  } catch (err) {
    log(`[gc] readdir failed: ${(err as Error).message}`)
    return result
  }
  const mdFiles = files.filter((f) => f.endsWith('.md'))

  for (const file of mdFiles) {
    result.scanned += 1
    const slug = file.slice(0, -'.md'.length)
    const fullPath = join(entitiesDir, file)
    let content: string
    try {
      content = await readFile(fullPath, 'utf-8')
    } catch {
      result.unparsable += 1
      continue
    }
    const parsed = parseEntityMd(content)
    if (!parsed) {
      result.unparsable += 1
      continue
    }
    const fm = parsed.frontmatter

    // Decision logic.
    if (protectedTypes.has(fm.type)) {
      result.protected += 1
      result.kept += 1
      if (dryRun) {
        result.decisions!.push({
          slug,
          reason: 'kept',
          rationale: `protected type "${fm.type}"`,
        })
      }
      continue
    }

    if (fm.mentionCount >= keepMin) {
      result.kept += 1
      if (dryRun) {
        result.decisions!.push({
          slug,
          reason: 'kept',
          rationale: `mention_count ${fm.mentionCount} >= ${keepMin}`,
        })
      }
      continue
    }

    const lastSeenTime = Date.parse(fm.lastSeen)
    const ageMs = Number.isFinite(lastSeenTime) ? now.getTime() - lastSeenTime : Infinity
    if (ageMs < staleMs) {
      result.kept += 1
      if (dryRun) {
        result.decisions!.push({
          slug,
          reason: 'kept',
          rationale: `recently active (${Math.round(ageMs / 60_000)}m ago < ${Math.round(staleMs / 60_000)}m)`,
        })
      }
      continue
    }

    // Archive verdict.
    if (dryRun) {
      result.decisions!.push({
        slug,
        reason: 'archived',
        rationale: `mention_count ${fm.mentionCount} < ${keepMin}, last_seen ${Math.round(ageMs / (24 * 3600_000))}d ago`,
      })
      result.archived += 1
      continue
    }

    try {
      await archive(entitiesDir, archiveDir, slug)
      result.archived += 1
      log(`[gc] archived ${slug} (count=${fm.mentionCount}, age=${Math.round(ageMs / 86_400_000)}d)`)
    } catch (err) {
      log(`[gc] archive failed for ${slug}: ${(err as Error).message}`)
      result.unparsable += 1
    }
  }

  return result
}

async function archive(entitiesDir: string, archiveDir: string, slug: string): Promise<void> {
  if (!existsSync(archiveDir)) {
    await mkdir(archiveDir, { recursive: true })
  }
  const md = join(entitiesDir, `${slug}.md`)
  const mentions = join(entitiesDir, `${slug}.mentions.jsonl`)
  if (existsSync(md)) await rename(md, join(archiveDir, `${slug}.md`))
  if (existsSync(mentions)) await rename(mentions, join(archiveDir, `${slug}.mentions.jsonl`))
}
