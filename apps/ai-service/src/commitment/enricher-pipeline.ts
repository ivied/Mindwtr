/**
 * Enricher Pipeline — runs the Enricher agent against a freshly-created
 * push-channel inbox task and emits a Proposal (type=modify for single-step,
 * type=split for projects) to the Proposal Store.
 *
 * Push-channel flow (Telegram DM, Slack, Notion):
 *   1. capture/sink creates a Mindwtr inbox task with the raw user text.
 *   2. This pipeline runs the Enricher on that text, optionally grounded by
 *      Context Store retrieval (past user items → consistent contexts/tags).
 *   3. The Enricher's structured output is translated into a Proposal payload:
 *        - is_project=false → ModifyPayload (rewrite title, set status, merge tags)
 *        - is_project=true  → SplitPayload (umbrella project task + sub-actions)
 *      The user reviews and approves in the web UI; ProposalApplier executes.
 *
 * Pull captures (screen/audio) keep using the existing CommitmentPipeline
 * (which gatekeeps via Proposer, then writes a `create` Proposal). Enricher
 * is push-only and assumes actionability — see commitment/enricher.ts.
 */

import type { ContextRetriever } from '../ai/retriever'
import type { GtdCategory } from '../ai/types'
import type { ProposalNotifier } from '../bot/proposal-notifier'
import type {
  FieldDiff,
  MindwtrTaskBlueprint,
  ModifyPayload,
  ProposalTraceback,
  SplitPayload,
} from '../proposal-store/payloads'
import type { ProposalStore } from '../proposal-store/store'
import type { Enricher, EnrichedProposal } from './enricher'

/** Source-agent identifier used in audit / filters. Keep stable. */
export const SOURCE_AGENT_ENRICHER = 'enricher'

export type MindwtrStatus = MindwtrTaskBlueprint['status']

export interface EnricherPipelineConfig {
  /** Minimum confidence to emit a Proposal. Below this, the run is skipped. */
  minConfidence: number
}

export const DEFAULT_ENRICHER_PIPELINE_CONFIG: EnricherPipelineConfig = {
  minConfidence: 0.5,
}

export interface EnricherPipelineDeps {
  enricher: Enricher
  proposalStore: ProposalStore
  retriever: ContextRetriever | null
}

export interface EnrichInput {
  taskId: string
  taskTitle: string
  taskTags: string[]
  /** Raw user text that produced the task. Fed verbatim to the Enricher. */
  text: string
  sourceChannel: string
  sourceMeta?: Record<string, unknown> | null
  /** Context Store row id when available; used for cross-linking in audit. */
  sourceCaptureId?: string | null
}

export type EnrichOutcome =
  | { kind: 'proposed'; proposalId: string; type: 'modify' | 'split' }
  | { kind: 'skipped'; reason: 'noise' | 'low-confidence' | 'no-changes' }

export class EnricherPipeline {
  private notifier: ProposalNotifier | null = null

  constructor(
    private deps: EnricherPipelineDeps,
    private config: EnricherPipelineConfig = DEFAULT_ENRICHER_PIPELINE_CONFIG
  ) {}

  /** Late-binding for the notifier so wiring code can resolve the bot→pipeline→notifier cycle. */
  setNotifier(notifier: ProposalNotifier | null): void {
    this.notifier = notifier
  }

  async run(input: EnrichInput): Promise<EnrichOutcome> {
    let priorContext: string | undefined
    if (this.deps.retriever) {
      try {
        const ctx = await this.deps.retriever.retrieve(input.text)
        if (ctx) priorContext = ctx
      } catch (err) {
        console.error('[enricher-pipeline] retriever failed:', err)
      }
    }

    const proposal = await this.deps.enricher.enrich(input.text, {
      sourceMeta: input.sourceMeta ?? undefined,
      priorContext,
    })

    if (proposal.is_noise) {
      return { kind: 'skipped', reason: 'noise' }
    }
    if (proposal.confidence < this.config.minConfidence) {
      return { kind: 'skipped', reason: 'low-confidence' }
    }

    const traceback = buildTraceback(input, proposal)

    if (proposal.is_project && proposal.sub_actions.length > 0) {
      const payload = buildSplitPayload(input, proposal, traceback)
      const created = this.deps.proposalStore.create({
        type: 'split',
        targetTaskIds: [input.taskId],
        sourceAgent: SOURCE_AGENT_ENRICHER,
        sourceCaptureId: input.sourceCaptureId ?? null,
        payload,
        originSnapshot: { taskId: input.taskId, title: input.taskTitle, tags: input.taskTags },
        summary: proposal.reasoning.slice(0, 160),
      })
      if (this.notifier?.enabled) {
        void this.notifier
          .notifyCreated(created)
          .catch((err) =>
            console.error('[enricher-pipeline] notifier failed:', (err as Error).message)
          )
      }
      return { kind: 'proposed', proposalId: created.id, type: 'split' }
    }

    const diff = buildModifyDiff(input, proposal)
    if (diff.length === 0) {
      return { kind: 'skipped', reason: 'no-changes' }
    }
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: input.taskId,
      diff,
      traceback,
    }
    const created = this.deps.proposalStore.create({
      type: 'modify',
      targetTaskIds: [input.taskId],
      sourceAgent: SOURCE_AGENT_ENRICHER,
      sourceCaptureId: input.sourceCaptureId ?? null,
      payload,
      originSnapshot: { taskId: input.taskId, title: input.taskTitle, tags: input.taskTags },
      summary: proposal.reasoning.slice(0, 160),
    })
    if (this.notifier?.enabled) {
      void this.notifier
        .notifyCreated(created)
        .catch((err) =>
          console.error('[enricher-pipeline] notifier failed:', (err as Error).message)
        )
    }
    return { kind: 'proposed', proposalId: created.id, type: 'modify' }
  }
}

