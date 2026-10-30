#!/usr/bin/env bun
/**
 * Backfill capture embeddings + prune orphaned vec rows.
 *
 * Context: the OpenAI embeddings key was dead (account_deactivated) from
 * ~2026-10-08 to 2026-10-29, so inserts fell back to no-embedding writes —
 * 19101/19104 captures had no captures_vec row, while ~300k vec rows belonged
 * to captures long since TTL-purged (purgeExpired deletes captures only; the
 * vec table was never cleaned).
 *
 * Does two things, both idempotent / resumable:
 *   1. DELETE captures_vec rows whose capture_id no longer exists in captures.
 *   2. For every capture without a vec row: embed via OpenAI (batched 64
 *      texts/request), INSERT into captures_vec. Per-batch errors are logged
 *      and skipped — rerun to pick up stragglers.
 *
 * Run inside the container (DB lives in a Docker volume):
 *   docker exec ai-service bun run /app/apps/ai-service/scripts/backfill-embeddings.ts
 *
 * Flags:
 *   --dry-run        report counts, change nothing
 *   --batch N        texts per embeddings request (default 64, max 2048)
 *   --limit N        max captures to embed this run (default: all)
 *   --prune-only     only drop/recreate the vec table (needs the service
 *                    STOPPED — DROP TABLE wants an exclusive lock); the
 *                    embed phase is insert-only and safe alongside the
 *                    running service.
 *   --skip-prune     only run the embed phase.
 */

import { Database } from 'bun:sqlite'
import * as sqliteVec from 'sqlite-vec'
import { embeddingToBytes } from '../src/context-store/embeddings'

const DB_PATH = process.env.CONTEXT_DB_PATH ?? '/app/data/context.db'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
const MODEL = process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small'
const DIMENSION = 1536
// OpenAI embeddings input limit is 8192 tokens per item; captures are capped
// at 10k chars upstream, but truncate defensively (~4 chars/token heuristic).
const MAX_CHARS = 24_000

interface Flags {
  dryRun: boolean
  batch: number
  limit: number | null
  pruneOnly: boolean
  skipPrune: boolean
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { dryRun: false, batch: 64, limit: null, pruneOnly: false, skipPrune: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') flags.dryRun = true
    else if (a === '--prune-only') flags.pruneOnly = true
    else if (a === '--skip-prune') flags.skipPrune = true
    else if (a === '--batch') flags.batch = Math.min(Math.max(Number(argv[++i]) || 64, 1), 2048)
    else if (a === '--limit') flags.limit = Math.max(Number(argv[++i]) || 0, 1)
  }
  return flags
}

async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: texts }),
  })
  if (!res.ok) {
    throw new Error(`embeddings failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> }
  if (!json.data || json.data.length !== texts.length) {
    throw new Error(`embeddings: expected ${texts.length} vectors, got ${json.data?.length ?? 0}`)
  }
  // The API preserves order, but sort by index defensively.
  return [...json.data].sort((a, b) => a.index - b.index).map((d) => {
    if (d.embedding.length !== DIMENSION) {
      throw new Error(`embeddings: expected ${DIMENSION}-dim, got ${d.embedding.length}`)
    }
    return Float32Array.from(d.embedding)
  })
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  if (!OPENAI_API_KEY && !flags.dryRun) {
    console.error('[backfill-emb] OPENAI_API_KEY not set')
    process.exit(1)
  }

  const db = new Database(DB_PATH)
  sqliteVec.load(db)
  db.exec('PRAGMA busy_timeout = 10000')

  // --- 1. Prune orphans ---
  // Row-by-row DELETE on a vec0 table with 300k rows is glacial (each delete
  // rewrites vector chunks) and holds the write lock against the live service.
  // When orphans dominate, drop & recreate the virtual table and re-insert the
  // few valid rows instead.
  const orphans = flags.skipPrune
    ? 0
    : (
        db
          .query<{ c: number }, []>(
            'SELECT count(*) c FROM captures_vec WHERE capture_id NOT IN (SELECT id FROM captures)'
          )
          .get() as { c: number }
      ).c
  const valid = (
    db
      .query<{ c: number }, []>(
        'SELECT count(*) c FROM captures_vec WHERE capture_id IN (SELECT id FROM captures)'
      )
      .get() as { c: number }
  ).c
  console.log(`[backfill-emb] vec rows: ${valid} valid, ${orphans} orphaned`)
  if (orphans > 0 && !flags.dryRun) {
    const keep = db
      .query<{ capture_id: string; embedding: Uint8Array }, []>(
        'SELECT capture_id, embedding FROM captures_vec WHERE capture_id IN (SELECT id FROM captures)'
      )
      .all()
    db.exec('DROP TABLE captures_vec')
    db.exec(
      `CREATE VIRTUAL TABLE captures_vec USING vec0(
         capture_id TEXT PRIMARY KEY,
         embedding FLOAT[${DIMENSION}]
       )`
    )
    const reinsert = db.prepare('INSERT INTO captures_vec (capture_id, embedding) VALUES (?, ?)')
    const tx = db.transaction(() => {
      for (const row of keep) reinsert.run(row.capture_id, row.embedding as unknown as Buffer)
    })
    tx()
    console.log(`[backfill-emb] recreated captures_vec: kept ${keep.length}, dropped ${orphans} orphans`)
  }
  if (flags.pruneOnly) {
    console.log('[backfill-emb] prune-only — done')
    db.close()
    return
  }

  // --- 2. Backfill missing embeddings ---
  const missing = db
    .query<{ id: string; text: string }, []>(
      `SELECT id, text FROM captures
        WHERE id NOT IN (SELECT capture_id FROM captures_vec)
        ORDER BY captured_at DESC${flags.limit ? ` LIMIT ${flags.limit}` : ''}`
    )
    .all()
  console.log(`[backfill-emb] captures missing embeddings: ${missing.length}${flags.dryRun ? ' (dry-run, stopping)' : ''}`)
  if (flags.dryRun || missing.length === 0) {
    db.close()
    return
  }

  const insert = db.prepare('INSERT INTO captures_vec (capture_id, embedding) VALUES (?, ?)')
  let done = 0
  let failedBatches = 0
  const t0 = Date.now()

  for (let i = 0; i < missing.length; i += flags.batch) {
    const chunk = missing.slice(i, i + flags.batch)
    try {
      const vectors = await embedBatch(chunk.map((c) => c.text.slice(0, MAX_CHARS)))
      const tx = db.transaction(() => {
        for (let j = 0; j < chunk.length; j++) {
          insert.run(chunk[j]!.id, embeddingToBytes(vectors[j]!))
        }
      })
      tx()
      done += chunk.length
    } catch (err) {
      failedBatches++
      console.error(
        `[backfill-emb] batch ${i / flags.batch} failed (${(err as Error).message.slice(0, 160)}) — skipping; rerun later`
      )
      // Rate limit? Breathe before the next batch.
      await new Promise((r) => setTimeout(r, 5000))
    }
    if (done > 0 && done % 1024 < flags.batch) {
      const rate = done / ((Date.now() - t0) / 1000)
      console.log(`[backfill-emb] ${done}/${missing.length} (${rate.toFixed(0)}/s)`)
    }
  }

  console.log(
    `[backfill-emb] finished: embedded ${done}/${missing.length}, failed batches: ${failedBatches}, took ${((Date.now() - t0) / 1000).toFixed(0)}s`
  )
  db.close()
}

main().catch((err) => {
  console.error('[backfill-emb] fatal:', err)
  process.exit(1)
})
