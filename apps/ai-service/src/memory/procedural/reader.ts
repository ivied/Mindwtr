/**
 * Filesystem-watching reader for procedural memory.
 *
 * Scans `<rootDir>/<source>/**\/*.md`, chunks each file by ## headers,
 * embeds (when an embeddings provider is given), and upserts into
 * ProceduralStore. Idempotent — re-running on an unchanged dir is a no-op.
 *
 * Polling strategy (no chokidar dep): every `intervalMs` re-scan and
 * compare file mtimes against what we last indexed. Cheap for tens-to-
 * hundreds of files, which is the realistic scale for `MEMORY.md` +
 * journals.
 *
 * Fail-open: any single-file error is logged, never propagates. The next
 * tick retries.
 */

import { readdir, readFile, stat } from 'fs/promises'
import { join, relative } from 'path'
import type { EmbeddingsProvider } from '../../context-store/embeddings'
import { chunkMarkdown } from './chunker'
import { classifyByHeuristic, type LlmChunkClassifier } from './classifier'
import type { ProceduralStore } from './store'

export interface ProceduralReaderOptions {
  store: ProceduralStore
  /** Absolute path to the shared-memory root (e.g. `/app/shared-memory`). */
  rootDir: string
  /**
   * Sources to index. Each entry maps an on-disk subdirectory under
   * `rootDir` to a logical source label persisted in the DB. Only the
   * listed sources are scanned — files outside these are ignored.
   *
   * Example: [{ subdir: 'openclaw', source: 'openclaw' }]
   */
  sources: Array<{ subdir: string; source: string }>
  /**
   * Optional file-path filter; receives a path relative to the source
   * subdir. Default: only top-level `*.md`. Pass `() => true` to index
   * journals/, workflows/, etc. recursively.
   */
  pathFilter?: (relPath: string) => boolean
  embeddings?: EmbeddingsProvider | null
  /** Polling interval in ms. Default 60_000 (60s). */
  intervalMs?: number
  log?: (msg: string) => void
  /**
   * Optional LLM classifier (Phase 0.5). When present, after every scan
   * tick the reader picks up to `llmClassifyBatchSize` chunks that the
   * heuristic left as `needs-review` and classifies them. Fail-open: a
   * classifier error keeps the chunk hidden (still `needs-review`).
   */
  llmClassifier?: LlmChunkClassifier | null
  /** Per-tick cap on LLM classifier calls. Default 10. */
  llmClassifyBatchSize?: number
}

export interface ScanStats {
  scanned: number
  upserted: number
  unchanged: number
  removed: number
  errors: number
  /** Phase 0.5: chunks classified during this tick (by heuristic). */
  classifiedHeuristic: number
  /** Phase 0.5: chunks the LLM classifier handled this tick. */
  classifiedLlm: number
}

export class ProceduralReader {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private readonly intervalMs: number
  private readonly log: (msg: string) => void
  private readonly pathFilter: (relPath: string) => boolean

  constructor(private readonly opts: ProceduralReaderOptions) {
    this.intervalMs = opts.intervalMs ?? 60_000
    this.log = opts.log ?? ((msg) => console.log(`[procedural] ${msg}`))
    this.pathFilter = opts.pathFilter ?? defaultTopLevelMdFilter
  }

  /** Run one full scan immediately and return per-source stats. */
  async scanOnce(): Promise<ScanStats> {
    if (this.running) {
      return zeroStats()
    }
    this.running = true
    const total = zeroStats()
    try {
      for (const src of this.opts.sources) {
        const stats = await this.scanSource(src.subdir, src.source)
        accumulate(total, stats)
      }
      // Heuristic back-pass over already-indexed chunks that are still
      // 'needs-review'. The upsert path only runs the heuristic on
      // new/changed content; chunks that existed before the classifier
      // was wired never get touched without this back-pass.
      total.classifiedHeuristic += this.runHeuristicBackPass()
      if (this.opts.llmClassifier) {
        const classified = await this.runLlmClassifyBatch(
          this.opts.llmClassifyBatchSize ?? 10
        )
        total.classifiedLlm += classified
      }
    } finally {
      this.running = false
    }
    return total
  }

