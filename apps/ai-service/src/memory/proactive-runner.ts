/**
 * ProactiveRunner — periodic memory-driven proposal pass.
 *
 * Reactive Proposer (commitment-detector) only fires when a capture
 * arrives. That misses the case where the user is *waiting* on something
 * and nothing new comes in — Joe hasn't replied for 3 days, Polina's
 * invoice deadline is tomorrow, etc. The proactive runner closes that
 * gap by scanning active facts on a schedule and surfacing follow-up
 * proposals through the same Proposal Store the rest of the system uses.
 *
 * Hard rules (so this doesn't become inbox spam):
 *   1. Source-agent = 'proactive-runner' — distinct from commitment-detector
 *      and enricher, so the UI / audit log can filter / weight differently.
 *   2. Conservative confidence threshold (default 0.75).
 *   3. Hard cap on proposals per pass (default 5).
 *   4. Per-entity dedup window (default 24h) — don't re-propose for the
 *      same entity until enough time has passed for the user to act.
 *   5. Skip if a recent (≤dedupWindow) proposal with overlapping intent
 *      already exists in the proposal store, regardless of source-agent.
 *
 * Cost: one LLM call per eligible group + one ranking scan over facts.
 * On a quiet day, zero LLM calls (no stale facts → no work).
 */

import { randomUUID } from 'node:crypto'
import type { LLMClient } from '../ai/client'
import type { MindwtrClient, Task } from '../api/mindwtr-client'
import type {
  CreatePayload,
  FieldDiff,
  MindwtrTaskBlueprint,
  ModifyPayload,
  ProposalTraceback,
} from '../proposal-store/payloads'
import type { ProposalStore } from '../proposal-store/store'
import type { HybridRetriever } from './retrieve'
import type { MemoryStore } from './store'
import type { Fact } from './types'
import {
  DEFAULT_PROACTIVE_CONFIG,
  PROACTIVE_SOURCE_AGENT,
  type CompletionEvaluation,
  type OpenTaskDecision,
  type ProactiveCombinedResult,
  type ProactiveConfig,
  type ProactiveDecision,
  type ProactiveEvaluation,
  type ProactiveRunResult,
  type ReversePassResult,
  type StaleFactGroup,
  type TaskVerdict,
} from './proactive-types'

export interface ProactiveRunnerOptions {
  memoryStore: MemoryStore
  proposalStore: ProposalStore
  llm: LLMClient
  /** When set, enables the reverse pass (open tasks → completion verdict). */
  mindwtrClient?: MindwtrClient | null
  /** Needed for reverse pass entity-matching via task title. */
  retriever?: HybridRetriever | null
  /** Defaults DEFAULT_PROACTIVE_CONFIG; overrides merge field-by-field. */
  config?: Partial<ProactiveConfig>
  /** Override wall clock for tests. */
  now?: () => Date
  /** Log sink; defaults to console.log. */
  log?: (msg: string) => void
}

export class ProactiveRunner {
  private readonly config: ProactiveConfig
  private readonly now: () => Date
  private readonly log: (msg: string) => void

  constructor(private readonly opts: ProactiveRunnerOptions) {
    this.config = { ...DEFAULT_PROACTIVE_CONFIG, ...(opts.config ?? {}) }
    this.now = opts.now ?? (() => new Date())
    this.log = opts.log ?? console.log
  }

  /**
   * Entry point — runs both forward (stale facts → follow-up proposals) and
   * reverse (open tasks → completion verdicts) passes. Reverse pass is
   * skipped silently when MindwtrClient or HybridRetriever wasn't provided.
   */
  async run(): Promise<ProactiveCombinedResult> {
    const forward = await this.runStaleFactsPass()
    const reverse =
      this.opts.mindwtrClient && this.opts.retriever
        ? await this.runOpenTasksPass()
        : null
    return { forward, reverse }
  }

  // Backwards-compat alias so existing callers (e.g. setInterval wired
  // before the reverse pass shipped) keep working with the forward-only
  // result they were expecting.
  async runForwardOnly(): Promise<ProactiveRunResult> {
    return this.runStaleFactsPass()
  }

