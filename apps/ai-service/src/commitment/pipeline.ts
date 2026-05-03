/**
 * Commitment Detector pipeline — orchestrates L0 → Proposer → Writer.
 *
 * Called per pull capture (after Context Store insert). Flow:
 *   1. L0 regex pre-filter — kill obvious noise without paying for LLM
 *   2. Proposer LLM call — structured assessment with role disambiguation
 *   3. If is_actionable && who_owes !== 'other' && confidence >= threshold
 *      → write proposal to Mindwtr inbox via ProposalWriter
 *
 * Errors at any stage are swallowed and logged — capture is already safely
 * persisted in Context Store, so we don't lose data, we just don't propose.
 */

import type { CaptureRecord } from '../context-store/types'
import type { Proposer } from './proposer'
import type { ProposalWriter } from './writer'
import { l0Filter } from './l0-filter'

export interface CommitmentPipelineConfig {
  /** Min Proposer confidence to write proposal (0..1). Default 0.7 */
  minConfidence: number
  /** When false, skip the L0 regex (every capture goes to LLM). Default true. */
  useL0: boolean
}

export const DEFAULT_PIPELINE_CONFIG: CommitmentPipelineConfig = {
  minConfidence: 0.7,
  useL0: true,
}

export type PipelineOutcome =
  | { kind: 'l0-skip'; reasons: string[] }
  | { kind: 'not-actionable'; reasoning: string }
  | { kind: 'low-confidence'; confidence: number; reasoning: string }
  | { kind: 'wrong-role'; whoOwes: string; reasoning: string }
  | { kind: 'proposed'; taskId: string; title: string; confidence: number }
  | { kind: 'error'; error: Error }

export class CommitmentPipeline {
  constructor(
    private proposer: Proposer,
    private writer: ProposalWriter,
    private config: CommitmentPipelineConfig = DEFAULT_PIPELINE_CONFIG,
    private log: (msg: string) => void = console.log
  ) {}

  async run(capture: CaptureRecord): Promise<PipelineOutcome> {
    if (this.config.useL0) {
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
      this.log(
        `[commitment] proposed (${capture.id} → task ${written.taskId}): "${written.title}" conf=${proposal.confidence.toFixed(2)}`
      )
      return {
        kind: 'proposed',
        taskId: written.taskId,
        title: written.title,
        confidence: proposal.confidence,
      }
    } catch (err) {
      this.log(`[commitment] writer failed (${capture.id}): ${(err as Error).message}`)
      return { kind: 'error', error: err as Error }
    }
  }
}