// --- payload builders ---

function buildModifyDiff(input: EnrichInput, p: EnrichedProposal): FieldDiff[] {
  const diff: FieldDiff[] = []

  if (p.proposed_title && p.proposed_title !== input.taskTitle) {
    diff.push({ field: 'title', from: input.taskTitle, to: p.proposed_title })
  }

  const targetStatus = categoryToStatus(p.category)
  if (targetStatus !== 'inbox') {
    diff.push({ field: 'status', from: 'inbox', to: targetStatus })
  }

  const newTags = mergeTags(input.taskTags, p)
  if (!tagsEqual(input.taskTags, newTags)) {
    diff.push({ field: 'tags', from: [...input.taskTags], to: newTags })
  }

  return diff
}

function buildSplitPayload(
  input: EnrichInput,
  p: EnrichedProposal,
  traceback: ProposalTraceback
): SplitPayload {
  const umbrella: MindwtrTaskBlueprint = {
    title: (p.project_name || p.proposed_title).slice(0, 200),
    status: 'inbox',
    tags: mergeTags([], p, ['project']),
    description: buildProjectDescription(p),
    metadata: {
      ai_origin: true,
      ai_confidence: p.confidence,
      ai_is_project: true,
      ai_role: 'project_umbrella',
      ai_specific: p.smart.specific,
      ai_measurable: p.smart.measurable,
      ai_time_bound: p.smart.time_bound,
      source_channel: input.sourceChannel,
      source_capture_id: input.sourceCaptureId ?? null,
    },
  }

  const subTasks: MindwtrTaskBlueprint[] = p.sub_actions.map((sa) => ({
    title: sa.title,
    status: categoryToStatus(sa.suggested_category) === 'inbox'
      ? 'next'
      : categoryToStatus(sa.suggested_category),
    tags: mergeTags([], { ...p, category: sa.suggested_category }),
    description: '',
    metadata: {
      ai_origin: true,
      ai_role: 'next_action',
      ai_parent_project_hint: p.project_name,
      source_channel: input.sourceChannel,
    },
  }))

  return {
    kind: 'split',
    sourceTaskId: input.taskId,
    resultTasks: [umbrella, ...subTasks],
    deleteSource: true,
    traceback,
  }
}

function buildTraceback(input: EnrichInput, p: EnrichedProposal): ProposalTraceback {
  const reasoningSteps: string[] = [
    `Title: ${p.proposed_title}`,
    `Category: ${p.category}${p.is_project ? ' → project' : ''}`,
    `SMART specific: ${p.smart.specific}`,
    `SMART time_bound: ${p.smart.time_bound}`,
    `SMART measurable: ${p.smart.measurable}`,
  ].filter((s) => s.length > 0)
  if (p.reasoning) reasoningSteps.push(p.reasoning)

  return {
    captureExcerpt: input.text.slice(0, 500),
    sourceChannel: input.sourceChannel,
    sourceMeta: input.sourceMeta ?? null,
    reasoningSteps,
  }
}

function buildProjectDescription(p: EnrichedProposal): string {
  const lines: string[] = []
  if (p.smart.specific) lines.push(`Outcome: ${p.smart.specific}`)
  if (p.smart.measurable && p.smart.measurable !== p.smart.specific) {
    lines.push(`Done when: ${p.smart.measurable}`)
  }
  if (p.smart.time_bound && p.smart.time_bound !== 'no deadline') {
    lines.push(`By: ${p.smart.time_bound}`)
  }
  return lines.join('\n')
}

// --- helpers ---

function categoryToStatus(cat: GtdCategory): MindwtrStatus {
  switch (cat) {
    case 'two_minute':
    case 'next':
      return 'next'
    case 'waiting':
      return 'waiting'
    case 'someday':
      return 'someday'
    case 'reference':
      return 'reference'
  }
}

function mergeTags(
  current: string[],
  p: EnrichedProposal,
  extra: string[] = []
): string[] {
  const set = new Set<string>(current)
  for (const c of p.suggested_contexts) set.add(c)
  for (const t of p.suggested_tags) set.add(t)
  if (p.category === 'two_minute') set.add('2min')
  if (p.is_delegation) set.add('delegated')
  for (const e of extra) set.add(e)
  return [...set]
}

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort().join('|')
  const sb = [...b].sort().join('|')
  return sa === sb
}