  async runStaleFactsPass(): Promise<ProactiveRunResult> {
    const startedAt = Date.now()
    const decisions: ProactiveDecision[] = []
    let proposed = 0
    let skipped = 0
    let errors = 0

    const groups = this.findStaleFactGroups()
    this.log(`[proactive] scanning ${groups.length} stale fact groups`)

    // Pre-load recent proactive proposals for dedup-window filtering.
    const recentProactive = this.opts.proposalStore.listRecentByAgent(
      PROACTIVE_SOURCE_AGENT,
      this.config.dedupWindowMs
    )
    const recentSlugs = new Set(
      recentProactive.flatMap((p) => extractEntitySlugFromProposal(p))
    )

    for (const group of groups) {
      if (proposed >= this.config.maxProposalsPerPass) {
        decisions.push({
          entitySlug: group.entitySlug,
          action: 'skipped-budget',
          reason: `exceeded maxProposalsPerPass=${this.config.maxProposalsPerPass}`,
        })
        skipped += 1
        continue
      }

      if (recentSlugs.has(group.entitySlug)) {
        decisions.push({
          entitySlug: group.entitySlug,
          action: 'skipped-recent-proposal',
          reason: `recent proactive proposal within ${Math.round(this.config.dedupWindowMs / 3600_000)}h`,
        })
        skipped += 1
        continue
      }

      try {
        const evaluation = await this.evaluateGroup(group)

        if (!evaluation.should_propose) {
          decisions.push({
            entitySlug: group.entitySlug,
            action: 'skipped-llm-no',
            reason: evaluation.reasoning || 'LLM said no',
            evaluation,
          })
          skipped += 1
          continue
        }
        if (evaluation.confidence < this.config.minConfidence) {
          decisions.push({
            entitySlug: group.entitySlug,
            action: 'skipped-low-confidence',
            reason: `confidence ${evaluation.confidence.toFixed(2)} < ${this.config.minConfidence}`,
            evaluation,
          })
          skipped += 1
          continue
        }

        const proposalId = await this.writeProposal(group, evaluation)
        proposed += 1
        recentSlugs.add(group.entitySlug)
        decisions.push({
          entitySlug: group.entitySlug,
          action: 'proposed',
          proposalId,
          reason: evaluation.action_title,
          evaluation,
        })
      } catch (err) {
        errors += 1
        this.log(`[proactive] evaluate/write failed for ${group.entitySlug}: ${(err as Error).message}`)
        decisions.push({
          entitySlug: group.entitySlug,
          action: 'error',
          reason: (err as Error).message,
        })
      }
    }

    const elapsedMs = Date.now() - startedAt
    this.log(
      `[proactive] done: ${proposed} proposed, ${skipped} skipped, ${errors} errors in ${elapsedMs}ms`
    )
    return { scannedGroups: groups.length, proposed, skipped, errors, elapsedMs, decisions }
  }

  // ---------------- group selection ----------------

