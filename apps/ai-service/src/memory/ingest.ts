/**
 * Ingest pipeline for the memory module.
 *
 * Two modes:
 *   1. live   — called from /v1/capture (the existing AI-service endpoint).
 *              UnifiedExtractor returns entities + facts; both get persisted.
 *   2. backfill — walks wiki/captures/**\/*.md and inserts the raw events
 *              WITHOUT running the LLM extractor. Backfill is cheap (just
 *              text + embedding); fact extraction is deferred to a separate
 *              pass that walks events and fills in facts. This lets the user
 *              choose how aggressive to be about LLM spend on history.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { EmbeddingsProvider } from '../context-store/embeddings'
import { UnifiedExtractor, type ExtractInput, type ExtractOutput } from './extractor'
import { contentHash, MemoryStore } from './store'

export interface IngestOptions {
  store: MemoryStore
  embeddings: EmbeddingsProvider | null
  extractor: UnifiedExtractor | null
}

export interface IngestLiveInput {
  id: string
  ts: string
  source: 'screen' | 'audio'
  app: string
  title: string
  url?: string
  body: string
  meta?: Record<string, unknown>
  capturePath?: string
}

export interface IngestLiveResult {
  inserted: boolean
  duplicate: boolean
  extraction: ExtractOutput | null
  factIdsInserted: number[]
}

export class IngestService {
  constructor(private readonly opts: IngestOptions) {}

  /**
   * Live ingest: persist event + run UnifiedExtractor + write facts.
   * Idempotent on body content_hash.
   */
  async live(input: IngestLiveInput): Promise<IngestLiveResult> {
    const embedding = this.opts.embeddings
      ? await this.opts.embeddings.embed(input.body.slice(0, 8000))
      : null

    const inserted = this.opts.store.insertEvent(
      {
        id: input.id,
        ts: input.ts,
        source: input.source,
        app: input.app,
        title: input.title,
        body: input.body,
        meta: input.meta ?? null,
        capturePath: input.capturePath ?? null,
      },
      embedding
    )
    if (!inserted) {
      return { inserted: false, duplicate: true, extraction: null, factIdsInserted: [] }
    }

    if (!this.opts.extractor) {
      return { inserted: true, duplicate: false, extraction: null, factIdsInserted: [] }
    }

    const extractInput: ExtractInput = {
      app: input.app,
      title: input.title,
      url: input.url,
      source: input.source,
      body: input.body,
    }

    let extraction: ExtractOutput
    try {
      extraction = await this.opts.extractor.extract(extractInput)
    } catch (err) {
      console.warn(`[memory:ingest] extractor failed for ${input.id}: ${(err as Error).message}`)
      return { inserted: true, duplicate: false, extraction: null, factIdsInserted: [] }
    }

    const validSlugs = new Set(extraction.entities.map((e) => e.slug))
    this.opts.store.linkEntities(input.id, [...validSlugs])

    const factIds: number[] = []
    for (const fact of extraction.facts) {
      if (!validSlugs.has(fact.entity_slug)) continue
      try {
        const inserted = this.opts.store.insertFact(
          {
            statement: fact.statement,
            entitySlug: fact.entity_slug,
            factType: fact.fact_type,
            validFrom: input.ts,
            sourceEventId: input.id,
            confidence: fact.confidence ?? null,
          },
          fact.supersedes_previous === true
        )
        factIds.push(inserted.id)
      } catch (err) {
        console.warn(
          `[memory:ingest] insertFact failed for ${input.id}/${fact.entity_slug}: ${(err as Error).message}`
        )
      }
    }

    return { inserted: true, duplicate: false, extraction, factIdsInserted: factIds }
  }

  /**
   * Backfill: walk a captures directory, parse each .md, insert event.
   * NO extractor call — caller decides whether to run extraction later
   * (cheaper to skip LLM on historical data, just need the search index).
   */
  async backfill(
    capturesRoot: string,
    options?: {
      since?: string
      limit?: number
      onProgress?: (n: number, last: string) => void
    }
  ): Promise<{ scanned: number; inserted: number; skipped: number; failed: number }> {
    const since = options?.since
    const limit = options?.limit ?? Infinity
    let scanned = 0
    let inserted = 0
    let skipped = 0
    let failed = 0
    const onProgress = options?.onProgress

    for await (const mdPath of walkMd(capturesRoot)) {
      if (scanned >= limit) break
      scanned += 1
      try {
        const text = await readFile(mdPath, 'utf-8')
        const parsed = parseCaptureMd(text)
        if (!parsed) {
          skipped += 1
          continue
        }
        if (since && parsed.ts < since) {
          skipped += 1
          continue
        }
        const embedding = this.opts.embeddings
          ? await this.opts.embeddings.embed(parsed.body.slice(0, 8000))
          : null
        const ok = this.opts.store.insertEvent(
          {
            id: parsed.id,
            ts: parsed.ts,
            source: parsed.source,
            app: parsed.app,
            title: parsed.title,
            body: parsed.body,
            meta: parsed.meta,
            capturePath: mdPath,
          },
          embedding
        )
        if (ok) {
          inserted += 1
          if (onProgress && inserted % 25 === 0) onProgress(inserted, mdPath)
        } else {
          skipped += 1
        }
      } catch (err) {
        failed += 1
        console.warn(`[memory:backfill] ${mdPath}: ${(err as Error).message}`)
      }
    }
    return { scanned, inserted, skipped, failed }
  }
}

