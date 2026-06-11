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
import type { ProceduralContextProvider } from '../memory/procedural/proposer-block'
import type { Enricher, EnrichedProposal } from './enricher'
import type { ProceduralFeedbackSink } from './pipeline'
import { LlmPublisher } from '../status/llm-publisher'
import { pickRoutingTargetTag } from '../threads/registry'

/** Source-agent identifier used in audit / filters. Keep stable. */
export const SOURCE_AGENT_ENRICHER = 'enricher'

export type MindwtrStatus = MindwtrTaskBlueprint['status']

export interface EnricherPipelineConfig {
  /** Minimum confidence to emit a Proposal. Below this, the run is skipped. */
  minConfidence: number
}

export const DEFAULT_ENRICHER_PIPELINE_CONFIG: EnricherPipelineConfig = {
  // Push captures are explicit user inputs, so we want to surface a suggestion
  // even when the wording is short or ambiguous. Was 0.5; raised the user's
  // false-negative count too high ("Geo для Лео" got silently dropped).
  minConfidence: 0.3,
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
  /** Current task description, if any. The Enricher only fills a generated
   *  description when this is empty — never clobbers user-written content. */
  taskDescription?: string
  /** Current task status. Used as the `from` side of the status diff so
   *  re-enrichment of a non-inbox task doesn't claim it came from inbox.
   *  Defaults to 'inbox' (the original create-time enrichment path). */
  taskStatus?: string
  /** Raw user text that produced the task. Fed verbatim to the Enricher. */
  text: string
  /** Fresh capture about an EXISTING task (re-enrichment). Rendered as a
   *  NEW_EVIDENCE block so the Enricher updates rather than re-derives. */
  newEvidence?: string
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
  private llmPublisher: LlmPublisher | null = null
  private proceduralContextProvider: ProceduralContextProvider | null = null
  private proceduralFeedback: ProceduralFeedbackSink | null = null

  constructor(
    private deps: EnricherPipelineDeps,
    private config: EnricherPipelineConfig = DEFAULT_ENRICHER_PIPELINE_CONFIG
  ) {}

  /** Late-binding for the notifier so wiring code can resolve the bot→pipeline→notifier cycle. */
  setNotifier(notifier: ProposalNotifier | null): void {
    this.notifier = notifier
  }

  setLlmPublisher(publisher: LlmPublisher | null): void {
    this.llmPublisher = publisher
  }

  /** Optional: playbook excerpts from procedural memory surface to the
   *  Enricher as a KNOWN_PLAYBOOK block (rules, recorded procedures). */
  setProceduralContextProvider(provider: ProceduralContextProvider | null): void {
    this.proceduralContextProvider = provider
  }

  /** Optional (FR89): record which playbook chunks fed each proposal so
   *  approve/reject can adjust their reliability_score. */
  setProceduralFeedback(sink: ProceduralFeedbackSink | null): void {
    this.proceduralFeedback = sink
  }

  async run(input: EnrichInput): Promise<EnrichOutcome> {
    // Build the LLM input context from two complementary signals:
    //   1) semantic past-similar items (vec/FTS over a 7-day window)
    //   2) cross-channel temporal window around now (audio + screen + TG
    //      captures within ±5 min) — catches "the meeting I was just talking
    //      about" cases where the trigger text alone is too short to vec-match.
    const contextBlocks: string[] = []
    if (this.deps.retriever) {
      try {
        const semantic = await this.deps.retriever.retrieve(input.text)
        if (semantic) contextBlocks.push(semantic)
      } catch (err) {
        console.error('[enricher-pipeline] retriever failed:', err)
      }
      try {
        const temporal = this.deps.retriever.temporalContext(new Date().toISOString(), {
          excludeId: input.sourceCaptureId ?? undefined,
        })
        if (temporal) contextBlocks.push(temporal)
      } catch (err) {
        console.error('[enricher-pipeline] temporal-context failed:', err)
      }
    }
    const priorContext = contextBlocks.length > 0 ? contextBlocks.join('\n\n') : undefined

    // Playbook excerpts (recorded procedures, channel rules, do-not rules)
    // from procedural memory. Fail-open: no playbook block on error.
    let playbookContext: string | undefined
    let playbookRefs: string[] = []
    if (this.proceduralContextProvider) {
      try {
        const pb = await this.proceduralContextProvider.getPlaybookContext(input.text)
        if (pb) {
          playbookContext = pb.text
          playbookRefs = pb.refs
        }
      } catch (err) {
        console.error('[enricher-pipeline] playbook context failed:', (err as Error).message)
      }
    }

    const proposal = await this.deps.enricher.enrich(input.text, {
      sourceMeta: input.sourceMeta ?? undefined,
      priorContext,
      newEvidence: input.newEvidence,
      playbookContext,
    })

    if (proposal.is_noise) {
      console.log(
        `[enricher] skip noise (task ${input.taskId.slice(0, 8)}): "${input.taskTitle.slice(0, 60)}" reason="${proposal.noise_reason || proposal.reasoning.slice(0, 80)}"`
      )
      return { kind: 'skipped', reason: 'noise' }
    }
    if (proposal.confidence < this.config.minConfidence) {
      console.log(
        `[enricher] skip low-conf ${proposal.confidence.toFixed(2)} (task ${input.taskId.slice(0, 8)}): "${input.taskTitle.slice(0, 60)}"`
      )
      return { kind: 'skipped', reason: 'low-confidence' }
    }

    const traceback = buildTraceback(input, proposal)

    if (proposal.is_project && proposal.sub_actions.length > 0) {
      const payload = buildSplitPayload(input, proposal, traceback)
      const { proposalId, revised } = this.persist(
        input,
        'split',
        payload,
        proposal.reasoning,
        playbookRefs
      )
      console.log(
        `[enricher] ${revised ? 'revised' : 'proposed'} split (task ${input.taskId.slice(0, 8)} → proposal ${proposalId.slice(0, 8)}): "${proposal.proposed_title.slice(0, 60)}" sub_actions=${proposal.sub_actions.length}`
      )
      this.llmPublisher?.record({
        channel: 'enricher',
        kind: 'enriched-split',
        title: proposal.proposed_title,
        confidence: proposal.confidence,
        category: proposal.category,
        reasoning: proposal.reasoning,
      })
      return { kind: 'proposed', proposalId, type: 'split' }
    }

    const diff = buildModifyDiff(input, proposal)
    if (diff.length === 0) {
      console.log(
        `[enricher] skip no-changes (task ${input.taskId.slice(0, 8)}): "${input.taskTitle.slice(0, 60)}" already matches enrichment`
      )
      this.llmPublisher?.record({
        channel: 'enricher',
        kind: 'enriched-noop',
        title: input.taskTitle,
        reasoning: 'already matches enrichment',
      })
      return { kind: 'skipped', reason: 'no-changes' }
    }
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: input.taskId,
      diff,
      traceback,
    }
    const { proposalId, revised } = this.persist(
      input,
      'modify',
      payload,
      proposal.reasoning,
      playbookRefs
    )
    console.log(
      `[enricher] ${revised ? 'revised' : 'proposed'} modify (task ${input.taskId.slice(0, 8)} → proposal ${proposalId.slice(0, 8)}): "${proposal.proposed_title.slice(0, 60)}" diff=[${diff.map((d) => d.field).join(',')}] conf=${proposal.confidence.toFixed(2)}`
    )
    this.llmPublisher?.record({
      channel: 'enricher',
      kind: 'enriched-modify',
      title: proposal.proposed_title,
      confidence: proposal.confidence,
      category: proposal.category,
      reasoning: proposal.reasoning,
      diff: diff.map((d) => d.field).join(','),
    })
    return { kind: 'proposed', proposalId, type: 'modify' }
  }

  /**
   * Persist an enrichment result, superseding rather than duplicating any
   * pending Enricher proposal already targeting the task (re-enrichment on
   * new evidence, double-fired webhooks):
   *   - pending proposal of the SAME type → addVersion (the card shows v2+,
   *     thread and history preserved);
   *   - pending proposal of a DIFFERENT type → transition to 'superseded'
   *     and create a fresh proposal.
   * TG notification fires only for fresh proposals — revisions stay quiet.
   */
  private persist(
    input: EnrichInput,
    type: 'modify' | 'split',
    payload: ModifyPayload | SplitPayload,
    reasoning: string,
    playbookRefs: string[] = []
  ): { proposalId: string; revised: boolean } {
    const summary = reasoning.slice(0, 160)
    const pending = this.deps.proposalStore.listPending({
      sourceAgent: SOURCE_AGENT_ENRICHER,
      targetTaskId: input.taskId,
      limit: 10,
    })

    const sameType = pending.find((p) => p.type === type)
    for (const p of pending) {
      if (sameType && p.id === sameType.id) continue
      try {
        this.deps.proposalStore.transition(p.id, 'superseded', 'agent', {
          reason: 're-enrichment produced a new proposal',
          replacedByType: type,
        })
      } catch (err) {
        console.error(
          `[enricher-pipeline] supersede ${p.id.slice(0, 8)} failed:`,
          (err as Error).message
        )
      }
    }

    if (sameType) {
      this.deps.proposalStore.addVersion({
        proposalId: sameType.id,
        payload,
        author: 'agent',
        summary: input.newEvidence ? `re-enriched on new evidence: ${summary}` : summary,
      })
      this.recordPlaybookRefs(sameType.id, playbookRefs)
      return { proposalId: sameType.id, revised: true }
    }

    const created = this.deps.proposalStore.create({
      type,
      targetTaskIds: [input.taskId],
      sourceAgent: SOURCE_AGENT_ENRICHER,
      sourceCaptureId: input.sourceCaptureId ?? null,
      payload,
      originSnapshot: { taskId: input.taskId, title: input.taskTitle, tags: input.taskTags },
      summary,
    })
    if (this.notifier?.enabled) {
      void this.notifier
        .notifyCreated(created)
        .catch((err) =>
          console.error('[enricher-pipeline] notifier failed:', (err as Error).message)
        )
    }
    this.recordPlaybookRefs(created.id, playbookRefs)
    return { proposalId: created.id, revised: false }
  }

  private recordPlaybookRefs(proposalId: string, refs: string[]): void {
    if (!this.proceduralFeedback || refs.length === 0) return
    try {
      this.proceduralFeedback.recordProposalRefs(proposalId, refs)
    } catch (err) {
      console.error('[enricher-pipeline] playbook refs record failed:', (err as Error).message)
    }
  }
}