  findStaleFactGroups(): StaleFactGroup[] {
    const nowMs = this.now().getTime()
    const facts = this.opts.memoryStore.allActiveFacts(1000)

    const byEntity = new Map<string, Fact[]>()
    for (const f of facts) {
      if (!f.entitySlug) continue
      if (f.factType && !this.config.factTypesToScan.includes(f.factType)) continue
      if (!byEntity.has(f.entitySlug)) byEntity.set(f.entitySlug, [])
      byEntity.get(f.entitySlug)!.push(f)
    }

    const groups: StaleFactGroup[] = []
    for (const [slug, list] of byEntity) {
      // Sort newest-first by valid_from.
      list.sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))
      const lastTs = list[0]!.validFrom
      const lastMs = Date.parse(lastTs)
      const staleSinceMs = Number.isFinite(lastMs) ? nowMs - lastMs : 0
      if (staleSinceMs < this.config.staleAfterMs) continue
      groups.push({ entitySlug: slug, facts: list, lastFactTs: lastTs, staleSinceMs })
    }

    // Older first — runner prioritizes longer-stale stuff (more likely to
    // matter), maxProposalsPerPass cap then keeps it bounded.
    groups.sort((a, b) => b.staleSinceMs - a.staleSinceMs)
    return groups
  }

  // ---------------- LLM evaluation ----------------

  async evaluateGroup(group: StaleFactGroup): Promise<ProactiveEvaluation> {
    const recentEvents = await this.fetchRecentEventsForEntity(group.entitySlug)
    const prompt = buildPrompt(group, recentEvents, this.now())

    const res = await this.opts.llm.chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.2,
    })
    const raw = res.choices[0]?.message?.content ?? ''
    return parseProactiveOutput(raw)
  }

  private async fetchRecentEventsForEntity(
    slug: string
  ): Promise<Array<{ ts: string; app: string | null; title: string | null; body: string }>> {
    const sinceIso = new Date(
      this.now().getTime() - this.config.recentEventsWithinDays * 86_400_000
    ).toISOString()
    const rows = this.opts.memoryStore.db
      .query<
        { ts: string; app: string | null; title: string | null; body: string },
        [string, string, number]
      >(
        `SELECT e.ts, e.app, e.title, substr(e.body, 1, 400) AS body
         FROM events e
         JOIN event_entities ee ON ee.event_id = e.id
         WHERE ee.entity_slug = ? AND e.ts >= ?
         ORDER BY e.ts DESC
         LIMIT ?`
      )
      .all(slug, sinceIso, this.config.recentEventsPerEntity)
    return rows
  }

  // ---------------- proposal writing ----------------

  private async writeProposal(
    group: StaleFactGroup,
    evaluation: ProactiveEvaluation
  ): Promise<string> {
    const payload: CreatePayload = {
      kind: 'create',
      task: this.buildBlueprint(group, evaluation),
      traceback: this.buildTraceback(group, evaluation),
    }
    const proposal = this.opts.proposalStore.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: PROACTIVE_SOURCE_AGENT,
      sourceCaptureId: null,
      payload,
      summary: evaluation.action_title,
    })
    this.log(
      `[proactive] proposed (${group.entitySlug} → proposal ${proposal.id}): "${evaluation.action_title}" conf=${evaluation.confidence.toFixed(2)}`
    )
    return proposal.id
  }

  private buildBlueprint(
    group: StaleFactGroup,
    evaluation: ProactiveEvaluation
  ): MindwtrTaskBlueprint {
    const factLines = group.facts
      .slice(0, 3)
      .map((f) => `- [${f.factType ?? 'fact'}] ${f.statement} (since ${f.validFrom.slice(0, 10)})`)
      .join('\n')

    const description =
      `${evaluation.action_description}\n\nWhy AI suggested this:\n${evaluation.reasoning}\n\n` +
      `Active facts about ${group.entitySlug}:\n${factLines}`

    return {
      title: evaluation.action_title.slice(0, 120),
      status: 'inbox',
      tags: ['ai-proactive', `ai-kind:${evaluation.action_kind}`],
      description,
      metadata: {
        ai_origin: true,
        ai_source: 'proactive-runner',
        ai_confidence: evaluation.confidence,
        ai_action_kind: evaluation.action_kind,
        ai_entity_slug: group.entitySlug,
        ai_fact_ids: group.facts.map((f) => f.id),
        ai_stale_since_ms: group.staleSinceMs,
      },
    }
  }

  private buildTraceback(
    group: StaleFactGroup,
    evaluation: ProactiveEvaluation
  ): ProposalTraceback {
    const factsText = group.facts
      .map((f) => `[${f.factType ?? 'fact'}] ${f.statement}`)
      .join('\n')
    const staleHours = Math.round(group.staleSinceMs / 3600_000)
    return {
      captureExcerpt: `Active facts for ${group.entitySlug} (stale ${staleHours}h):\n${factsText}`,
      sourceChannel: 'memory:proactive-runner',
      sourceMeta: {
        entitySlug: group.entitySlug,
        factIds: group.facts.map((f) => f.id),
        staleSinceMs: group.staleSinceMs,
        lastFactTs: group.lastFactTs,
      },
      capturedAt: this.now().toISOString(),
      evidenceQuote: '',
      cuesDetected: [`action:${evaluation.action_kind}`, `stale:${staleHours}h`],
      reasoningSteps: evaluation.reasoning ? [evaluation.reasoning] : [],
    }
  }

  // ============================================================================
  // Reverse pass: open Mindwtr tasks → completion / stale verdict → modify proposal
  // ============================================================================

  async runOpenTasksPass(): Promise<ReversePassResult> {
    const startedAt = Date.now()
    const decisions: OpenTaskDecision[] = []
    let proposed = 0
    let skipped = 0
    let errors = 0

    if (!this.opts.mindwtrClient || !this.opts.retriever) {
      this.log('[proactive:reverse] skipped — mindwtrClient or retriever not configured')
      return {
        scannedTasks: 0,
        proposed: 0,
        skipped: 0,
        errors: 0,
        elapsedMs: Date.now() - startedAt,
        decisions: [],
      }
    }

    const tasks = await this.fetchOpenTasks()
    this.log(`[proactive:reverse] scanning ${tasks.length} open tasks`)

    for (const task of tasks) {
      if (proposed >= this.config.reverseMaxProposalsPerPass) {
        decisions.push({
          taskId: task.id,
          taskTitle: task.title,
          action: 'skipped-budget',
          reason: `exceeded reverseMaxProposalsPerPass=${this.config.reverseMaxProposalsPerPass}`,
        })
        skipped += 1
        continue
      }

      const ageMs = this.now().getTime() - Date.parse(task.createdAt)
      if (Number.isFinite(ageMs) && ageMs < this.config.taskMinAgeMs) {
        decisions.push({
          taskId: task.id,
          taskTitle: task.title,
          action: 'skipped-too-fresh',
          reason: `task age ${Math.round(ageMs / 3600_000)}h < taskMinAgeMs=${Math.round(this.config.taskMinAgeMs / 3600_000)}h`,
        })
        skipped += 1
        continue
      }

      // Dedup: pending check first (more informative outcome), then any
      // recent proposal (resolved or not) within the dedup window. Pending
      // is also "recent" — by checking it first we surface the actionable
      // state without losing the recent-window guard for resolved ones.
      if (this.hasPendingReverseProposalForTask(task.id)) {
        decisions.push({
          taskId: task.id,
          taskTitle: task.title,
          action: 'skipped-already-pending',
          reason: 'pending proactive proposal already exists',
        })
        skipped += 1
        continue
      }
      if (this.hasRecentReverseProposalForTask(task.id)) {
        decisions.push({
          taskId: task.id,
          taskTitle: task.title,
          action: 'skipped-recent-resolution',
          reason: `recent proactive proposal on this task within ${Math.round(this.config.reverseDedupWindowMs / 3600_000)}h`,
        })
        skipped += 1
        continue
      }

      try {
        const eventsAndFacts = await this.gatherContextForTask(task)
        if (eventsAndFacts.events.length === 0 && eventsAndFacts.facts.length === 0) {
          decisions.push({
            taskId: task.id,
            taskTitle: task.title,
            action: 'skipped-no-entities',
            reason: 'no related events/facts found in memory',
          })
          skipped += 1
          continue
        }

        const verdict = await this.evaluateTask(task, eventsAndFacts)

        if (verdict.verdict === 'still_active') {
          decisions.push({
            taskId: task.id,
            taskTitle: task.title,
            action: 'skipped-llm-still-active',
            reason: verdict.reasoning,
            evaluation: verdict,
          })
          skipped += 1
          continue
        }
        if (verdict.verdict === 'unclear') {
          decisions.push({
            taskId: task.id,
            taskTitle: task.title,
            action: 'skipped-llm-unclear',
            reason: verdict.reasoning,
            evaluation: verdict,
          })
          skipped += 1
          continue
        }
        if (verdict.confidence < this.config.reverseMinConfidence) {
          decisions.push({
            taskId: task.id,
            taskTitle: task.title,
            action: 'skipped-low-confidence',
            reason: `confidence ${verdict.confidence.toFixed(2)} < ${this.config.reverseMinConfidence}`,
            evaluation: verdict,
          })
          skipped += 1
          continue
        }

        const targetStatus: 'done' | 'someday' = verdict.verdict === 'completed' ? 'done' : 'someday'
        const proposalId = await this.writeCompletionProposal(task, verdict, targetStatus)
        proposed += 1
        decisions.push({
          taskId: task.id,
          taskTitle: task.title,
          action: targetStatus === 'done' ? 'proposed-done' : 'proposed-someday',
          proposalId,
          reason: verdict.reasoning,
          evaluation: verdict,
        })
      } catch (err) {
        errors += 1
        this.log(`[proactive:reverse] evaluate/write failed for ${task.id}: ${(err as Error).message}`)
        decisions.push({
          taskId: task.id,
          taskTitle: task.title,
          action: 'error',
          reason: (err as Error).message,
        })
      }
    }

    const elapsedMs = Date.now() - startedAt
    this.log(
      `[proactive:reverse] done: ${proposed} proposed, ${skipped} skipped, ${errors} errors in ${elapsedMs}ms`
    )
    return {
      scannedTasks: tasks.length,
      proposed,
      skipped,
      errors,
      elapsedMs,
      decisions,
    }
  }

  private async fetchOpenTasks(): Promise<Task[]> {
    if (!this.opts.mindwtrClient) return []
    const tasks: Task[] = []
    for (const status of this.config.openTaskStatuses) {
      try {
        const batch = await this.opts.mindwtrClient.listTasks({ status, limit: 50 })
        tasks.push(...batch)
      } catch (err) {
        this.log(`[proactive:reverse] listTasks(${status}) failed: ${(err as Error).message}`)
      }
    }
    return tasks
  }

  private hasPendingReverseProposalForTask(taskId: string): boolean {
    const pending = this.opts.proposalStore.listPending({
      sourceAgent: PROACTIVE_SOURCE_AGENT,
      targetTaskId: taskId,
      limit: 1,
    })
    return pending.length > 0
  }

  private hasRecentReverseProposalForTask(taskId: string): boolean {
    const recent = this.opts.proposalStore.listRecentByAgent(
      PROACTIVE_SOURCE_AGENT,
      this.config.reverseDedupWindowMs
    )
    return recent.some((p) => p.targetTaskIds.includes(taskId))
  }

  private async gatherContextForTask(
    task: Task
  ): Promise<{
    events: Array<{ ts: string; app: string | null; title: string | null; body: string }>
    facts: Fact[]
    entitySlugs: string[]
  }> {
    // Use task title + description as the retrieval query — hybrid search
    // surfaces events even when the task doesn't carry an explicit entity slug.
    const query = [task.title, task.description ?? '', task.assignedTo ?? '']
      .filter(Boolean)
      .join(' ')
      .slice(0, 800)

    const retrieved = await this.opts.retriever!.retrieve({
      query,
      limit: this.config.reverseEventsLimit,
      withinDays: this.config.reverseEventsWithinDays,
    })

    // 1-hop entity expansion through event_entities.
    const slugSet = new Set<string>()
    if (retrieved.length > 0) {
      const placeholders = retrieved.map(() => '?').join(',')
      const rows = this.opts.memoryStore.db
        .query<{ entity_slug: string }, string[]>(
          `SELECT DISTINCT entity_slug FROM event_entities
            WHERE event_id IN (${placeholders})`
        )
        .all(...retrieved.map((e) => e.id))
      for (const r of rows) slugSet.add(r.entity_slug)
    }
    // Also include assignedTo as an explicit slug hint (best-effort).
    if (task.assignedTo) {
      const slug = task.assignedTo
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      if (slug) slugSet.add(slug)
    }

    const facts: Fact[] = []
    for (const slug of slugSet) {
      facts.push(...this.opts.memoryStore.activeFactsFor(slug).slice(0, 5))
    }

    return {
      events: retrieved.map((e) => ({
        ts: e.ts,
        app: e.app,
        title: e.title,
        body: e.body,
      })),
      facts,
      entitySlugs: [...slugSet],
    }
  }

  async evaluateTask(
    task: Task,
    ctx: {
      events: Array<{ ts: string; app: string | null; title: string | null; body: string }>
      facts: Fact[]
      entitySlugs: string[]
    }
  ): Promise<CompletionEvaluation> {
    const prompt = buildCompletionPrompt(task, ctx, this.now())
    const res = await this.opts.llm.chatCompletion({
      messages: [
        { role: 'system', content: COMPLETION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.1,
    })
    const raw = res.choices[0]?.message?.content ?? ''
    return parseCompletionOutput(raw)
  }

  private async writeCompletionProposal(
    task: Task,
    verdict: CompletionEvaluation,
    targetStatus: 'done' | 'someday'
  ): Promise<string> {
    const diff: FieldDiff[] = [
      { field: 'status', from: task.status, to: targetStatus },
    ]
    const payload: ModifyPayload = {
      kind: 'modify',
      taskId: task.id,
      diff,
      traceback: {
        captureExcerpt:
          `Task "${task.title}" (status=${task.status}). ` +
          `Memory verdict: ${verdict.verdict}.\n` +
          `Evidence: ${verdict.evidence_quote || '(no quote)'}\n` +
          `Reasoning: ${verdict.reasoning}`,
        sourceChannel: 'memory:proactive-runner',
        sourceMeta: {
          taskId: task.id,
          verdict: verdict.verdict,
          targetStatus,
        },
        capturedAt: this.now().toISOString(),
        evidenceQuote: verdict.evidence_quote,
        cuesDetected: [`verdict:${verdict.verdict}`, `target:${targetStatus}`],
        reasoningSteps: verdict.reasoning ? [verdict.reasoning] : [],
      },
    }

    // originSnapshot lets the applier do drift-detection later — if the
    // user manually changed the task between proposal and approval, applier
    // marks it stale instead of overwriting blindly.
    const originSnapshot = {
      id: task.id,
      title: task.title,
      status: task.status,
      tags: task.tags,
      contexts: task.contexts,
      assignedTo: task.assignedTo ?? null,
      description: task.description ?? '',
    }

    const proposal = this.opts.proposalStore.create({
      type: 'modify',
      targetTaskIds: [task.id],
      sourceAgent: PROACTIVE_SOURCE_AGENT,
      sourceCaptureId: null,
      payload,
      originSnapshot,
      summary:
        targetStatus === 'done'
          ? `Mark "${task.title}" done — appears completed in memory`
          : `Move "${task.title}" to someday — stale`,
    })
    this.log(
      `[proactive:reverse] proposed (${task.id} → proposal ${proposal.id}): ${task.status}→${targetStatus} "${task.title.slice(0, 60)}" conf=${verdict.confidence.toFixed(2)}`
    )
    return proposal.id
  }
}

// ---------------- LLM prompt + parser ----------------

const SYSTEM_PROMPT = `You are a proactive GTD assistant inside a personal knowledge graph.

Given:
- An entity (a person, project, or topic) the user has been tracking.
- The currently-active facts about that entity (with valid_from dates).
- Recent events mentioning that entity (last N days).
- The current wall-clock time.

Decide whether to surface an action proposal for the user RIGHT NOW.

Rules (CRITICAL — false positives ruin user trust):
- ONLY propose when there is a CONCRETE next step the user could take.
  Examples of concrete: "Ping Joe about the AI review", "Reply to Polina re: invoice",
  "Check that Friday meeting is on the calendar".
  Examples NOT concrete: "Think about X", "Eventually do Y".
- If the user already acted recently (look at recent events — any user activity
  in the last 24h on this entity) → SKIP. They're on it.
- If the staleness is short (<48h on a waiting_on, <72h on a working_on) → SKIP.
  Premature follow-ups annoy.
- If facts look obsolete (e.g. user already received the thing they were waiting on,
  per recent events) → propose archive_obsolete (action_title: "Archive 'X' — looks resolved").
- If you're not sure → SKIP. The cost of a missed proposal is small (we run again
  next pass); the cost of a wrong one is large (spam erodes trust).
- Confidence must reflect actual confidence. < 0.75 → automatic SKIP downstream.

Output strict JSON in this exact shape, no prose, no fences:
{
  "should_propose": true | false,
  "action_title": "<short imperative, ≤80 chars, empty if not proposing>",
  "action_description": "<one-sentence description, empty if not proposing>",
  "action_kind": "follow_up" | "reminder" | "archive_obsolete" | "other",
  "reasoning": "<1-2 sentence rationale grounded in the facts/events>",
  "confidence": 0.0-1.0
}

Output ONLY the JSON object.`

function buildPrompt(
  group: StaleFactGroup,
  recentEvents: Array<{ ts: string; app: string | null; title: string | null; body: string }>,
  now: Date
): string {
  const factLines = group.facts.map(
    (f) =>
      `- [${f.factType ?? 'fact'}] ${f.statement} (since ${f.validFrom.slice(0, 16).replace('T', ' ')})`
  )
  const eventLines = recentEvents.map((e) => {
    const ts = e.ts.slice(0, 16).replace('T', ' ')
    const excerpt = e.body.replace(/\s+/g, ' ').slice(0, 180)
    return `- [${ts}] ${e.app ?? '-'}/${e.title ?? '-'} — ${excerpt}`
  })
  const staleHours = Math.round(group.staleSinceMs / 3600_000)

  return `Entity: ${group.entitySlug}
Stale: ${staleHours}h since last fact change.
Now (UTC): ${now.toISOString()}

Active facts:
${factLines.join('\n')}

Recent events about this entity (newest first, may be empty):
${eventLines.join('\n') || '(none)'}

Decide now.`
}

export function parseProactiveOutput(raw: string): ProactiveEvaluation {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
  if (!cleaned) return emptyEval()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return emptyEval()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyEval()
  const o = parsed as Record<string, unknown>
  return {
    should_propose: o.should_propose === true,
    action_title: typeof o.action_title === 'string' ? o.action_title.trim().slice(0, 120) : '',
    action_description:
      typeof o.action_description === 'string' ? o.action_description.trim() : '',
    action_kind: normalizeKind(o.action_kind),
    reasoning: typeof o.reasoning === 'string' ? o.reasoning.trim() : '',
    confidence: clamp01(typeof o.confidence === 'number' ? o.confidence : 0),
  }
}

function normalizeKind(v: unknown): ProactiveEvaluation['action_kind'] {
  if (v === 'follow_up' || v === 'reminder' || v === 'archive_obsolete') return v
  return 'other'
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function emptyEval(): ProactiveEvaluation {
  return {
    should_propose: false,
    action_title: '',
    action_description: '',
    action_kind: 'other',
    reasoning: 'LLM output unparseable',
    confidence: 0,
  }
}

// ---------------- helpers ----------------

/**
 * Extracts an entity_slug from a proposal's currentPayload metadata. Used to
 * build the dedup set against recent proactive proposals — proactive
 * proposals carry their entity slug under metadata.ai_entity_slug.
 */
function extractEntitySlugFromProposal(p: { currentPayload: unknown }): string[] {
  const payload = p.currentPayload as { task?: { metadata?: Record<string, unknown> } } | null
  const slug = payload?.task?.metadata?.ai_entity_slug
  return typeof slug === 'string' && slug.length > 0 ? [slug] : []
}

// ---------------- Reverse-pass LLM (completion verdict) ----------------

const COMPLETION_SYSTEM_PROMPT = `You evaluate whether an OPEN GTD task can be safely marked as completed or stale, based on the user's recent memory (events + active facts about related entities).

DEFAULT verdict is "unclear" — only emit "completed" or "stale" with strong evidence.

Verdicts:
- "completed": memory clearly shows the task is finished. REQUIRES a specific evidence_quote from events (e.g. "Sergey uploaded TestFlight build" closes "Upload TestFlight build for Valentin").
- "stale": no recent activity, old (>2 weeks), likely should go to someday. NOT for short-stale things.
- "still_active": recent events show ongoing work — DO NOT propose changes.
- "unclear": can't tell from available data → skip.

CRITICAL rules:
- False-positives here mean "AI archived my live task" — much worse than missed proposals. WHEN IN DOUBT, choose 'unclear'.
- "completed" requires a specific event quote showing closure. Vague "saw activity" is NOT enough.
- Tasks <24h old → 'unclear' or 'still_active' unless evidence is overwhelming.
- Never propose deletion (we only mark done/someday). Status changes are reversible.
- confidence MUST reflect actual confidence. Threshold downstream is 0.85 — anything below is auto-skipped.

Output strict JSON, no prose, no fences:
{
  "verdict": "completed" | "stale" | "still_active" | "unclear",
  "evidence_quote": "<exact event quote, or empty>",
  "reasoning": "<1-2 sentence rationale>",
  "confidence": 0.0-1.0
}

Output ONLY the JSON object.`

function buildCompletionPrompt(
  task: Task,
  ctx: {
    events: Array<{ ts: string; app: string | null; title: string | null; body: string }>
    facts: Fact[]
    entitySlugs: string[]
  },
  now: Date
): string {
  const ageHours = Math.round((now.getTime() - Date.parse(task.createdAt)) / 3600_000)
  const factLines = ctx.facts.slice(0, 10).map(
    (f) => `- [${f.factType ?? 'fact'}] ${f.statement} (about ${f.entitySlug ?? '?'}, since ${f.validFrom.slice(0, 10)})`
  )
  const eventLines = ctx.events.slice(0, 10).map((e) => {
    const ts = e.ts.slice(0, 16).replace('T', ' ')
    const excerpt = e.body.replace(/\s+/g, ' ').slice(0, 200)
    return `- [${ts}] ${e.app ?? '-'}/${e.title ?? '-'} — ${excerpt}`
  })
  const slugLine =
    ctx.entitySlugs.length > 0 ? `Linked entities: ${ctx.entitySlugs.slice(0, 8).join(', ')}` : ''

  return `Task: "${task.title}"
Status: ${task.status}
Age: ${ageHours}h
Assigned to: ${task.assignedTo ?? '(none)'}
Description: ${(task.description ?? '').slice(0, 400) || '(empty)'}
${slugLine}

Now (UTC): ${now.toISOString()}

Active facts about linked entities:
${factLines.join('\n') || '(none)'}

Recent events about linked entities (newest first):
${eventLines.join('\n') || '(none)'}

Decide now. Default to "unclear" if anything ambiguous.`
}

export function parseCompletionOutput(raw: string): CompletionEvaluation {
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim()
  if (!cleaned) return emptyCompletion()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return emptyCompletion()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyCompletion()
  const o = parsed as Record<string, unknown>
  return {
    verdict: normalizeVerdict(o.verdict),
    evidence_quote: typeof o.evidence_quote === 'string' ? o.evidence_quote.trim().slice(0, 500) : '',
    reasoning: typeof o.reasoning === 'string' ? o.reasoning.trim() : '',
    confidence: clamp01(typeof o.confidence === 'number' ? o.confidence : 0),
  }
}

function normalizeVerdict(v: unknown): TaskVerdict {
  if (v === 'completed' || v === 'stale' || v === 'still_active') return v
  return 'unclear'
}

function emptyCompletion(): CompletionEvaluation {
  return {
    verdict: 'unclear',
    evidence_quote: '',
    reasoning: 'LLM output unparseable',
    confidence: 0,
  }
}

// suppress unused import warning when randomUUID isn't directly used
void randomUUID
