/**
 * Proposal Store types — first-class entity for AI-suggested changes.
 *
 * See architecture-addendum-proposal-entity-2026-05-05.md for the design.
 */

export type ProposalType = 'create' | 'modify' | 'delete' | 'merge' | 'split' | 'move'

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'stale'
  | 'expired'

export type ProposalActor = 'agent' | 'user' | 'system'

export type ProposalAuthor = 'agent' | 'user'

export type MessageRole = 'user' | 'agent'

export type AuditEvent =
  | 'created'
  | 'revised'
  | 'commented'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'stale'
  | 'expired'
  | 'applied'
  | 'apply_failed'

export interface ProposalRecord {
  id: string
  type: ProposalType
  targetTaskIds: string[]
  sourceCaptureId: string | null
  sourceAgent: string
  status: ProposalStatus
  currentPayload: unknown
  currentVersion: number
  originSnapshot: unknown | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
}

export interface ProposalVersionRecord {
  proposalId: string
  version: number
  payload: unknown
  author: ProposalAuthor
  summary: string | null
  createdAt: string
}

export interface ProposalMessageRecord {
  id: string
  proposalId: string
  role: MessageRole
  text: string
  refVersion: number | null
  createdAt: string
}

export interface ProposalAuditRecord {
  id: string
  proposalId: string
  event: AuditEvent
  eventMeta: Record<string, unknown> | null
  actor: ProposalActor
  ts: string
}

/** Full proposal aggregate with versions, messages, and audit log. */
export interface ProposalDetail extends ProposalRecord {
  versions: ProposalVersionRecord[]
  messages: ProposalMessageRecord[]
  audit: ProposalAuditRecord[]
}

export interface CreateProposalInput {
  type: ProposalType
  targetTaskIds: string[]
  sourceAgent: string
  /** First version's payload (becomes current_payload). */
  payload: unknown
  /** Optional snapshot of target tasks at creation time (used by apply for drift detection). */
  originSnapshot?: unknown
  sourceCaptureId?: string | null
  /** Author of the initial version. Defaults to 'agent'. */
  author?: ProposalAuthor
  /** Optional one-liner summarizing why proposal was created. */
  summary?: string
}

export interface ListPendingFilter {
  sourceAgent?: string
  type?: ProposalType
  /** Only proposals whose target_task_ids include this id (matches modify/delete/merge/split/move). */
  targetTaskId?: string
  limit?: number
}

export interface AddVersionInput {
  proposalId: string
  payload: unknown
  author: ProposalAuthor
  summary?: string
}

export interface AddMessageInput {
  proposalId: string
  role: MessageRole
  text: string
  refVersion?: number
}

export interface AuditInput {
  proposalId: string
  event: AuditEvent
  actor: ProposalActor
  meta?: Record<string, unknown>
}