// --- payload builders ---

/**
 * Synthetic assignee for tasks the Enricher decided the agent can handle.
 * Lives in Mindwtr's existing `assignedTo` field — orthogonal to status, so
 * the agent's stages (queued/doing/review/done) ride on the global status
 * enum while `assignedTo` answers "who".
 */
export const AI_AGENT_ASSIGNEE = '@ai-agent'

function buildModifyDiff(input: EnrichInput, p: EnrichedProposal): FieldDiff[] {
  const diff: FieldDiff[] = []

  if (p.proposed_title && p.proposed_title !== input.taskTitle) {
    diff.push({ field: 'title', from: input.taskTitle, to: p.proposed_title })
  }

  // Fill a generated description only when the task has none — never
  // overwrite content the user wrote themselves.
  const currentDesc = (input.taskDescription ?? '').trim()
  if (p.proposed_description && currentDesc.length === 0) {
    diff.push({
      field: 'description',
      from: input.taskDescription ?? '',
      to: p.proposed_description,
    })
  }

  const currentStatus = input.taskStatus ?? 'inbox'
  const targetStatus = categoryToStatus(p.category)
  if (targetStatus !== currentStatus) {
    diff.push({ field: 'status', from: currentStatus, to: targetStatus })
  }

  // AI routing: when the Enricher decided this task fits a generalist agent
  // (code / research / draft / etc.), propose handing it off via assignedTo.
  // Tag with `ai-type:<kind>` and `ai-stage:queued` so the agent lane view
  // can read both shape and pipeline position. The routing entry stays
  // partial-approve-friendly: user can uncheck it to keep the task while
  // accepting the rest of the diff.
  let routingTagAdditions: string[] | null = null
  if (p.is_ai_routable) {
    diff.push({ field: 'assignedTo', from: null, to: AI_AGENT_ASSIGNEE })
    // Pre-fill WHERE it runs (Mac thread vs OpenClaw). Shown in the card chip;
    // the user can override. A wrong guess is one tap to fix, so this stays a
    // best-effort keyword match rather than a model call.
    const targetTag = pickRoutingTargetTag(
      p.proposed_title || input.taskTitle,
      p.proposed_description ?? input.taskDescription,
      input.taskTags
    )
    routingTagAdditions = [`ai-type:${p.ai_task_type}`, 'ai-stage:queued', targetTag]
  }

  const newTags = mergeTags(input.taskTags, p, routingTagAdditions ?? [])
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
    p.is_ai_routable
      ? `AI routing: ${p.ai_task_type} — ${p.ai_routing_reasoning}`
      : '',
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
