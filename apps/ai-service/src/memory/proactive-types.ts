/**
 * Types for the ProactiveRunner — periodic memory-driven proposal pass.
 *
 * Distinct from Commitment Detector:
 *   - Commitment Detector is reactive (per-capture trigger).
 *   - ProactiveRunner is scheduled (every N hours, scans memory state).
 *
 * Both write Proposal entities via the same ProposalStore. Source-agent
 * label `proactive-runner` lets the UI / audit log distinguish them.
 */

import type { Fact } from './types'

/**
 * Group of currently-active facts for one entity_slug. The runner
 * evaluates groups, not individual facts, so the LLM sees the full
 * picture for an entity ("waiting on Joe + Joe pushed code") instead
 * of one fact at a time.
 */
export interface StaleFactGroup {
  entitySlug: string
  facts: Fact[]
  /** Latest valid_from among the facts in this group — used as "staleness anchor". */
  lastFactTs: string
  /** Wall-clock milliseconds since `lastFactTs`. */
  staleSinceMs: number
}

/**
 * Structured LLM verdict for a single group. The runner uses this to
 * decide whether to write a proposal and what its title/description
 * should be.
 */
export interface ProactiveEvaluation {
  /** When false, runner skips (no proposal). */
  should_propose: boolean
  /** Imperative GTD title; only meaningful when should_propose=true. */
  action_title: string
  /** One-sentence description for the task body. */
  action_description: string
  /** Free-form taxonomy hint for downstream filtering / UI. */
  action_kind: 'follow_up' | 'reminder' | 'archive_obsolete' | 'other'
  /** Human-readable rationale (1 short paragraph). Stored in traceback. */
  reasoning: string
  /** 0..1; the runner discards anything below the configured threshold. */
  confidence: number
}

/**
 * Configurable knobs. Defaults are conservative — false-positives spam
 * the inbox and erode user trust, which kills the whole feature.
 */
export interface ProactiveConfig {
  /**
   * A fact is "stale" when wall-clock minus its valid_from exceeds this.
   * Default 24h. Setting it too low causes proposals on hot threads
   * where the user is already on it.
   */
  staleAfterMs: number
  /** Max proposals per run (hard cap, even if more eligible). Default 5. */
  maxProposalsPerPass: number
  /** Min LLM confidence to write proposal. Default 0.75. */
  minConfidence: number
  /**
   * Don't re-propose for the same entity_slug within this window. Default
   * 24h. Prevents loops where the runner re-evaluates the same stale state
   * every pass and floods the inbox.
   */
  dedupWindowMs: number
  /**
   * Only scan facts whose `fact_type` is in this list. Default
   * ['waiting_on', 'working_on']. Excludes static facts like 'role',
   * 'location' which don't have "next action" semantics.
   */
  factTypesToScan: string[]
  /**
   * How many recent events per entity to include in the LLM prompt.
   * Default 5. More gives better context but costs tokens.
   */
  recentEventsPerEntity: number
  /** Cap the lookback window for recent events. Default 14 days. */
  recentEventsWithinDays: number

  // ---------------- Reverse pass (open tasks → completion verdict) ----------------

  /**
   * Confidence threshold for the reverse pass. Stricter than forward
   * (default 0.85 vs 0.75) because false-positives here mean "AI archived
   * my live task" — much worse user impact than spurious follow-ups.
   */
  reverseMinConfidence: number
  /** Max reverse proposals per pass. Default 3 — kept tight on purpose. */
  reverseMaxProposalsPerPass: number
  /** Statuses considered "open" and scanned by reverse pass. */
  openTaskStatuses: string[]
  /**
   * Don't propose status changes on tasks younger than this. Default 24h.
   * Fresh tasks are still being shaped; user often updates them imminently.
   */
  taskMinAgeMs: number
  /** Don't re-propose for same task_id within this window. Default 48h. */
  reverseDedupWindowMs: number
  /** Max events retrieved per task for the verdict prompt. Default 8. */
  reverseEventsLimit: number
  /** Lookback for recent events when evaluating a task. Default 7 days. */
  reverseEventsWithinDays: number
}

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  staleAfterMs: 24 * 60 * 60 * 1000,
  maxProposalsPerPass: 5,
  minConfidence: 0.75,
  dedupWindowMs: 24 * 60 * 60 * 1000,
  factTypesToScan: ['waiting_on', 'working_on'],
  recentEventsPerEntity: 5,
  recentEventsWithinDays: 14,
  // Reverse-pass (open tasks → completion verdict) defaults.
  reverseMinConfidence: 0.85,
  reverseMaxProposalsPerPass: 3,
  openTaskStatuses: ['inbox', 'next', 'waiting'],
  taskMinAgeMs: 24 * 60 * 60 * 1000,
  reverseDedupWindowMs: 48 * 60 * 60 * 1000,
  reverseEventsLimit: 8,
  reverseEventsWithinDays: 7,
}

/** Per-group decision recorded for telemetry — what the runner did and why. */
export interface ProactiveDecision {
  entitySlug: string
  action: 'proposed' | 'skipped-recent-proposal' | 'skipped-not-stale' | 'skipped-low-confidence' | 'skipped-llm-no' | 'skipped-budget' | 'error'
  proposalId?: string
  reason: string
  evaluation?: ProactiveEvaluation
}

export interface ProactiveRunResult {
  scannedGroups: number
  proposed: number
  skipped: number
  errors: number
  elapsedMs: number
  decisions: ProactiveDecision[]
}

// ---------------- Reverse pass: open tasks → completion verdict ----------------

/**
 * LLM verdict for an open task evaluated against memory.
 *   - 'completed' : recent events show the task is done. requires evidence_quote.
 *   - 'stale'     : no recent activity, likely should move to someday.
 *   - 'still_active' : recent events show active work — DO NOT touch.
 *   - 'unclear'   : default; runner skips. False-positives kill trust.
 */
export type TaskVerdict = 'completed' | 'stale' | 'still_active' | 'unclear'

export interface CompletionEvaluation {
  verdict: TaskVerdict
  /** Verbatim event quote that justifies the verdict; '' when unclear. */
  evidence_quote: string
  /** 1-2 sentence rationale. */
  reasoning: string
  /** 0..1; runner discards below reverseMinConfidence threshold. */
  confidence: number
}

export interface OpenTaskDecision {
  taskId: string
  taskTitle: string
  action:
    | 'proposed-done'
    | 'proposed-someday'
    | 'skipped-too-fresh'
    | 'skipped-already-pending'
    | 'skipped-recent-resolution'
    | 'skipped-llm-still-active'
    | 'skipped-llm-unclear'
    | 'skipped-low-confidence'
    | 'skipped-budget'
    | 'skipped-no-entities'
    | 'error'
  proposalId?: string
  reason: string
  evaluation?: CompletionEvaluation
}

export interface ReversePassResult {
  scannedTasks: number
  proposed: number
  skipped: number
  errors: number
  elapsedMs: number
  decisions: OpenTaskDecision[]
}

export interface ProactiveCombinedResult {
  forward: ProactiveRunResult
  reverse: ReversePassResult | null
}

export const PROACTIVE_SOURCE_AGENT = 'proactive-runner'
