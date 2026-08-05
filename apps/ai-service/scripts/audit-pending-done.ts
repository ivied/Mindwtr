#!/usr/bin/env bun
/**
 * Read-only audit: which pending create-suggestions look ALREADY DONE?
 *
 * The live "looks already done" nudge only fires on a fresh capture that the
 * Proposer explicitly links to a pending card. It was dead for weeks (empty
 * titles broke the title-keyed match), so nothing re-checked the backlog. This
 * script does that sweep retroactively: for each pending card it pulls the
 * captures recorded AFTER the card was created and asks the LLM whether that
 * evidence says the action is finished.
 *
 * Writes nothing — it prints a verdict table. Resolving is a separate,
 * deliberate step (the user decides, per the same rule the nudge follows: a
 * false "done" silently loses a real task).
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
import type { CreatePayload } from '../src/proposal-store/payloads'

type Verdict = 'done' | 'not_done' | 'unclear'

interface CardVerdict {
  id: string
  title: string
  createdAt: string
  verdict: Verdict | 'no-evidence'
  confidence: number
  evidence: string
  reasoning: string
}

// No property named `title` / `format` / `default` — the LLM router silently
// drops those (see proposer.ts).
const AUDIT_TOOL = {
  type: 'function',
  function: {
    name: 'judge_completion',
    description:
      'Decide whether the captured evidence shows that a pending task has ALREADY been completed.',
    parameters: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['done', 'not_done', 'unclear'],
          description:
            'done = the evidence states the action was carried out (past-tense completion, a sent/paid/shipped report, the deliverable itself). not_done = the evidence is about the task but shows it is still open. unclear = the evidence does not settle it. Be conservative: prefer unclear over done.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0..1 in the verdict.',
        },
        evidence_quote: {
          type: 'string',
          description:
            'Verbatim quote (≤200 chars) from the evidence that settles it. Empty string when verdict is unclear.',
        },
        reasoning: {
          type: 'string',
          description: 'One sentence explaining the verdict.',
        },
      },
      required: ['verdict', 'confidence', 'evidence_quote', 'reasoning'],
    },
  },
} as const

const SYSTEM_PROMPT = `You check whether a pending to-do has already been done.

You get the task and a set of screen/audio/chat captures recorded AFTER the task
was noticed. Decide if those captures REPORT the task as completed.

Rules:
- "done" needs an actual completion signal: past-tense statement about THIS
  action ("отправил", "оплатил", "sent it", "готово"), a status report, or the
  deliverable itself appearing. Same deliverable, same counterparty.
- Merely mentioning or discussing the topic again is NOT completion.
- Planning to do it ("сделаю завтра") is NOT completion.
- When the captures are about something else, or too thin to tell, say unclear.
- A false "done" makes the user lose a real task. When in doubt: unclear.`

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
    const payload = p.currentPayload as CreatePayload | null
    if (!payload || payload.kind !== 'create') continue
    const meta = (payload.task.metadata ?? {}) as Record<string, unknown>
    const title = payload.task.title || String(meta.ai_what ?? '')
    const what = typeof meta.ai_what === 'string' ? meta.ai_what : ''

    const hits = await contextStore.retrieve(`${title}\n${what}`, { topK: flags.topK })
    // Only evidence recorded after the card appeared can report it as finished.
    const after = hits.filter((h) => h.capture.capturedAt > p.createdAt)

    if (after.length === 0) {
      results.push({
        id: p.id,
        title,
        createdAt: p.createdAt,
        verdict: 'no-evidence',
        confidence: 0,
        evidence: '',
        reasoning: 'no captures recorded after this card matched the task',
      })
      if (!flags.json) {
        console.log(`➖ no-evi  ${p.id.slice(0, 8)}  "${title.slice(0, 70)}"`)
      }
      continue
    }

    const evidenceBlock = after
      .map(
        (h, i) =>
          `[${i + 1}] ${h.capture.capturedAt} · ${h.capture.sourceChannel}\n${h.capture.text.slice(0, 700)}`
      )
      .join('\n\n')

    const response = await llm.chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `TASK (noticed ${p.createdAt}):\n${title}\n${what}\n\nEVIDENCE captured afterwards:\n${evidenceBlock}`,
        },
      ],
      tools: [AUDIT_TOOL],
      tool_choice: 'required',
      max_tokens: 1200,
    })

    const args = response.choices[0]?.message?.tool_calls?.[0]?.function.arguments
    let parsed: Record<string, unknown> = {}
    try {
      parsed = args ? JSON.parse(args) : {}
    } catch {
      /* leave empty — falls through to unclear */
    }

    const verdict = (['done', 'not_done', 'unclear'] as const).includes(parsed.verdict as Verdict)
      ? (parsed.verdict as Verdict)
      : 'unclear'

    results.push({
      id: p.id,
      title,
      createdAt: p.createdAt,
      verdict,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      evidence: typeof parsed.evidence_quote === 'string' ? parsed.evidence_quote : '',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    })

    if (!flags.json) {
      const mark =
        verdict === 'done' ? '✅ DONE   ' : verdict === 'not_done' ? '⬜ open   ' : '❔ unclear'
      console.log(`${mark} ${p.id.slice(0, 8)}  "${title.slice(0, 70)}"`)
      if (verdict === 'done') {
        console.log(`            conf ${results[results.length - 1].confidence.toFixed(2)} · ${parsed.reasoning}`)
        if (results[results.length - 1].evidence) {
          console.log(`            ▸ "${results[results.length - 1].evidence.slice(0, 160)}"`)
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
