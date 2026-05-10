#!/usr/bin/env bun
/**
 * One-off backfill: run Enricher against existing Mindwtr inbox tasks that
 * have no `proposal-ai` tag, no `[AI]` prefix, and no pending Enricher
 * proposal yet. For each eligible task, generates a modify/split Proposal so
 * the user can review enrichment for cards captured before the Enricher
 * pipeline existed.
 *
 * Usage (inside the ai-service container so SQLite paths match):
 *   docker exec -e BACKFILL_COUNT=5 ai-service \
 *     bun run scripts/backfill-enrich-inbox.ts [--dry-run]
 *
 * Env:
 *   MINDWTR_CLOUD_URL, MINDWTR_AUTH_TOKEN — Cloud API (same as service)
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL — LLM (same as service)
 *   DATA_DIR — directory holding context.db (same as service)
 *   BACKFILL_COUNT — how many tasks to process (default 5)
 *
 * Flags:
 *   --dry-run — log what would be proposed; don't write to ProposalStore.
 */

import { join } from 'node:path'
import { MindwtrClient } from '../src/api/mindwtr-client'
import { LLMClient } from '../src/ai/client'
import { ContextRetriever } from '../src/ai/retriever'
import { ContextStore } from '../src/context-store/store'
import { ProposalStore } from '../src/proposal-store/store'
import { Enricher } from '../src/commitment/enricher'
import { EnricherPipeline, SOURCE_AGENT_ENRICHER } from '../src/commitment/enricher-pipeline'

interface CliFlags {
  dryRun: boolean
  count: number
}

function parseFlags(argv: string[]): CliFlags {
  const count = Number(process.env.BACKFILL_COUNT ?? 5)
  return {
    dryRun: argv.includes('--dry-run'),
    count: Number.isFinite(count) && count > 0 ? count : 5,
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))

  const cloudUrl = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
  const authToken = process.env.MINDWTR_AUTH_TOKEN ?? ''
  const dataDir = process.env.DATA_DIR ?? '/app/data'
  const llmBaseUrl = process.env.LLM_BASE_URL ?? ''
  const llmApiKey = process.env.LLM_API_KEY ?? ''
  const llmModel = process.env.LLM_MODEL ?? 'cc/claude-opus-4-6'

  if (!authToken) {
    console.error('MINDWTR_AUTH_TOKEN is required')
    process.exit(1)
  }
  if (!llmBaseUrl || !llmApiKey) {
    console.error('LLM_BASE_URL and LLM_API_KEY are required')
    process.exit(1)
  }

  const mindwtr = new MindwtrClient({ baseUrl: cloudUrl, authToken })
  const llm = new LLMClient(llmBaseUrl, llmApiKey, llmModel)
  const contextStore = ContextStore.open({
    dbPath: join(dataDir, 'context.db'),
    ttlMs: 7 * 24 * 60 * 60 * 1000,
  })
  const proposalStore = new ProposalStore(contextStore.rawDb)
  const retriever = new ContextRetriever(contextStore)
  const enricher = new Enricher(llm)
  const pipeline = new EnricherPipeline({ enricher, proposalStore, retriever })

  console.log(
    `[backfill] mode=${flags.dryRun ? 'DRY-RUN' : 'WRITE'} count=${flags.count} llm=${llmModel}`
  )

  const tasks = await mindwtr.listTasks({ status: 'inbox', limit: 200 })

  // Skip AI-tagged / [AI]-prefixed legacy tasks and tasks that already have
  // a pending Enricher proposal — the user already has a suggestion for them.
  const pendingTargets = new Set<string>()
  for (const p of proposalStore.listPending({ sourceAgent: SOURCE_AGENT_ENRICHER, limit: 1000 })) {
    for (const id of p.targetTaskIds) pendingTargets.add(id)
  }

  const eligible = tasks.filter((t) => {
    if (t.title.toLowerCase().startsWith('[ai]')) return false
    if ((t.tags ?? []).includes('proposal-ai')) return false
    if (pendingTargets.has(t.id)) return false
    return true
  })

  console.log(
    `[backfill] inbox=${tasks.length} eligible=${eligible.length} pending_already=${pendingTargets.size}`
  )

  const picked = eligible.slice(0, flags.count)
  if (picked.length === 0) {
    console.log('[backfill] nothing to do')
    contextStore.close()
    return
  }

  let proposed = 0
  let skipped = 0
  let failed = 0

  for (const [i, task] of picked.entries()) {
    const tag = `[${i + 1}/${picked.length}] ${task.id.slice(0, 8)}`
    const title = task.title.length > 70 ? task.title.slice(0, 67) + '…' : task.title
    console.log(`${tag} "${title}"`)

    if (flags.dryRun) {
      console.log(`${tag}   (dry-run, skipping LLM call)`)
      continue
    }

    try {
      const outcome = await pipeline.run({
        taskId: task.id,
        taskTitle: task.title,
        taskTags: task.tags ?? [],
        text: task.title + (task.description ? '\n' + task.description : ''),
        sourceChannel: 'telegram_dm',
        sourceMeta: { origin: 'backfill', original_created_at: task.createdAt },
        sourceCaptureId: null,
      })
      if (outcome.kind === 'proposed') {
        proposed++
        console.log(`${tag}   ✓ proposed (${outcome.type}) id=${outcome.proposalId.slice(0, 8)}`)
      } else {
        skipped++
        console.log(`${tag}   - skipped (${outcome.reason})`)
      }
    } catch (err) {
      failed++
      console.error(`${tag}   ✗ failed: ${(err as Error).message}`)
    }
  }

  console.log(`[backfill] done — proposed=${proposed} skipped=${skipped} failed=${failed}`)
  contextStore.close()
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