// ---------------- capture .md parser ----------------

interface ParsedCapture {
  id: string
  ts: string
  source: 'screen' | 'audio'
  app: string
  title: string
  url: string | null
  body: string
  meta: Record<string, unknown>
}

export function parseCaptureMd(text: string): ParsedCapture | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!m) return null
  const fm = m[1] ?? ''
  const body = (m[2] ?? '').trim()
  if (!body) return null

  const read = (key: string): string | null => {
    const r = fm.match(new RegExp(`^${escapeRe(key)}:\\s*(.+?)\\s*$`, 'm'))
    return r ? unquote(r[1]!) : null
  }

  const id = read('id') ?? ''
  const ts = read('ts') ?? ''
  const source = (read('source') ?? '') as 'screen' | 'audio'
  const app = read('app') ?? ''
  const title = read('title') ?? ''
  const url = read('url')
  if (!id || !ts || !source) return null

  const meta: Record<string, unknown> = {}
  for (const line of fm.split('\n')) {
    const mm = line.match(/^([a-z_][a-z0-9_]*):\s*(.+)$/i)
    if (!mm) continue
    const k = mm[1]!
    if (['id', 'ts', 'source', 'app', 'title', 'url', 'image'].includes(k)) continue
    let v: unknown = unquote(mm[2]!)
    if (v === 'true') v = true
    else if (v === 'false') v = false
    else if (/^-?\d+$/.test(v as string)) v = Number(v)
    meta[k] = v
  }

  return { id: shortId(id), ts, source, app, title, url, body, meta }
}

/**
 * Capture .md frontmatter uses UUID-shaped ids (e.g.
 * "dd9f51a8-8e23-42f7-becb-5ba9d5d731b8"). The filename is shorter
 * (HHMMSS-source-<8hex>). To avoid clashes with future capture ids
 * we keep the UUID but trim — first 8 chars are unique within a day.
 */
function shortId(id: string): string {
  return id // keep full UUID — collisions effectively impossible
}

async function* walkMd(dir: string): AsyncGenerator<string> {
  let entries: string[]
  try {
    entries = (await readdir(dir)) as string[]
  } catch {
    return
  }
  for (const name of entries) {
    const full = join(dir, name)
    let info
    try {
      info = await stat(full)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      yield* walkMd(full)
    } else if (info.isFile() && name.endsWith('.md')) {
      yield full
    }
  }
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

// suppress unused import warning — kept for future use in tests
void contentHash
