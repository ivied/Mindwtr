/**
 * Proposal payload schemas — discriminated by ProposalType.
 *
 * Stored as JSON in proposals.current_payload (and per-version snapshots in
 * proposal_versions.payload). Used by Writer (creator) and Apply (consumer).
 */

export interface MindwtrTaskBlueprint {
  title: string
  status: 'inbox' | 'next' | 'someday' | 'reference' | 'waiting' | 'scheduled'
  tags: string[]
  description: string
  /**
   * Person this task is waiting on (Mindwtr's native field — surfaces in the
   * Organize > Waiting view). Set by the Proposer when suggested_category=
   * waiting; ignored for other categories.
   */
  assignedTo?: string
  /** Free-form metadata stored on the Mindwtr task. */
  metadata: Record<string, unknown>
}

/** Captures the source story behind a proposal — shown in UI thread, not inserted into Mindwtr. */
export interface ProposalTraceback {
  /** Source-text window centered on `evidenceQuote` when found, otherwise first N chars. */
  captureExcerpt: string
  sourceChannel: string
  sourceMeta?: Record<string, unknown> | null
  /** Optional ISO timestamp of the original capture. */
  capturedAt?: string
  /** Exact verbatim quote that triggered the proposal (empty when no quotable cue). */
  evidenceQuote?: string
  /** Short tags for cues the Proposer noticed. */
  cuesDetected?: string[]
  /** Train-of-thought steps from Proposer. */
  reasoningSteps?: string[]
}

export interface CreatePayload {
  kind: 'create'
  task: MindwtrTaskBlueprint
  traceback: ProposalTraceback
}

/** Field-level diff for modify/move proposals. Each entry is a target-task field replacement. */
export type FieldDiff =
  | { field: 'title'; from: string; to: string }
  | { field: 'description'; from: string; to: string }
  | { field: 'status'; from: string; to: string }
  | { field: 'tags'; from: string[]; to: string[] }
  | { field: 'project'; from: string | null; to: string | null }
  | { field: 'metadata'; from: Record<string, unknown>; to: Record<string, unknown> }

export interface ModifyPayload {
  kind: 'modify'
  taskId: string
  diff: FieldDiff[]
  traceback?: ProposalTraceback
}

export interface DeletePayload {
  kind: 'delete'
  taskId: string
  reason: string
  traceback?: ProposalTraceback
}

export interface MovePayload {
  kind: 'move'
  taskId: string
  toProject: string | null
  fromProject: string | null
  traceback?: ProposalTraceback
}

export interface MergePayload {
  kind: 'merge'
  sourceTaskIds: string[]
  resultTask: MindwtrTaskBlueprint
  traceback?: ProposalTraceback
}

export interface SplitPayload {
  kind: 'split'
  sourceTaskId: string
  resultTasks: MindwtrTaskBlueprint[]
  /** When true, source task is deleted after split. When false, source is modified to first resultTask. */
  deleteSource: boolean
  traceback?: ProposalTraceback
}

export type ProposalPayload =
  | CreatePayload
  | ModifyPayload
  | DeletePayload
  | MovePayload
  | MergePayload
  | SplitPayload

export function payloadKind(payload: unknown): ProposalPayload['kind'] | null {
  if (typeof payload !== 'object' || payload === null) return null
  const k = (payload as { kind?: unknown }).kind
  if (typeof k !== 'string') return null
  if (
    k === 'create' ||
    k === 'modify' ||
    k === 'delete' ||
    k === 'move' ||
    k === 'merge' ||
    k === 'split'
  ) {
    return k
  }
  return null
}
