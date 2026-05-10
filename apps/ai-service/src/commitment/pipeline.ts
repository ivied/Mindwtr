/**
 * Commitment Detector pipeline — orchestrates L0 → Proposer → Writer.
 *
 * Called per pull capture (after Context Store insert). Flow:
 *   1. L0 regex pre-filter — kill obvious noise without paying for LLM
 *   2. Proposer LLM call — structured assessment with role disambiguation
 *   3. If is_actionable && who_owes !== 'other' && confidence >= threshold
 *      → persist a Proposal entity (type=create) via ProposalWriter
 *
 * Errors at any stage are swallowed and logged — capture is already safely
 * persisted in Context Store, so we don't lose data, we just don't propose.
 */

import type { CaptureRecord } from '../context-store/types'
import type { Proposer } from './proposer'
import type { ProposalWriter } from './writer'
import type { ProposalNotifier } from '../bot/proposal-notifier'
import { l0Filter } from './l0-filter'
import {
  evaluateSourceDeny,
  type SourceDenyConfig,
  DEFAULT_DENY_APPS,
  DEFAULT_DENY_URL_PATTERNS,
} from './source-deny'

export interface CommitmentPipelineConfig {
  /** Min Proposer confidence to write proposal (0..1). Default 0.7 */
  minConfidence: number
  /** When false, skip the L0 regex (every capture goes to LLM). Default true. */
  useL0: boolean
  /** When provided, captures whose source matches are skipped before any LLM call. */
  sourceDeny?: SourceDenyConfig
}

export const DEFAULT_PIPELINE_CONFIG: CommitmentPipelineConfig = {
  minConfidence: 0.7,
  useL0: true,
  sourceDeny: {
    apps: [...DEFAULT_DENY_APPS],
    urlPatterns: [...DEFAULT_DENY_URL_PATTERNS],
  },
}

export type PipelineOutcome =
  | { kind: 'source-denied'; reason: string }
  | { kind: 'l0-skip'; reasons: string[] }
  | { kind: 'not-actionable'; reasoning: string }
  | { kind: 'low-confidence'; confidence: number; reasoning: string }
  | { kind: 'wrong-role'; whoOwes: string; reasoning: string }
  | { kind: 'proposed'; proposalId: string; title: string; confidence: number }
  | { kind: 'duplicate'; existingProposalId: string }
  | { kind: 'error'; error: Error }

export class CommitmentPipeline {
  private notifier: ProposalNotifier | null = null

  constructor(
    private proposer: Proposer,
    private writer: ProposalWriter,
    private config: CommitmentPipelineConfig = DEFAULT_PIPELINE_CONFIG,
    private log: (msg: string) => void = console.log
  ) {}

  /** Late-binding for the notifier so wiring code can resolve the bot→pipeline→notifier cycle. */
  setNotifier(notifier: ProposalNotifier | null): void {
    this.notifier = notifier
  }

  async run(capture: CaptureRecord): Promise<PipelineOutcome> {
    // Source deny — runs before everything else. Captures from design tools,
    // mockup previews, or messengers (where our own TG cards land) never
    // produce proposals, regardless of how actionable the OCR'd text looks.
    if (this.config.sourceDeny) {
      const deny = evaluateSourceDeny(capture, this.config.sourceDeny)
      if (deny.denied) {
        this.log(`[commitment] source-denied (${capture.id}): ${deny.reason}`)
        return { kind: 'source-denied', reason: deny.reason ?? 'unknown' }
      }
    }

    // Audio captures bypass L0: speech transcripts are short, often lack
    // explicit verb cues that the regex catches, and LLM cost on a single
    // 30s transcript is negligible. Screen captures still go through L0
    // because OCR text can be huge and full of noise.
    const skipL0ForAudio = capture.sourceChannel === 'audio_capture'
    if (this.config.useL0 && !skipL0ForAudio) {
      const l0 = l0Filter(capture.text)
      if (!l0.pass) {
        this.log(`[commitment] L0 skip (${capture.id}): ${l0.reasons.join(',')}`)
        return { kind: 'l0-skip', reasons: l0.reasons }
      }
    }

    let proposal
    try {
      proposal = await this.proposer.propose(capture.text, capture.sourceMeta ?? undefined)
    } catch (err) {
      this.log(`[commitment] proposer failed (${capture.id}): ${(err as Error).message}`)
      return { kind: 'error', error: err as Error }
    }

    if (!proposal.is_actionable) {
      this.log(`[commitment] not-actionable (${capture.id}): ${proposal.reasoning}`)
      return { kind: 'not-actionable', reasoning: proposal.reasoning }
    }

    if (proposal.who_owes === 'other') {
      this.log(`[commitment] wrong-role other (${capture.id}): ${proposal.reasoning}`)
      return { kind: 'wrong-role', whoOwes: proposal.who_owes, reasoning: proposal.reasoning }
    }

    if (proposal.confidence < this.config.minConfidence) {
      this.log(
        `[commitment] low-confidence ${proposal.confidence.toFixed(2)} (${capture.id}): ${proposal.title}`
      )
      return { kind: 'low-confidence', confidence: proposal.confidence, reasoning: proposal.reasoning }
    }

    try {
      const written = await this.writer.write({
        proposal,
        captureText: capture.text,
        sourceCaptureId: capture.id,
        sourceChannel: capture.sourceChannel,
        sourceMeta: capture.sourceMeta,
      })
      if (written.duplicate) {
        this.log(
          `[commitment] duplicate (${capture.id} → existing ${written.proposalId}): "${written.title}"`
        )
        return { kind: 'duplicate', existingProposalId: written.proposalId }
      }
      this.log(
        `[commitment] proposed (${capture.id} → proposal ${written.proposalId}): "${written.title}" conf=${proposal.confidence.toFixed(2)}`
      )
      // Fire-and-forget TG notification. Errors logged inside notifier; never propagate.
      if (this.notifier?.enabled) {
        void this.notifier.notifyCreated(written.proposal)
      }
      return {
        kind: 'proposed',
        proposalId: written.proposalId,
        title: written.title,
        confidence: proposal.confidence,
      }
    } catch (err) {
      this.log(`[commitment] writer failed (${capture.id}): ${(err as Error).message}`)
      return { kind: 'error', error: err as Error }
    }
  }
}
