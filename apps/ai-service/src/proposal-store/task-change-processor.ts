/**
 * TaskChangeProcessor — handles Mindwtr task edit/delete events and turns them
 * into implicit approve/superseded transitions on related pending proposals.
 *
 * Wiring (webhook from Mindwtr cloud, or periodic poll) lives elsewhere; this
 * module is pure logic over an injected event.
 *
 * Rules (see addendum 2026-05-05 §6):
 *
 *   On edit (taskId, newFields):
 *     for each pending proposal whose target_task_ids include taskId:
 *       - kind=modify | move | split  → if newFields match diff `to`-values
 *           ⇒ implicit approved (apply skipped — user already did it)
 *           else ⇒ superseded
 *       - kind=delete                 → superseded (user edited instead of deleting)
 *       - kind=merge                  → superseded (user altered a source mid-merge)
 *       - kind=create                 → ignored (no target)
 *
 *   On delete (taskId):
 *     for each pending proposal whose target_task_ids include taskId:
 *       - kind=delete                 → implicit approved
 *       - kind=modify | move          → superseded
 *       - kind=merge | split          → superseded (a source disappeared)
 *       - kind=create                 → ignored
 */

import type { ProposalStore } from './store'
import type {
  CreatePayload,
  FieldDiff,
  ModifyPayload,
  MovePayload,
  ProposalPayload,
  SplitPayload,
} from './payloads'

/** Subset of task fields the processor compares against. */
export interface TaskFieldsSnapshot {
  title?: string
  description?: string
  status?: string
  tags?: string[]
  projectId?: string | null
}

export type TaskChangeEvent =
  | { kind: 'create'; taskId: string; fields: TaskFieldsSnapshot }
  | { kind: 'edit'; taskId: string; fields: TaskFieldsSnapshot }
  | { kind: 'delete'; taskId: string }

export interface ProcessedOutcome {
  proposalId: string
  /** What we did with this proposal in response to the event. */
  result: 'approved-implicit' | 'superseded' | 'no-op'
  reason?: string
}

export class TaskChangeProcessor {
  constructor(private store: ProposalStore) {}

  /** Process an event. Returns one outcome per affected proposal. */
  process(event: TaskChangeEvent): ProcessedOutcome[] {
    // `create` events don't target existing proposals — they're a signal
    // for the Enricher hook (wired in index.ts) to start a NEW enrichment
    // proposal. Nothing to process here.
    if (event.kind === 'create') return []

    const proposals = this.store.listPending({ targetTaskId: event.taskId })
    const outcomes: ProcessedOutcome[] = []

    for (const p of proposals) {
      const payload = p.currentPayload as ProposalPayload
      // create payloads have no target — guard anyway.
      if (payload.kind === 'create') {
        outcomes.push({ proposalId: p.id, result: 'no-op', reason: 'create has no target' })
        continue
      }

      if (event.kind === 'delete') {
        const result = this.handleDelete(payload)
        this.applyOutcome(p.id, result, { trigger: 'task-deleted' })
        outcomes.push({ proposalId: p.id, result: result.result, reason: result.reason })
        continue
      }

      // event.kind === 'edit'
      const result = this.handleEdit(payload, event.fields)
      this.applyOutcome(p.id, result, { trigger: 'task-edited' })
      outcomes.push({ proposalId: p.id, result: result.result, reason: result.reason })
    }

    return outcomes
  }

  private handleDelete(
    payload: Exclude<ProposalPayload, CreatePayload>
  ): { result: ProcessedOutcome['result']; reason: string } {
    if (payload.kind === 'delete') {
      return { result: 'approved-implicit', reason: 'target deleted as proposal suggested' }
    }
    return { result: 'superseded', reason: `target deleted; proposal kind=${payload.kind}` }
  }

  private handleEdit(
    payload: Exclude<ProposalPayload, CreatePayload>,
    fields: TaskFieldsSnapshot
  ): { result: ProcessedOutcome['result']; reason: string } {
    switch (payload.kind) {
      case 'delete':
        return { result: 'superseded', reason: 'target edited; proposal asked for delete' }
      case 'merge':
        return { result: 'superseded', reason: 'merge source edited mid-flight' }
      case 'modify':
      case 'split':
        return this.compareModifyOrSplit(payload, fields)
      case 'move':
        return this.compareMove(payload, fields)
    }
  }

  private compareModifyOrSplit(
    payload: ModifyPayload | SplitPayload,
    fields: TaskFieldsSnapshot
  ): { result: ProcessedOutcome['result']; reason: string } {
    if (payload.kind === 'modify') {
      const allMatch = payload.diff.every((entry) => editMatchesDiff(entry, fields))
      return allMatch
        ? { result: 'approved-implicit', reason: 'target edited to proposed values' }
        : { result: 'superseded', reason: 'target edited but does not match diff' }
    }
    // split: compare against first resultTask blueprint (the in-place replacement).
    const first = payload.resultTasks[0]
    if (!first) return { result: 'superseded', reason: 'split has empty resultTasks' }
    const matches =
      blueprintFieldEquals(fields.title, first.title) &&
      blueprintFieldEquals(fields.status, first.status) &&
      arrayEquals(fields.tags, first.tags)
    return matches
      ? { result: 'approved-implicit', reason: 'split source edited to first resultTask shape' }
      : { result: 'superseded', reason: 'split source edited differently than proposed' }
  }

  private compareMove(
    payload: MovePayload,
    fields: TaskFieldsSnapshot
  ): { result: ProcessedOutcome['result']; reason: string } {
    if (fields.projectId === undefined) {
      return { result: 'superseded', reason: 'move target edited without project change reported' }
    }
    const newProj = fields.projectId ?? null
    return newProj === payload.toProject
      ? { result: 'approved-implicit', reason: 'target moved to proposed project' }
      : { result: 'superseded', reason: `target moved to ${newProj}, proposed ${payload.toProject}` }
  }

  private applyOutcome(
    proposalId: string,
    out: { result: ProcessedOutcome['result']; reason: string },
    extra: Record<string, unknown>
  ): void {
    if (out.result === 'no-op') return
    if (out.result === 'approved-implicit') {
      this.store.transition(proposalId, 'approved', 'system', {
        implicit: true,
        reason: out.reason,
        ...extra,
      })
      return
    }
    this.store.transition(proposalId, 'superseded', 'system', {
      reason: out.reason,
      ...extra,
    })
  }
}

function editMatchesDiff(entry: FieldDiff, fields: TaskFieldsSnapshot): boolean {
  switch (entry.field) {
    case 'title':
      return fields.title !== undefined && fields.title === entry.to
    case 'description':
      return fields.description !== undefined && fields.description === entry.to
    case 'status':
      return fields.status !== undefined && fields.status === entry.to
    case 'tags':
      return fields.tags !== undefined && arrayEquals(fields.tags, entry.to)
    case 'project':
      return fields.projectId !== undefined && (fields.projectId ?? null) === entry.to
    case 'assignedTo':
      // assignedTo isn't surfaced in the current webhook payload; assume the
      // diff still applies (drift detection happens inside the applier).
      return true
    case 'metadata':
      // Metadata isn't reported in TaskFieldsSnapshot; treat as match (we don't track this).
      return true
  }
}

function blueprintFieldEquals(a: string | undefined, b: string): boolean {
  return a !== undefined && a === b
}

function arrayEquals(a: string[] | undefined, b: string[]): boolean {
  if (a === undefined) return false
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}
