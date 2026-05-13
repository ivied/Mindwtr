/**
 * Proposal Apply — executes a Proposal payload against Mindwtr Cloud.
 *
 * Pure side-effect engine: takes a Proposal, calls the relevant Mindwtr REST
 * endpoints, and writes audit rows. State transitions (`approved`, `stale`)
 * are handled by the caller (REST endpoint), with one exception: when drift
 * is detected, this module flips the proposal to `stale` itself — drift is a
 * fact discovered during apply, not a user decision, so it belongs here.
 *
 * For multi-target operations (merge/split), Mindwtr REST has no transaction
 * primitive. We do best-effort: execute steps sequentially and audit any
 * partial failure with details so the caller (or operator) can recover.
 */

import type { MindwtrClient, Task } from '../api/mindwtr-client'
import type { ProposalStore } from './store'
import type {
  CreatePayload,
  DeletePayload,
  FieldDiff,
  MergePayload,
  ModifyPayload,
  MovePayload,
  ProposalPayload,
  SplitPayload,
} from './payloads'
import type { ProposalRecord } from './types'

export type ApplyResult =
  | {
      ok: true
      appliedTaskIds: string[]
      /** Set when applySplit (or future ops) created a real Project. */
      projectId?: string
      projectTitle?: string
    }
  | { ok: false; reason: 'stale'; details: string }
  | { ok: false; reason: 'mindwtr_error' | 'invalid_payload' | 'not_pending'; details: string }

interface ExecutionResult {
  taskIds: string[]
  project?: { id: string; title: string }
}

interface TaskSnapshot {
  id: string
  title?: string
  description?: string
  status?: string
  tags?: string[]
  projectId?: string | null
  assignedTo?: string | null
}

/**
 * Optional hook fired after a `create` proposal has successfully created a
 * new Mindwtr task. Used by index.ts to kick off the Enricher pipeline so
 * the freshly-created task gets a follow-up modify proposal (status/tags/
 * SMART). Late-binding via setter so we don't introduce a circular dep
 * between proposal-store and commitment/enricher-pipeline.
 */
export type PostCreateHook = (taskId: string, proposal: ProposalRecord) => void

export class ProposalApplier {
  private postCreateHook: PostCreateHook | null = null

  constructor(
    private store: ProposalStore,
    private mindwtr: MindwtrClient
  ) {}

  /** Late-bind a hook to run after every successful `create` apply. */
  setPostCreateHook(hook: PostCreateHook | null): void {
    this.postCreateHook = hook
  }

  async apply(proposalId: string): Promise<ApplyResult> {
    const proposal = this.store.get(proposalId)
    if (!proposal) {
      return { ok: false, reason: 'mindwtr_error', details: `Proposal ${proposalId} not found` }
    }
    if (proposal.status !== 'pending') {
      return {
        ok: false,
        reason: 'not_pending',
        details: `Proposal is in status ${proposal.status}, cannot apply`,
      }
    }

    const payload = proposal.currentPayload as ProposalPayload
    if (!payload || typeof payload !== 'object' || !('kind' in payload)) {
      return { ok: false, reason: 'invalid_payload', details: 'Payload missing kind field' }
    }

    // Drift detection — only meaningful for ops with target tasks.
    if (payload.kind !== 'create') {
      const drift = await this.detectDrift(proposal, payload)
      if (drift) {
        this.store.transition(proposalId, 'stale', 'system', { drift })
        return { ok: false, reason: 'stale', details: drift }
      }
    }

    try {
      const result = await this.execute(payload)
      this.store.audit({
        proposalId,
        event: 'applied',
        actor: 'system',
        meta: {
          appliedTaskIds: result.taskIds,
          ...(result.project ? { projectId: result.project.id, projectTitle: result.project.title } : {}),
        },
      })
      // For pull captures (Proposer-originated `create` proposals) we want a
      // second-stage enrichment pass once the task is alive in Mindwtr: hand
      // the new taskId off so the Enricher can produce a modify proposal
      // (status/tags/SMART/sub-actions). Hook is optional and fire-and-forget;
      // failures inside it are the hook's responsibility, not ours.
      if (payload.kind === 'create' && this.postCreateHook && result.taskIds.length > 0) {
        try {
          this.postCreateHook(result.taskIds[0]!, proposal)
        } catch (err) {
          console.error('[applier] post-create hook threw:', (err as Error).message)
        }
      }
      return {
        ok: true,
        appliedTaskIds: result.taskIds,
        ...(result.project ? { projectId: result.project.id, projectTitle: result.project.title } : {}),
      }
    } catch (err) {
      const details = (err as Error).message
      this.store.audit({
        proposalId,
        event: 'apply_failed',
        actor: 'system',
        meta: { error: details },
      })
      return { ok: false, reason: 'mindwtr_error', details }
    }
  }

