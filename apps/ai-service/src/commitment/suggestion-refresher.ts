/**
 * SuggestionRefresher — folds new evidence into a pending create-suggestion.
 *
 * When the Proposer flags a fresh capture as a duplicate of an existing item
 * (duplicate_of_title) but no real Mindwtr task matches, the title may belong
 * to a pending create-suggestion that hasn't been approved yet. Instead of
 * dropping the signal, we find that pending proposal by normalized title and
 * run the Reviser with the capture as NEW_EVIDENCE — producing a v2 with the
 * extra facts folded in, the same dispatch path the comment handler uses.
 */

import type { ContextStore } from '../context-store/store'
import type { ProposalStore } from '../proposal-store/store'
import type { ProposalDetail } from '../proposal-store/types'
import type { ProposalPayload } from '../proposal-store/payloads'
import type { Reviser, ReviseOutcome } from './reviser'
import { buildSignature, signatureForRecord } from './title-signature'
import { SOURCE_AGENT_COMMITMENT_DETECTOR } from './writer'

export interface SuggestionRefresherDeps {
  store: ProposalStore
  reviser: Reviser
  contextStore: ContextStore
}

export interface RefreshInput {
  /** Title the Proposer matched the capture against (duplicate_of_title). */
  existingTitle: string
  /** Raw text of the new capture, used as NEW_EVIDENCE for the Reviser. */
  captureText: string
}

export type RefreshResult =
  | { kind: 'no-match' }
  | { kind: 'revised'; proposalId: string; doneSuspected?: boolean }
  | { kind: 'clarified'; proposalId: string; doneSuspected?: boolean }
  | { kind: 'skipped'; proposalId: string; reason: string; doneSuspected?: boolean }

/**
 * Stable prefix on the agent's "looks already done" nudge. Used to dedup —
 * we never post a second done-flag if the latest agent message already is one,
 * so repeated captures about a finished task don't spam the thread.
 */
const DONE_FLAG_PREFIX = '🟡 Похоже, это уже выполнено.'

export class SuggestionRefresher {
  constructor(private deps: SuggestionRefresherDeps) {}

  async refresh(input: RefreshInput): Promise<RefreshResult> {
    const wanted = buildSignature(input.existingTitle, null, null)
    const pending = this.deps.store.listPending({
      sourceAgent: SOURCE_AGENT_COMMITMENT_DETECTOR,
      type: 'create',
      limit: 50,
    })
    // signatureForRecord includes who_to/by_when from payload metadata; the
    // Proposer's duplicate_of_title only carries a title, so compare on the
    // title component alone (first segment of the pipe-joined signature).
    const titleOf = (sig: string | null) => (sig === null ? null : sig.split('|')[0])
    const wantedTitle = titleOf(wanted)
    const match = pending.find((p) => titleOf(signatureForRecord(p)) === wantedTitle)
    if (!match) return { kind: 'no-match' }

    const detail = this.deps.store.getDetail(match.id)
    if (!detail) return { kind: 'no-match' }

    const contextSnippets = await this.retrieveContext(detail, input.captureText)
    const outcome = await this.deps.reviser.revise({
      proposal: detail,
      targetTaskState: [],
      contextSnippets,
      newEvidence: input.captureText,
    })

    return this.dispatch(detail, outcome)
  }

  private dispatch(detail: ProposalDetail, outcome: ReviseOutcome): RefreshResult {
    switch (outcome.kind) {
      case 'revise': {
        const currentKind = (detail.currentPayload as ProposalPayload | null)?.kind
        const newKind = (outcome.newPayload as ProposalPayload | null)?.kind
        if (newKind !== currentKind) {
          this.deps.store.audit({
            proposalId: detail.id,
            event: 'apply_failed',
            actor: 'agent',
            meta: {
              stage: 'refresh-validate',
              error: `kind mismatch: current=${currentKind}, proposed=${newKind}`,
            },
          })
          return { kind: 'skipped', proposalId: detail.id, reason: 'kind-mismatch' }
        }
        try {
          this.deps.store.addVersion({
            proposalId: detail.id,
            payload: outcome.newPayload,
            author: 'agent',
            summary: `refreshed on new evidence: ${outcome.summary}`.slice(0, 200),
          })
          this.deps.store.addMessage({
            proposalId: detail.id,
            role: 'agent',
            text: outcome.agentMessage,
          })
        } catch (err) {
          // addVersion throws on resolved-status proposals (parallel capture
          // approved/rejected it between listPending and now). Skip silently.
          return { kind: 'skipped', proposalId: detail.id, reason: (err as Error).message }
        }
        const doneSuspected = this.maybeFlagDone(detail, outcome.evidenceShowsDone)
        return { kind: 'revised', proposalId: detail.id, doneSuspected }
      }
      case 'clarify': {
        try {
          this.deps.store.addMessage({
            proposalId: detail.id,
            role: 'agent',
            text: outcome.agentMessage,
          })
        } catch (err) {
          return { kind: 'skipped', proposalId: detail.id, reason: (err as Error).message }
        }
        const doneSuspected = this.maybeFlagDone(detail, outcome.evidenceShowsDone)
        return { kind: 'clarified', proposalId: detail.id, doneSuspected }
      }
      case 'withdraw': {
        // A fresh capture is never grounds to withdraw a pending suggestion —
        // the user hasn't said no. Leave the proposal untouched, but still flag
        // it if the evidence looks like completion (user confirms the close).
        const doneSuspected = this.maybeFlagDone(detail, outcome.evidenceShowsDone)
        return {
          kind: 'skipped',
          proposalId: detail.id,
          reason: 'reviser-withdraw-ignored',
          doneSuspected,
        }
      }
    }
  }

  /**
   * Conservative completion flag: when the new evidence looks like the task is
   * already DONE, post a single agent nudge asking the user to confirm — we do
   * NOT auto-resolve (false "done" would lose a real task). Deduped: skipped if
   * the latest agent message already is a done-flag, so repeat captures about a
   * finished task don't spam the thread. Returns true if a flag was posted.
   */
  private maybeFlagDone(detail: ProposalDetail, evidenceShowsDone?: boolean): boolean {
    if (!evidenceShowsDone) return false
    const lastAgent = [...detail.messages].reverse().find((m) => m.role === 'agent')
    if (lastAgent?.text.startsWith(DONE_FLAG_PREFIX)) return false
    try {
      this.deps.store.addMessage({
        proposalId: detail.id,
        role: 'agent',
        text: `${DONE_FLAG_PREFIX} Если так — отметь Done; если нет — дай знать, оставлю как есть.`,
      })
      return true
    } catch {
      return false
    }
  }

  private async retrieveContext(detail: ProposalDetail, evidence: string): Promise<string[]> {
    const parts: string[] = [evidence]
    const payload = detail.currentPayload as ProposalPayload | null
    if (payload?.kind === 'create' && payload.task.title) parts.push(payload.task.title)
    const query = parts.join(' ').slice(0, 400)
    try {
      const hits = await this.deps.contextStore.retrieve(query, { topK: 4 })
      return hits.map((h) => h.capture.text.slice(0, 300))
    } catch {
      return []
    }
  }
}
