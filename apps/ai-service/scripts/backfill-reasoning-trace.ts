#!/usr/bin/env bun
/**
 * Backfill reasoning-trace on legacy pending proposals.
 *
 * Older proposals (created before the Proposer schema gained evidence_quote /
 * cues_detected / reasoning_steps) have a captureExcerpt that's just the
 * first 500 chars of OCR — typically Notion sidebars, Telegram chrome,
 * etc., not the actual cue. This script:
 *
 *   1. Finds pending proposals whose traceback has no evidenceQuote.
 *   2. Loads the source capture from Context Store (skip when expired/missing).
 *   3. Re-runs the Proposer on the capture text + metadata.
 *   4. If still is_actionable: addVersion with payload whose `traceback` is
 *      enriched (smart excerpt, evidenceQuote, cuesDetected, reasoningSteps).
 *      The `task` blueprint is left untouched — we don't retroactively rename
 *      titles, just expose the reasoning. Audit gets a 'revised' row.
 *
 * Skipped (logged):
 *   • no source_capture_id on proposal
 *   • capture row gone (Context Store TTL is 7 days)
 *   • non-create payload kind
 *   • Proposer flips to is_actionable=false (legacy proposal still pending —
 *     user decides; we don't auto-reject)
 *
 * Usage (inside ai-service container, env already set by docker compose):
 *   docker exec ai-service bun run /app/apps/ai-service/scripts/backfill-reasoning-trace.ts
 *
 * Or from host (env must be exported):
 *   LLM_BASE_URL=... LLM_API_KEY=... DATA_DIR=... \
 *     bun run scripts/backfill-reasoning-trace.ts
 *
 * Flags:
 *   --dry-run   show what would change, don't write
 *   --limit N   process at most N proposals (default 100)
 */

import { join } from 'node:path'
import { ContextStore } from '../src/context-store/store'
import { ProposalStore } from '../src/proposal-store/store'
import { LLMClient } from '../src/ai/client'
import { Proposer } from '../src/commitment/proposer'
import { smartExcerpt } from '../src/commitment/smart-excerpt'
import type { CreatePayload } from '../src/proposal-store/payloads'

interface CliFlags {
  dryRun: boolean
  limit: number
}

function parseFlags(argv: string[]): CliFlags {
  let limit = 100
  const limitIdx = argv.indexOf('--limit')
  if (limitIdx >= 0 && argv[limitIdx + 1]) limit = Number(argv[limitIdx + 1])
  return { dryRun: argv.includes('--dry-run'), limit }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))

  const dataDir = process.env.DATA_DIR ?? '/app/data'
  const llmBaseUrl = process.env.LLM_BASE_URL
  const llmApiKey = process.env.LLM_API_KEY
  const llmModel = process.env.LLM_MODEL ?? 'cc/claude-opus-4-6'

  if (!llmBaseUrl || !llmApiKey) {
    console.error('LLM_BASE_URL and LLM_API_KEY are required')
    process.exit(1)
  }

  console.log(
    `[backfill] dataDir=${dataDir} dry=${flags.dryRun} limit=${flags.limit} model=${llmModel}`
  )

  const ctx = ContextStore.open({ dbPath: join(dataDir, 'context.db') })
  const store = new ProposalStore(ctx.rawDb)
  const llm = new LLMClient(llmBaseUrl, llmApiKey, llmModel)
  const proposer = new Proposer(llm)

  const pending = store.listPending({ limit: flags.limit })
  console.log(`[backfill] scanning ${pending.length} pending proposal(s)`)

  let enriched = 0
  let skippedNoCapture = 0
  let skippedNonCreate = 0
  let skippedAlready = 0
  let skippedNotActionable = 0
  let failed = 0

  for (const p of pending) {
    const payload = p.currentPayload as CreatePayload
    if (payload.kind !== 'create') {
      skippedNonCreate += 1
      continue
    }
    if (payload.traceback?.evidenceQuote) {
      skippedAlready += 1
      continue
    }
    if (!p.sourceCaptureId) {
      console.log(`  • ${p.id.slice(0, 8)} skip: no source_capture_id`)
      skippedNoCapture += 1
      continue
    }
    const cap = ctx.rawDb
      .query<
        { id: string; text: string; source_meta: string | null },
        [string]
      >('SELECT id, text, source_meta FROM captures WHERE id = ?')
      .get(p.sourceCaptureId)
    if (!cap) {
      console.log(`  • ${p.id.slice(0, 8)} skip: capture ${p.sourceCaptureId.slice(0, 8)} not found (TTL expired?)`)
      skippedNoCapture += 1
      continue
    }
    const sourceMeta = cap.source_meta
      ? (JSON.parse(cap.source_meta) as Record<string, unknown>)
      : undefined

    let proposal
    try {
      proposal = await proposer.propose(cap.text, sourceMeta)
    } catch (err) {
      console.warn(`  ! ${p.id.slice(0, 8)} proposer error: ${(err as Error).message}`)
      failed += 1
      continue
    }

    if (!proposal.is_actionable) {
      console.log(
        `  • ${p.id.slice(0, 8)} skip: proposer now says not_actionable (was: "${payload.task.title.slice(0, 50)}…"). Left pending for user.`
      )
      skippedNotActionable += 1
      continue
    }

    const newPayload: CreatePayload = {
      ...payload,
      traceback: {
        ...(payload.traceback ?? { captureExcerpt: '', sourceChannel: cap.source_meta ? 'unknown' : 'unknown' }),
        captureExcerpt: smartExcerpt(cap.text, proposal.evidence_quote),
        evidenceQuote: proposal.evidence_quote || undefined,
        cuesDetected: proposal.cues_detected.length > 0 ? proposal.cues_detected : undefined,
        reasoningSteps: proposal.reasoning_steps.length > 0 ? proposal.reasoning_steps : undefined,
      },
    }

    if (flags.dryRun) {
      console.log(
        `  ✓ ${p.id.slice(0, 8)} DRY would enrich: "${payload.task.title.slice(0, 50)}…" ` +
          `quote=${(proposal.evidence_quote || '').slice(0, 60)}…`
      )
      enriched += 1
      continue
    }

    store.addVersion({
      proposalId: p.id,
      payload: newPayload,
      author: 'agent',
      summary: 'Backfilled reasoning trace (legacy proposer schema)',
    })
    enriched += 1
    console.log(`  ✓ ${p.id.slice(0, 8)} enriched: "${payload.task.title.slice(0, 50)}…"`)
  }

  console.log(
    `[backfill] done — enriched=${enriched} skipped_already=${skippedAlready} skipped_no_capture=${skippedNoCapture} skipped_non_create=${skippedNonCreate} skipped_not_actionable=${skippedNotActionable} failed=${failed}`
  )
  ctx.close()
}

main().catch((err) => {
  console.error('[backfill] fatal:', err)
  process.exit(1)
})
