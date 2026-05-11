/**
 * One-shot backfill: walk an existing wiki captures directory and insert
 * its .md files into the memory module's events table. Run when first
 * adopting the memory module on a system that already has months of
 * capture .md files on disk.
 *
 * Usage (run from apps/ai-service/ on host, NOT in docker):
 *
 *   AGENT_WIKI_DIR=/path/to/wiki \
 *   DATA_DIR=/path/to/ai-service/data \
 *   OPENAI_API_KEY=sk-... \
 *   bun run src/memory/backfill-cli.ts
 *
 * Set `MEMORY_BACKFILL_SINCE=2026-05-01` to limit to events after a date.
 * Set `MEMORY_BACKFILL_LIMIT=100` for a small dry-run.
 * Omit OPENAI_API_KEY to skip embeddings (events still inserted; vector
 * search will only work for things ingested AFTER embeddings are wired).
 */

import { join } from 'node:path'
import { openDb } from '../context-store/db'
import { OpenAIEmbeddings } from '../context-store/embeddings'
import { IngestService } from './ingest'
import { MemoryStore } from './store'

async function main() {
  const wikiDir = process.env.AGENT_WIKI_DIR
  if (!wikiDir) throw new Error('AGENT_WIKI_DIR is required')
  const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
  const dbPath = join(dataDir, 'context.db')
  const capturesRoot = join(wikiDir, 'captures')

  const since = process.env.MEMORY_BACKFILL_SINCE
  const limit = process.env.MEMORY_BACKFILL_LIMIT
    ? Number(process.env.MEMORY_BACKFILL_LIMIT)
    : undefined

  const { db, vecAvailable } = openDb(dbPath)
  const store = new MemoryStore({ db, vecAvailable })

  const apiKey = process.env.OPENAI_API_KEY
  const embeddings = apiKey
    ? new OpenAIEmbeddings({
        apiKey,
        baseUrl: process.env.OPENAI_BASE_URL,
        model: process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small',
      })
    : null

  console.log(`📥 Backfill starting`)
  console.log(`   wikiDir:     ${wikiDir}`)
  console.log(`   captures:    ${capturesRoot}`)
  console.log(`   db:          ${dbPath}`)
  console.log(`   embeddings:  ${embeddings ? 'on' : 'off'}`)
  console.log(`   vec storage: ${vecAvailable ? 'on' : 'off (FTS only)'}`)
  console.log(`   since:       ${since ?? '(beginning)'}`)
  console.log(`   limit:       ${limit ?? '(no limit)'}`)
  console.log(`   existing:    ${store.countEvents()} events, ${store.countFacts()} facts`)
  console.log()

  const ingest = new IngestService({
    store,
    embeddings,
    // NO extractor — backfill does raw events only. Run a separate
    // fact-extraction pass later if you want LLM-derived facts on history.
    extractor: null,
  })

  const startedAt = Date.now()
  let lastLog = Date.now()
  const r = await ingest.backfill(capturesRoot, {
    since,
    limit,
    onProgress: (n, last) => {
      if (Date.now() - lastLog > 5_000) {
        const rate = (n / ((Date.now() - startedAt) / 1000)).toFixed(1)
        console.log(`   ${n} inserted (${rate}/s) — last: ${last.slice(-60)}`)
        lastLog = Date.now()
      }
    },
  })
  const elapsedSec = Math.round((Date.now() - startedAt) / 1000)

  console.log()
  console.log(`✅ Backfill done in ${elapsedSec}s`)
  console.log(`   scanned:  ${r.scanned}`)
  console.log(`   inserted: ${r.inserted}`)
  console.log(`   skipped:  ${r.skipped}`)
  console.log(`   failed:   ${r.failed}`)
  console.log(`   total events now: ${store.countEvents()}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