  // --- per-type execution ---

  private async execute(payload: ProposalPayload): Promise<ExecutionResult> {
    switch (payload.kind) {
      case 'create':
        return { taskIds: [await this.applyCreate(payload)] }
      case 'modify':
        return { taskIds: [await this.applyModify(payload)] }
      case 'delete':
        return { taskIds: [await this.applyDelete(payload)] }
      case 'move':
        return { taskIds: [await this.applyMove(payload)] }
      case 'merge':
        return { taskIds: await this.applyMerge(payload) }
      case 'split':
        return this.applySplit(payload)
    }
  }

  private async applyCreate(p: CreatePayload): Promise<string> {
    const task = await this.mindwtr.createTask({
      title: p.task.title,
      status: p.task.status,
      tags: p.task.tags,
      description: p.task.description,
      ...(p.task.assignedTo ? { assignedTo: p.task.assignedTo } : {}),
      metadata: p.task.metadata,
    })
    return task.id
  }

  private async applyModify(p: ModifyPayload): Promise<string> {
    const updates = diffToUpdates(p.diff)
    await this.mindwtr.updateTask(p.taskId, updates)
    return p.taskId
  }

  private async applyDelete(p: DeletePayload): Promise<string> {
    await this.mindwtr.deleteTask(p.taskId)
    return p.taskId
  }

  private async applyMove(p: MovePayload): Promise<string> {
    await this.mindwtr.updateTask(p.taskId, { projectId: p.toProject ?? undefined })
    return p.taskId
  }

  private async applyMerge(p: MergePayload): Promise<string[]> {
    // Best-effort sequence: create result first, then delete sources. If a
    // delete fails the result task still exists; partial state is audited via
    // the surrounding apply() catch.
    const created = await this.mindwtr.createTask({
      title: p.resultTask.title,
      status: p.resultTask.status,
      tags: p.resultTask.tags,
      description: p.resultTask.description,
      metadata: p.resultTask.metadata,
    })
    for (const sourceId of p.sourceTaskIds) {
      await this.mindwtr.deleteTask(sourceId)
    }
    return [created.id]
  }

  private async applySplit(p: SplitPayload): Promise<ExecutionResult> {
    // The Enricher produces split payloads when is_project=true: first
    // resultTask is the umbrella (becomes a real Mindwtr Project), the rest
    // are next-actions that get linked to the project via projectId. So the
    // user sees a navigable project with real children, not flat siblings
    // with a "project" tag.
    const [umbrella, ...subActions] = p.resultTasks
    if (!umbrella) {
      throw new Error('split payload has empty resultTasks')
    }

    const project = await this.mindwtr.createProject({
      title: umbrella.title,
      color: '#7c3aed',
      ...(umbrella.description ? { supportNotes: umbrella.description } : {}),
    })

    const taskIds: string[] = []
    for (const blueprint of subActions) {
      const t = await this.mindwtr.createTask({
        title: blueprint.title,
        status: blueprint.status,
        tags: blueprint.tags,
        description: blueprint.description,
        metadata: blueprint.metadata,
        projectId: project.id,
      })
      taskIds.push(t.id)
    }

    if (p.deleteSource) {
      await this.mindwtr.deleteTask(p.sourceTaskId)
    } else {
      // Source stays: link it to the new project so it isn't orphaned.
      await this.mindwtr.updateTask(p.sourceTaskId, { projectId: project.id })
      taskIds.unshift(p.sourceTaskId)
    }

    return {
      taskIds,
      project: { id: project.id, title: project.title },
    }
  }

  // --- drift detection ---

