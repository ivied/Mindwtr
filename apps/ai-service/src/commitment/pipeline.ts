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
import type { Proposer, UserIdentity } from './proposer'
import type { ProposalWriter } from './writer'
import type { ProposalNotifier } from '../bot/proposal-notifier'
import type { InboxTitlesProvider } from './inbox-titles'
import type { PersonsProvider } from '../wiki/persons-reader'
import type { ProposerContextProvider } from '../memory/proposer-context'
import { l0Filter } from './l0-filter'
import {
  evaluateSourceDeny,
  type SourceDenyConfig,
  DEFAULT_DENY_APPS,
  DEFAULT_DENY_URL_PATTERNS,
  DEFAULT_DENY_WINDOW_TITLE_PATTERNS,
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
    windowTitlePatterns: [...DEFAULT_DENY_WINDOW_TITLE_PATTERNS],
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
  | { kind: 'duplicate-of-existing'; existingTitle: string; reasoning: string }
  | { kind: 'error'; error: Error }

export class CommitmentPipeline {
  private notifier: ProposalNotifier | null = null
  private inboxTitlesProvider: InboxTitlesProvider | null = null
  private userIdentity: UserIdentity | null = null
  private personsProvider: PersonsProvider | null = null
  private memoryContextProvider: ProposerContextProvider | null = null

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

  /** Optional: when set, recent inbox titles are passed to the Proposer for
   *  semantic dedup against existing user-known cards. */
  setInboxTitlesProvider(provider: InboxTitlesProvider | null): void {
    this.inboxTitlesProvider = provider
  }

  /** Identity anchor — Proposer uses it to map first-person pronouns to the
   *  right person and decide who_owes / recipient correctly. */
  setUserIdentity(identity: UserIdentity | null): void {
    this.userIdentity = identity
  }

  /** Optional: when set, top known persons from the capture-wiki are passed
   *  to the Proposer so who_to gets normalized to a canonical slug. */
  setPersonsProvider(provider: PersonsProvider | null): void {
    this.personsProvider = provider
  }

  /** Optional: when set, a compact RECENT_CONTEXT block (active facts + top
   *  related events from the memory module) is appended to the Proposer
   *  user-message. Fail-open: errors are logged and the capture is still
   *  proposed without the extra context. */
  setMemoryContextProvider(provider: ProposerContextProvider | null): void {
    this.memoryContextProvider = provider
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

    // Best-effort inbox titles for semantic dedup. Failures are logged and
    // ignored — we'd rather risk a duplicate proposal than miss a real one.
    let inboxTitles: string[] | undefined
    if (this.inboxTitlesProvider) {
      try {
        inboxTitles = await this.inboxTitlesProvider.recentTitles(50)
      } catch (err) {
        this.log(
          `[commitment] inbox titles fetch failed (${capture.id}): ${(err as Error).message}`
        )
      }
    }

    // Best-effort known persons for who_to canonicalization. Same fail-safe
    // posture: if wiki dir is unreadable, fall through to literal names.
    let knownPersons: Awaited<ReturnType<PersonsProvider['recentPersons']>> | undefined
    if (this.personsProvider) {
      try {
        knownPersons = await this.personsProvider.recentPersons(50)
      } catch (err) {
        this.log(
          `[commitment] persons fetch failed (${capture.id}): ${(err as Error).message}`
        )
      }
    }

    // Optional historical context from the memory module — folds active
    // facts + top related events from the user's history into the Proposer's
    // user-message. Best-effort: failure means no RECENT_CONTEXT block, the
    // capture still gets proposed.
    let recentContext: string | null = null
    if (this.memoryContextProvider) {
      try {
        recentContext = await this.memoryContextProvider.getRecentContext(capture.text)
      } catch (err) {
        this.log(
          `[commitment] memory context fetch failed (${capture.id}): ${(err as Error).message}`
        )
      }
    }

    let proposal
    try {
      proposal = await this.proposer.propose(
        capture.text,
        capture.sourceMeta ?? undefined,
        inboxTitles,
        this.userIdentity,
        knownPersons,
        recentContext
      )
    } catch (err) {
      this.log(`[commitment] proposer failed (${capture.id}): ${(err as Error).message}`)
      return { kind: 'error', error: err as Error }
    }

    // Semantic dedup against existing inbox items. Proposer sets is_actionable
    // false AND duplicate_of_title together — treat as a distinct outcome so
    // telemetry can tell "agent was wrong" from "user already has this card".
    if (proposal.duplicate_of_title) {
      this.log(
        `[commitment] duplicate-of-existing (${capture.id}): "${proposal.duplicate_of_title}"`
      )
      return {
        kind: 'duplicate-of-existing',
        existingTitle: proposal.duplicate_of_title,
        reasoning: proposal.reasoning,
      }
    }

    if (!proposal.is_actionable) {
      this.log(`[commitment] not-actionable (${capture.id}): ${proposal.reasoning}`)
      return { kind: 'not-actionable', reasoning: proposal.reasoning }
    }

    // who_owes='other' is only a real skip when the recipient is also not the
    // user (third-party conversation). When OTHER promises something TO the
    // user, it's a legitimate waiting-for card — proceed as normal; the
    // Proposer should already have set suggested_category='waiting'.
    if (proposal.who_owes === 'other' && proposal.recipient !== 'user') {
      this.log(
        `[commitment] wrong-role other→other (${capture.id}): ${proposal.reasoning}`
      )
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
