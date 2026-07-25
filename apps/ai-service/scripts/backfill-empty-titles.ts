#!/usr/bin/env bun
/**
 * One-off repair: create-proposals written with an empty task.title.
 *
 * Cause: the LLM router's OpenAI→Gemini tool-schema conversion silently drops
 * function properties named after a Gemini `Schema` field — `title` among them
 * (also `format`, `default`). The Proposer's `title` property therefore never
 * reached the model, every card was written titleless, and the UI rendered a
 * blank header. Fixed at the source by renaming the property to `task_title`;
 * this script repairs the cards written before that fix.
 *
 * New title comes from the metadata the Proposer *did* manage to return:
 * `ai_what` (plain-language commitment), falling back to `ai_reasoning`.
 *
 * Edits the current version in place rather than appending a new one — this is
 * a data repair, not an agent revision, so it must not bump the card to "v2"
 * or push a "the agent changed this" signal at the user.
 *
 * The DB lives in a Docker named volume; run this INSIDE the container:
 *   docker exec ai-service bun run apps/ai-service/scripts/backfill-empty-titles.ts --dry-run
 *   docker exec ai-service bun run apps/ai-service/scripts/backfill-empty-titles.ts --apply
 *
 * Flags:
 *   --dry-run       print what would change, write nothing (default).
 *   --apply         actually write.
 *   --all-statuses  also repair resolved proposals (default: pending only).
 */

import { join } from 'node:path'
import { ContextStore } from '../src/context-store/store'
import type { CreatePayload } from '../src/proposal-store/payloads'

interface CliFlags {
  apply: boolean
  allStatuses: boolean
}

function parseFlags(argv: string[]): CliFlags {
  return {
    apply: argv.includes('--apply'),
    allStatuses: argv.includes('--all-statuses'),
  }
}

/** Same shape as the Writer's fallback so repaired cards read like fresh ones. */
function deriveTitle(payload: CreatePayload): string {
  const meta = (payload.task.metadata ?? {}) as Record<string, unknown>
  const what = typeof meta.ai_what === 'string' ? meta.ai_what.trim() : ''
  const reasoning = typeof meta.ai_reasoning === 'string' ? meta.ai_reasoning.trim() : ''
  return (what || reasoning).replace(/^\[AI\]\s*/i, '').slice(0, 120)
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2))
  const dataDir = process.env.DATA_DIR ?? '/app/data'
  const contextStore = ContextStore.open({ dbPath: join(dataDir, 'context.db') })
  const db = contextStore.rawDb

  console.log(
    `[backfill-titles] dataDir=${dataDir} apply=${flags.apply} allStatuses=${flags.allStatuses}`
  )

  const rows = db
    .query<{ id: string; status: string; current_version: number; current_payload: string }, []>(
      `SELECT id, status, current_version, current_payload
         FROM proposals
        WHERE type = 'create'${flags.allStatuses ? '' : " AND status = 'pending'"}
        ORDER BY created_at ASC`
    )
    .all()

  let repaired = 0
  let unfixable = 0

  for (const row of rows) {
    let payload: CreatePayload
    try {
      payload = JSON.parse(row.current_payload) as CreatePayload
    } catch {
      console.warn(`[backfill-titles]  ! ${row.id}: unparseable payload, skipped`)
      continue
    }
    if (payload.kind !== 'create') continue
    if ((payload.task.title ?? '').trim().length > 0) continue

    const title = deriveTitle(payload)
    if (!title) {
      console.warn(`[backfill-titles]  ! ${row.id}: no ai_what / ai_reasoning to derive from`)
      unfixable += 1
      continue
    }

    console.log(`[backfill-titles]  · ${row.id} (${row.status}) → "${title}"`)
    if (!flags.apply) continue

    payload.task.title = title
    const json = JSON.stringify(payload)
    db.run(`UPDATE proposals SET current_payload = ? WHERE id = ?`, [json, row.id])
    // Keep the version row consistent with the proposal's current payload —
    // the detail view reads versions, not just the denormalized column.
    db.run(`UPDATE proposal_versions SET payload = ? WHERE proposal_id = ? AND version = ?`, [
      json,
      row.id,
      row.current_version,
    ])
    repaired += 1
  }

  console.log(
    flags.apply
      ? `[backfill-titles] done — repaired=${repaired} unfixable=${unfixable}`
      : `[backfill-titles] dry run — nothing written (use --apply); unfixable=${unfixable}`
  )
  contextStore.close()
}

main()