  /**
   * Re-run the heuristic classifier over every chunk currently in
   * applies_to='needs-review' that hasn't already been LLM-touched. Cheap
   * (regex, no I/O). Returns count of chunks that got a non-'needs-review'
   * verdict.
   */
  runHeuristicBackPass(): number {
    const queue = this.opts.store.listByApplies('needs-review', 1000)
    let decided = 0
    for (const row of queue) {
      // Skip chunks that the LLM has already touched — that means the
      // LLM also said needs-review (or threw). Re-running heuristic on
      // those is a no-op (the heuristic already left them as
      // needs-review on prior ticks).
      if (row.classifiedBy === 'llm') continue
      const verdict = classifyByHeuristic(row.text, row.sectionTitle)
      if (verdict.appliesTo === 'needs-review') continue
      this.opts.store.classify(row.id, verdict.appliesTo, 'heuristic')
      decided += 1
    }
    return decided
  }

  /**
   * Pick up to `limit` chunks that the heuristic left as 'needs-review'
   * and run the LLM classifier over them. Returns the number of chunks
   * for which the classifier produced a non-'needs-review' verdict
   * (so we have a sense of throughput). Each chunk that comes back
   * 'needs-review' from the LLM stays hidden but doesn't block retries
   * on the next tick.
   */
  async runLlmClassifyBatch(limit: number): Promise<number> {
    const classifier = this.opts.llmClassifier
    if (!classifier) return 0
    const queue = this.opts.store.listByApplies('needs-review', limit)
    let decided = 0
    for (const row of queue) {
      try {
        const verdict = await classifier.classify(row.sectionTitle, row.text)
        // Even when the verdict is 'needs-review', record classified_by so
        // the same chunk doesn't get hammered every tick — re-queue only
        // after content changes (which would reset applies_to via upsert).
        const finalApplies = verdict.appliesTo
        const finalBy = verdict.classifiedBy ?? 'llm'
        this.opts.store.classify(row.id, finalApplies, finalBy)
        if (finalApplies !== 'needs-review') decided += 1
        this.log(
          `classify ${row.source}/${row.path}#${row.sectionIndex} → ${finalApplies} (${verdict.reason.slice(0, 80)})`
        )
      } catch (err) {
        this.log(
          `classify error ${row.source}/${row.path}#${row.sectionIndex}: ${(err as Error).message}`
        )
      }
    }
    return decided
  }

