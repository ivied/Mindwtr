/**
 * Approval sink for passive captures (screen, ambient sources).
 *
 * Flow: capture → Proposer → if actionable+confident → register proposal +
 * notify user → user clicks Approve/Reject in TG → callback resolves it.
 *
 * Non-actionable items are silently dropped (no inbox spam, no TG noise).
 */

import type { CapturedItem } from '../capture/normalizer'
import type { Proposer, Proposal } from '../ai/proposer'
import type { ProposalStore, PendingProposal } from './store'

export interface ApprovalSinkConfig {
  /** Min confidence to bother user with a proposal. */
  minConfidence: number
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalSinkConfig = {
  minConfidence: 0.6,
}

export type Notifier = (entry: PendingProposal) => Promise<void>

export interface ApprovalSinkDeps {
  proposer: Proposer
  store: ProposalStore
  notify: Notifier
  config?: ApprovalSinkConfig
  log?: (msg: string) => void
}

export type ApprovalSink = (item: CapturedItem) => Promise<ApprovalDecision>

export type ApprovalDecision =
  | { kind: 'proposed'; entry: PendingProposal }
  | { kind: 'dropped'; proposal: Proposal; reason: 'not-actionable' | 'low-confidence' }
  | { kind: 'error'; error: Error }

export function createApprovalSink(deps: ApprovalSinkDeps): ApprovalSink {
  const config = deps.config ?? DEFAULT_APPROVAL_CONFIG

  return async function approvalSink(item: CapturedItem): Promise<ApprovalDecision> {
    let proposal: Proposal
    try {
      proposal = await deps.proposer.propose(item.text, item.sourceMeta)
    } catch (err) {
      deps.log?.(`proposer failed: ${(err as Error).message}`)
      return { kind: 'error', error: err as Error }
    }

    if (!proposal.is_actionable) {
      deps.log?.(`dropped (not-actionable): ${proposal.reasoning}`)
      return { kind: 'dropped', proposal, reason: 'not-actionable' }
    }
    if (proposal.confidence < config.minConfidence) {
      deps.log?.(`dropped (low-conf ${proposal.confidence}): ${proposal.title}`)
      return { kind: 'dropped', proposal, reason: 'low-confidence' }
    }

    const entry = deps.store.add(item, proposal)
    try {
      await deps.notify(entry)
    } catch (err) {
      deps.log?.(`notify failed for ${entry.id}: ${(err as Error).message}`)
      // Keep entry in store so a later poll/retry can show it; but flag the error
      return { kind: 'error', error: err as Error }
    }
    return { kind: 'proposed', entry }
  }
}