  /**
   * Returns a human-readable drift description string when the current state
   * of target tasks diverges from origin_snapshot in a way that affects the
   * proposed change. Returns null when no drift.
   *
   * For modify: every diff entry must have `from` matching current value.
   * For delete: the task must still exist; missing-task is treated as already-done
   *   (no drift, apply will no-op).
   * For move: the current projectId must match the snapshot fromProject.
   * For merge/split: every referenced source task must exist; further field
   *   comparison is skipped on v1.
   */
  private async detectDrift(
    proposal: ProposalRecord,
    payload: Exclude<ProposalPayload, CreatePayload>
  ): Promise<string | null> {
    switch (payload.kind) {
      case 'modify':
        return this.driftForModify(payload)
      case 'move':
        return this.driftForMove(payload)
      case 'delete':
        return null // Missing task is fine; existence is irrelevant for delete intent.
      case 'merge':
        return this.driftForMerge(payload)
      case 'split':
        return this.driftForSplit(payload)
    }
  }

  private async driftForModify(p: ModifyPayload): Promise<string | null> {
    let task: Task
    try {
      task = await this.mindwtr.getTask(p.taskId)
    } catch (err) {
      return `target task ${p.taskId} fetch failed: ${(err as Error).message}`
    }
    return diffMismatch(p.diff, snapshotFromTask(task))
  }

  private async driftForMove(p: MovePayload): Promise<string | null> {
    let task: Task
    try {
      task = await this.mindwtr.getTask(p.taskId)
    } catch (err) {
      return `target task ${p.taskId} fetch failed: ${(err as Error).message}`
    }
    const currentProject = task.projectId ?? null
    if (currentProject !== p.fromProject) {
      return `task ${p.taskId} projectId is ${currentProject}, expected ${p.fromProject}`
    }
    return null
  }

  private async driftForMerge(p: MergePayload): Promise<string | null> {
    for (const id of p.sourceTaskIds) {
      try {
        await this.mindwtr.getTask(id)
      } catch (err) {
        return `merge source ${id} not found: ${(err as Error).message}`
      }
    }
    return null
  }

  private async driftForSplit(p: SplitPayload): Promise<string | null> {
    try {
      await this.mindwtr.getTask(p.sourceTaskId)
    } catch (err) {
      return `split source ${p.sourceTaskId} not found: ${(err as Error).message}`
    }
    return null
  }
}

function diffToUpdates(diff: FieldDiff[]): {
  title?: string
  description?: string
  status?: string
  tags?: string[]
  projectId?: string
  assignedTo?: string
  metadata?: Record<string, unknown>
} {
  const updates: ReturnType<typeof diffToUpdates> = {}
  for (const entry of diff) {
    switch (entry.field) {
      case 'title':
        updates.title = entry.to
        break
      case 'description':
        updates.description = entry.to
        break
      case 'status':
        updates.status = entry.to
        break
      case 'tags':
        updates.tags = entry.to
        break
      case 'project':
        updates.projectId = entry.to ?? undefined
        break
      case 'assignedTo':
        updates.assignedTo = entry.to ?? undefined
        break
      case 'metadata':
        updates.metadata = entry.to
        break
    }
  }
  return updates
}

function snapshotFromTask(task: Task): TaskSnapshot {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    tags: task.tags,
    projectId: task.projectId ?? null,
    assignedTo: (task as { assignedTo?: string | null }).assignedTo ?? null,
  }
}

function diffMismatch(diff: FieldDiff[], current: TaskSnapshot): string | null {
  for (const entry of diff) {
    switch (entry.field) {
      case 'title':
        if ((current.title ?? '') !== entry.from) {
          return `title drift: current="${current.title ?? ''}", snapshot="${entry.from}"`
        }
        break
      case 'description':
        if ((current.description ?? '') !== entry.from) {
          return `description drift on task ${current.id}`
        }
        break
      case 'status':
        if ((current.status ?? '') !== entry.from) {
          return `status drift: current=${current.status}, snapshot=${entry.from}`
        }
        break
      case 'tags': {
        const cur = JSON.stringify([...(current.tags ?? [])].sort())
        const snap = JSON.stringify([...entry.from].sort())
        if (cur !== snap) return `tags drift on task ${current.id}`
        break
      }
      case 'project': {
        const cur = current.projectId ?? null
        if (cur !== entry.from) {
          return `project drift: current=${cur}, snapshot=${entry.from}`
        }
        break
      }
      case 'assignedTo': {
        const cur = current.assignedTo ?? null
        if (cur !== entry.from) {
          return `assignedTo drift: current=${cur}, snapshot=${entry.from}`
        }
        break
      }
      case 'metadata': {
        // Metadata drift is too noisy to compare deeply on v1; skip.
        break
      }
    }
  }
  return null
}