  /** Start polling. scanOnce() runs immediately, then every `intervalMs`. */
  start(): void {
    if (this.timer) return
    void this.scanOnce().catch((err) =>
      this.log(`initial scan failed: ${(err as Error).message}`)
    )
    this.timer = setInterval(() => {
      void this.scanOnce().catch((err) =>
        this.log(`scan failed: ${(err as Error).message}`)
      )
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async scanSource(subdir: string, source: string): Promise<ScanStats> {
    const stats = zeroStats()
    const rootForSource = join(this.opts.rootDir, subdir)
    const onDisk = await this.collectFiles(rootForSource).catch(() => null)
    if (!onDisk) {
      // Source dir missing — nothing to do this tick.
      return stats
    }

    const seen = new Set<string>()
    for (const abs of onDisk) {
      const relPath = relative(rootForSource, abs)
      if (!this.pathFilter(relPath)) continue
      seen.add(relPath)
      stats.scanned += 1
      try {
        const fileStat = await stat(abs)
        const fileMtime = Math.floor(fileStat.mtimeMs)
        const content = await readFile(abs, 'utf-8')
        const chunks = chunkMarkdown(content)
        if (chunks.length === 0) {
          this.opts.store.deleteByPath(source, relPath)
          continue
        }
        for (const c of chunks) {
          // Embed when provider is configured. Section title is included
          // in the embed input so retrieval can match on heading keywords.
          const embedInput = c.sectionTitle ? `${c.sectionTitle}\n${c.text}` : c.text
          let embedding: Float32Array | null = null
          if (this.opts.embeddings) {
            try {
              embedding = await this.opts.embeddings.embed(embedInput.slice(0, 8000))
            } catch (err) {
              stats.errors += 1
              this.log(`embed failed for ${relPath} chunk ${c.index}: ${(err as Error).message}`)
              embedding = null
            }
          }
          const before = countRowAt(this.opts.store, source, relPath, c.index)
          // Heuristic classification runs on every upsert (cheap regex).
          // If the chunk already exists and content hasn't changed, the
          // upsert path is a no-op and the existing classification is
          // preserved. New / changed content gets a fresh heuristic verdict.
          const heuristic = classifyByHeuristic(c.text, c.sectionTitle || null)
          this.opts.store.upsert({
            source,
            path: relPath,
            sectionIndex: c.index,
            sectionTitle: c.sectionTitle || null,
            text: c.text,
            fileMtime,
            embedding,
            appliesTo: heuristic.appliesTo,
            classifiedBy: heuristic.classifiedBy,
          })
          const after = countRowAt(this.opts.store, source, relPath, c.index)
          // Cheap distinction: row count is always 1 after upsert; we
          // detect "unchanged" by comparing mtime delta. Good enough for
          // logging only.
          if (before && before.mtime === fileMtime) stats.unchanged += 1
          else {
            stats.upserted += 1
            if (heuristic.classifiedBy === 'heuristic') stats.classifiedHeuristic += 1
          }
          // after intentionally unused; kept for symmetry with future invariants.
          void after
        }
        // Trim any leftover rows beyond the new chunk count.
        this.opts.store.truncateAbove(source, relPath, chunks.length)
      } catch (err) {
        stats.errors += 1
        this.log(`scan error ${relPath}: ${(err as Error).message}`)
      }
    }

    // Drop rows for files that vanished from disk.
    const known = this.opts.store.listKnownPaths(source)
    for (const k of known) {
      if (!seen.has(k.path)) {
        this.opts.store.deleteByPath(source, k.path)
        stats.removed += 1
      }
    }
    if (stats.upserted + stats.removed + stats.errors > 0) {
      this.log(
        `${source}: scanned=${stats.scanned} upserted=${stats.upserted} unchanged=${stats.unchanged} removed=${stats.removed} errors=${stats.errors}`
      )
    }
    return stats
  }

  private async collectFiles(dir: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (d: string): Promise<void> => {
      const entries = await readdir(d, { withFileTypes: true })
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const abs = join(d, e.name)
        if (e.isDirectory()) {
          await walk(abs)
        } else if (e.isFile() && abs.toLowerCase().endsWith('.md')) {
          out.push(abs)
        }
      }
    }
    await walk(dir)
    return out
  }
}

function countRowAt(
  store: ProceduralStore,
  source: string,
  path: string,
  sectionIndex: number
): { mtime: number } | null {
  const row = store.db
    .query<{ file_mtime: number }, [string, string, number]>(
      'SELECT file_mtime FROM procedural_chunks WHERE source = ? AND path = ? AND section_index = ?'
    )
    .get(source, path, sectionIndex)
  return row ? { mtime: row.file_mtime } : null
}

function zeroStats(): ScanStats {
  return {
    scanned: 0,
    upserted: 0,
    unchanged: 0,
    removed: 0,
    errors: 0,
    classifiedHeuristic: 0,
    classifiedLlm: 0,
  }
}

function accumulate(into: ScanStats, from: ScanStats): void {
  into.scanned += from.scanned
  into.upserted += from.upserted
  into.unchanged += from.unchanged
  into.removed += from.removed
  into.errors += from.errors
  into.classifiedHeuristic += from.classifiedHeuristic
  into.classifiedLlm += from.classifiedLlm
}

function defaultTopLevelMdFilter(relPath: string): boolean {
  // Top-level *.md only (no subdir traversal). For Phase 0 this means
  // `openclaw/MEMORY.md` is indexed, `openclaw/journals/2026-05-14.md`
  // is skipped. Phase 0.5 will widen the filter when we add journals.
  return /^[^/\\]+\.md$/i.test(relPath)
}
