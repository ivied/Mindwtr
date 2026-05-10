/**
 * CommentHandler — orchestrates the dialogue cycle on a Proposal.
 *
 * On each user comment:
 *   1. Validate proposal is pending; reject otherwise.
 *   2. Append the user message via ProposalStore.addMessage.
 *   3. Gather context (target task state, retrieved Context Store snippets).
 *   4. Call Reviser → ReviseOutcome.
 *   5. Dispatch:
 *        revise   → addVersion (new payload) + addMessage (agent reply)
 *        clarify  → addMessage (agent reply only)
 *        withdraw → addMessage (agent reply) + transition('rejected', actor='agent')
 *
 * Wraps everything in a top-level try/catch so a Reviser failure logs an
 * audit event but doesn't lose the user's message (already persisted).
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { ContextStore } from '../context-store/store'
import type { Reviser, ReviseOutcome } from '../commitment/reviser'
import type { ProposalStore } from './store'
import type { ProposalDetail } from './types'
import type { ProposalPayload } from './payloads'

export interface CommentHandlerDeps {
  store: ProposalStore
  reviser: Reviser
  mindwtr: MindwtrClient
  contextStore: ContextStore
}

export interface CommentInput {
  proposalId: string
  text: string
}

export interface CommentResult {
  /** The user message that was appended (always present on success). */
  userMessageId: string
  /** Outcome of the revise call. Null when reviser failed. */
  outcome: ReviseOutcome | null
  /** True when reviser ran without error. */
  ok: boolean
  /** Populated when ok=false. */
  error?: string
}

export class CommentHandler {
  constructor(private deps: CommentHandlerDeps) {}

  async handle(input: CommentInput): Promise<CommentResult> {
    const text = input.text.trim()
    if (!text) {
      throw new Error('Comment text is empty')
    }

    const userMsg = this.deps.store.addMessage({
      proposalId: input.proposalId,
      role: 'user',
      text,
    })

    let detail: ProposalDetail | null = this.deps.store.getDetail(input.proposalId)
    if (!detail) {
      throw new Error(`Proposal ${input.proposalId} not found after comment append`)
    }

    let outcome: ReviseOutcome
    try {
      const targetTaskState = await this.fetchTargetState(detail.targetTaskIds)
      const contextSnippets = await this.retrieveContext(detail, text)
      outcome = await this.deps.reviser.revise({
        proposal: detail,
        targetTaskState,
        contextSnippets,
      })
    } catch (err) {
      const message = (err as Error).message
      this.deps.store.audit({
        proposalId: input.proposalId,
        event: 'apply_failed',
        actor: 'agent',
        meta: { stage: 'revise', error: message, userMessageId: userMsg.id },
      })
      return { userMessageId: userMsg.id, outcome: null, ok: false, error: message }
    }

    this.dispatch(input.proposalId, outcome)
    return { userMessageId: userMsg.id, outcome, ok: true }
  }

  // --- internal ---

  private dispatch(proposalId: string, outcome: ReviseOutcome): void {
    switch (outcome.kind) {
      case 'revise': {
        // Validate the revised payload still has the same kind as current
        // payload — Reviser is told to stay within the same kind, but we
        // double-check to keep apply()'s assumptions intact.
        const current = this.deps.store.get(proposalId)
        if (!current) throw new Error(`Proposal ${proposalId} disappeared mid-revision`)
        const currentKind = (current.currentPayload as ProposalPayload | null)?.kind
        const newKind = (outcome.newPayload as ProposalPayload | null)?.kind
        if (newKind !== currentKind) {
          this.deps.store.audit({
            proposalId,
            event: 'apply_failed',
            actor: 'agent',
            meta: {
              stage: 'revise-validate',
              error: `kind mismatch: current=${currentKind}, proposed=${newKind}`,
            },
          })
          this.deps.store.addMessage({
            proposalId,
            role: 'agent',
            text:
              'Internal: my revision had a different proposal kind than the original. ' +
              'I left the previous version untouched. Could you rephrase your request?',
          })
          return
        }

        this.deps.store.addVersion({
          proposalId,
          payload: outcome.newPayload,
          author: 'agent',
          summary: outcome.summary,
        })
        this.deps.store.addMessage({
          proposalId,
          role: 'agent',
          text: outcome.agentMessage,
        })
        return
      }
      case 'clarify': {
        this.deps.store.addMessage({
          proposalId,
          role: 'agent',
          text: outcome.agentMessage,
        })
        return
      }
      case 'withdraw': {
        this.deps.store.addMessage({
          proposalId,
          role: 'agent',
          text: outcome.agentMessage,
        })
        this.deps.store.transition(proposalId, 'rejected', 'agent', {
          withdraw: true,
          reason: outcome.reason,
        })
        return
      }
    }
  }

  private async fetchTargetState(targetTaskIds: string[]): Promise<Record<string, unknown>[]> {
    if (targetTaskIds.length === 0) return []
    const out: Record<string, unknown>[] = []
    for (const id of targetTaskIds) {
      try {
        const task = await this.deps.mindwtr.getTask(id)
        out.push(task as unknown as Record<string, unknown>)
      } catch {
        // Missing/inaccessible target tasks are surfaced via the snapshot omission;
        // Reviser still gets the rest of the context and can ask for clarification.
      }
    }
    return out
  }

  private async retrieveContext(detail: ProposalDetail, latestUserText: string): Promise<string[]> {
    // Cheap heuristic: combine the latest user message with the proposal title
    // (if create-kind) for the retrieval query.
    const parts: string[] = [latestUserText]
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
