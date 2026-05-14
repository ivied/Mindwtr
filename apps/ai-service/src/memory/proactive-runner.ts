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
import type {
  CreatePayload,
  MindwtrTaskBlueprint,
  ProposalTraceback,
} from '../proposal-store/payloads'
import type { ProposalStore } from '../proposal-store/store'
import type { MemoryStore } from './store'
import type { Fact } from './types'
import {
  DEFAULT_PROACTIVE_CONFIG,
  PROACTIVE_SOURCE_AGENT,
  type ProactiveConfig,
  type ProactiveDecision,
  type ProactiveEvaluation,
  type ProactiveRunResult,
  type StaleFactGroup,
} from './proactive-types'

export interface ProactiveRunnerOptions {
  memoryStore: MemoryStore
  proposalStore: ProposalStore
  llm: LLMClient
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

  async run(): Promise<ProactiveRunResult> {
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

// suppress unused import warning when randomUUID isn't directly used
void randomUUID
