#!/usr/bin/env bun
/**
 * Read-only audit: which pending create-suggestions look ALREADY DONE?
 *
 * CLI wrapper around the shared judgement core in
 * src/proposal-store/done-audit.ts. The same core powers the on-demand sweep
 * behind POST /v1/proposals/audit-done — which, unlike this script, also
 * posts the 🟡 nudge on done-verdicts. This script writes nothing — it prints
 * a verdict table. Resolving is a separate, deliberate step (the user
 * decides: a false "done" silently loses a real task).
 *
 * Note: captures live under CONTEXT_STORE_TTL_DAYS (7 by default), so cards
 * older than that window have no evidence left to judge — they come back as
 * no-evidence, not as not-done.
 *
 * Run inside the container (the DB is in a Docker volume):
 *   docker exec ai-service bun run apps/ai-service/scripts/audit-pending-done.ts
 *
 * Flags:
 *   --topk N            captures retrieved per card (default 8)
 *   --status pending|expired  which cards to audit (default pending)
 *   --json              machine-readable output
 */

import { join } from 'node:path'
import { ContextStore } from '../src/context-store/store'
import { OpenAIEmbeddings } from '../src/context-store/embeddings'
import { ProposalStore } from '../src/proposal-store/store'
import { LLMClient } from '../src/ai/client'
import { judgeProposalDone, type CardVerdict } from '../src/proposal-store/done-audit'

interface CliFlags {
  topK: number
  json: boolean
  status: 'pending' | 'expired'
}

function parseFlags(argv: string[]): CliFlags {
  const topKIdx = argv.indexOf('--topk')
  const statusIdx = argv.indexOf('--status')
  const status = statusIdx >= 0 && argv[statusIdx + 1] === 'expired' ? 'expired' : 'pending'
  return {
    topK: topKIdx >= 0 ? Number(argv[topKIdx + 1]) || 8 : 8,
    json: argv.includes('--json'),
    status,
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2))
  const dataDir = process.env.DATA_DIR ?? '/app/data'

  const embeddings = process.env.OPENAI_API_KEY
    ? new OpenAIEmbeddings({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small',
        baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      })
    : null

  const contextStore = ContextStore.open({ dbPath: join(dataDir, 'context.db') }, embeddings)
  const store = new ProposalStore(contextStore.rawDb)
  const llm = new LLMClient(
    process.env.LLM_BASE_URL ?? '',
    process.env.LLM_API_KEY ?? '',
    {
      opus: process.env.LLM_MODEL_OPUS ?? '',
      sonnet: process.env.LLM_MODEL_SONNET ?? '',
      fallbackOpus: process.env.LLM_MODEL_OPUS_FALLBACK || undefined,
      fallbackSonnet: process.env.LLM_MODEL_SONNET_FALLBACK || undefined,
    }
  )

  // ProposalStore has no list-by-arbitrary-status; for expired we go to SQL
  // and re-read each record through the store so the payload parsing matches.
  const pending =
    flags.status === 'pending'
      ? store.listPending({ type: 'create', sourceAgent: 'commitment-detector', limit: 500 })
      : (
          contextStore.rawDb
            .query<{ id: string }, []>(
              `SELECT id FROM proposals
                WHERE type='create' AND status='expired' AND source_agent='commitment-detector'
                ORDER BY created_at`
            )
            .all()
            .map((r) => store.get(r.id))
            .filter((p): p is NonNullable<typeof p> => p !== null)
        )
  if (!flags.json) {
    console.log(
      `[audit-done] ${pending.length} ${flags.status} card(s), retrieval=${contextStore.hasVectorSearch ? 'vec+FTS' : 'FTS only'}, topK=${flags.topK}\n`
    )
  }

  const results: CardVerdict[] = []

  for (const p of pending) {
    const verdict = await judgeProposalDone({ contextStore, llm }, p, flags.topK)
    if (!verdict) continue
    results.push(verdict)

    if (!flags.json) {
      const mark =
        verdict.verdict === 'done'
          ? '✅ DONE   '
          : verdict.verdict === 'not_done'
            ? '⬜ open   '
            : verdict.verdict === 'no-evidence'
              ? '➖ no-evi '
              : '❔ unclear'
      console.log(`${mark} ${verdict.id.slice(0, 8)}  "${verdict.title.slice(0, 70)}"`)
      if (verdict.verdict === 'done') {
        console.log(`            conf ${verdict.confidence.toFixed(2)} · ${verdict.reasoning}`)
        if (verdict.evidence) {
          console.log(`            ▸ "${verdict.evidence.slice(0, 160)}"`)
        }
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2))
  } else {
    const count = (v: string) => results.filter((r) => r.verdict === v).length
    console.log(
      `\n[audit-done] done=${count('done')} open=${count('not_done')} unclear=${count('unclear')} no-evidence=${count('no-evidence')} of ${results.length}`
    )
  }

  contextStore.close()
}

main().catch((err) => {
  console.error('[audit-done] fatal:', err)
  process.exit(1)
})
