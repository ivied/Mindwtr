/**
 * Done-audit — decides whether a pending create-suggestion looks ALREADY DONE,
 * judging the captures recorded AFTER the card appeared.
 *
 * Two consumers share the judgement core (`judgeProposalDone`):
 *   - scripts/audit-pending-done.ts — read-only CLI verdict table.
 *   - DoneSweeper — the on-demand sweep behind POST /v1/proposals/audit-done.
 *     Done-verdicts get the 🟡 nudge posted on the card (same message contract
 *     as SuggestionRefresher.maybeFlagDone) so the list UI can badge them.
 *     Resolving stays a user decision: a false auto-"done" loses a real task.
 */

import type { ContextStore } from '../context-store/store'
import type { LLMClient } from '../ai/client'
import type { ProposalStore } from './store'
import type { ProposalRecord } from './types'
import type { CreatePayload } from './payloads'
import { DONE_FLAG_PREFIX } from './types'

export type DoneVerdict = 'done' | 'not_done' | 'unclear' | 'no-evidence'

export interface CardVerdict {
  id: string
  title: string
  createdAt: string
  verdict: DoneVerdict
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

export interface DoneJudgeDeps {
  contextStore: ContextStore
  llm: LLMClient
}

/**
 * Judge one pending create-card against captures recorded after it was
 * created. Returns null when the payload is not a create payload. Read-only.
 *
 * `hint` is an optional user nudge ("я оплатил через сайт час назад") — it
 * sharpens retrieval and is passed to the judge as user-provided context.
 */
export async function judgeProposalDone(
  deps: DoneJudgeDeps,
  proposal: ProposalRecord,
  topK = 8,
  hint?: string
): Promise<CardVerdict | null> {
  const payload = proposal.currentPayload as CreatePayload | null
  if (!payload || payload.kind !== 'create') return null
  const meta = (payload.task.metadata ?? {}) as Record<string, unknown>
  const title = payload.task.title || String(meta.ai_what ?? '')
  const what = typeof meta.ai_what === 'string' ? meta.ai_what : ''

  const query = hint ? `${title}\n${what}\n${hint}` : `${title}\n${what}`
  // Over-fetch then time-filter: retrieval ranks over the whole TTL window,
  // so asking for exactly topK lets week-old captures crowd out the only ones
  // that matter (recorded AFTER the card). 54/78 cards came back no-evidence
  // on 2026-10-27 before this over-fetch.
  const hits = await deps.contextStore.retrieve(query, { topK: topK * 5 })
  // Only evidence recorded after the card appeared can report it as finished.
  const after = hits.filter((h) => h.capture.capturedAt > proposal.createdAt).slice(0, topK)

  if (after.length === 0) {
    return {
      id: proposal.id,
      title,
      createdAt: proposal.createdAt,
      verdict: 'no-evidence',
      confidence: 0,
      evidence: '',
      reasoning: 'no captures recorded after this card matched the task',
    }
  }

  const evidenceBlock = after
    .map(
      (h, i) =>
        `[${i + 1}] ${h.capture.capturedAt} · ${h.capture.sourceChannel}\n${h.capture.text.slice(0, 700)}`
    )
    .join('\n\n')

  const response = await deps.llm.chatCompletion({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `TASK (noticed ${proposal.createdAt}):\n${title}\n${what}${
          hint ? `\n\nUSER HINT (where/how to look — not completion evidence by itself):\n${hint}` : ''
        }\n\nEVIDENCE captured afterwards:\n${evidenceBlock}`,
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

  const verdict = (['done', 'not_done', 'unclear'] as const).includes(
    parsed.verdict as 'done' | 'not_done' | 'unclear'
  )
    ? (parsed.verdict as 'done' | 'not_done' | 'unclear')
    : 'unclear'

  return {
    id: proposal.id,
    title,
    createdAt: proposal.createdAt,
    verdict,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    evidence: typeof parsed.evidence_quote === 'string' ? parsed.evidence_quote : '',
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  }
}

export interface DoneSweepStatus {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  processed: number
  total: number
  /** Cards that got a fresh 🟡 nudge this run (excludes already-flagged). */
  flagged: number
  done: number
  notDone: number
  unclear: number
  noEvidence: number
  /** Last per-card failure, if any — the sweep keeps going past card errors. */
  error: string | null
}

export interface DoneSweeperConfig {
  /** Captures retrieved per card. */
  topK?: number
  /** Minimum judge confidence for a done-verdict to earn the 🟡 nudge. */
  minConfidence?: number
  /** Max pending cards per sweep. */
  limit?: number
}

export interface DoneSweeperDeps extends DoneJudgeDeps {
  store: ProposalStore
}

const idleStatus = (): DoneSweepStatus => ({
  running: false,
  startedAt: null,
  finishedAt: null,
  processed: 0,
  total: 0,
  flagged: 0,
  done: 0,
  notDone: 0,
  unclear: 0,
  noEvidence: 0,
  error: null,
})

/**
 * On-demand backlog sweep: judge every pending create-suggestion and post the
 * 🟡 nudge on the ones that look done. One run at a time; progress is polled
 * via status() while the desktop list picks the badges up on its next refresh.
 */
export class DoneSweeper {
  private state: DoneSweepStatus = idleStatus()

  constructor(
    private deps: DoneSweeperDeps,
    private config: DoneSweeperConfig = {}
  ) {}

  status(): DoneSweepStatus {
    return { ...this.state }
  }

  /** Kick off a sweep unless one is already running. Returns immediately. */
  start(): { started: boolean; total: number } {
    if (this.state.running) return { started: false, total: this.state.total }
    const cards = this.deps.store.listPending({
      type: 'create',
      // Literal, not the commitment/writer export — importing commitment from
      // proposal-store would invert the package dependency direction.
      sourceAgent: 'commitment-detector',
      limit: this.config.limit ?? 500,
    })
    this.state = { ...idleStatus(), running: true, startedAt: new Date().toISOString(), total: cards.length }
    void this.run(cards)
    return { started: true, total: cards.length }
  }

  private async run(cards: ProposalRecord[]): Promise<void> {
    try {
      for (const card of cards) {
        try {
          const verdict = await judgeProposalDone(this.deps, card, this.config.topK ?? 8)
          if (verdict) {
            if (verdict.verdict === 'done') this.state.done++
            else if (verdict.verdict === 'not_done') this.state.notDone++
            else if (verdict.verdict === 'unclear') this.state.unclear++
            else this.state.noEvidence++
            if (
              verdict.verdict === 'done' &&
              verdict.confidence >= (this.config.minConfidence ?? 0.5) &&
              this.flag(card.id, verdict)
            ) {
              this.state.flagged++
            }
          }
        } catch (err) {
          this.state.error = (err as Error).message
        }
        this.state.processed++
      }
    } finally {
      this.state.running = false
      this.state.finishedAt = new Date().toISOString()
    }
  }

  /**
   * Post the 🟡 nudge. Same dedup rule as SuggestionRefresher.maybeFlagDone:
   * skip when the latest agent message already is a done-flag, so repeat
   * sweeps don't spam the thread (and don't keep resetting the expiry clock).
   */
  private flag(proposalId: string, verdict: CardVerdict): boolean {
    const detail = this.deps.store.getDetail(proposalId)
    // Re-check status: the user may have resolved the card mid-sweep.
    if (!detail || detail.status !== 'pending') return false
    const lastAgent = [...detail.messages].reverse().find((m) => m.role === 'agent')
    if (lastAgent?.text.startsWith(DONE_FLAG_PREFIX)) return false
    const quote = verdict.evidence ? ` ▸ «${verdict.evidence.slice(0, 200)}»` : ''
    try {
      this.deps.store.addMessage({
        proposalId,
        role: 'agent',
        text: `${DONE_FLAG_PREFIX}${quote} Если так — отметь Done; если нет — дай знать, оставлю как есть.`,
      })
      this.deps.store.audit({
        proposalId,
        event: 'commented',
        actor: 'agent',
        meta: {
          kind: 'done-sweep',
          confidence: verdict.confidence,
          reasoning: verdict.reasoning.slice(0, 300),
        },
      })
      return true
    } catch {
      return false
    }
  }
}
