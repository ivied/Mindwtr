/**
 * Proposal Writer — converts an actionable Proposer output into a Proposal entity
 * (type=create) in the Proposal Store.
 *
 * Replaces the legacy approach where this module wrote directly to a Mindwtr
 * inbox task with `[AI]` prefix and `proposal-ai` tag (see addendum
 * 2026-05-05). Now we persist a Proposal; apply (later) is the one that
 * actually creates a Mindwtr task once the user approves.
 */

import type { ProposalStore } from '../proposal-store/store'
import type { CreatePayload, MindwtrTaskBlueprint, ProposalPayload } from '../proposal-store/payloads'
import type { ProposalRecord } from '../proposal-store/types'
import type { Proposal } from './proposer'
import { smartExcerpt } from './smart-excerpt'

export interface WriteProposalInput {
  proposal: Proposal
  /** Original capture text (used in traceback/excerpt) */
  captureText: string
  /** ID of the Context Store capture that produced this proposal */
  sourceCaptureId: string
  /** Source channel for context (e.g. screen_capture) */
  sourceChannel: string
  /** Optional metadata from capture (window title, app, etc.) */
  sourceMeta?: Record<string, unknown> | null
}

export interface WriteProposalResult {
  proposalId: string
  version: number
  /** Title of the would-be task (clean, no [AI] prefix). */
  title: string
  /** Full record for downstream notifiers (e.g. TG push). */
  proposal: ProposalRecord
  /**
   * True when an existing similar proposal was reused instead of creating a new
   * one (dedup against OCR-spam / TG-loop bursts). Pipeline uses this to skip
   * the TG notify and report `duplicate` outcome.
   */
  duplicate?: boolean
}

/** Source-agent identifier used in audit / filters. Keep stable. */
export const SOURCE_AGENT_COMMITMENT_DETECTOR = 'commitment-detector'
/**
 * Lookback window for dedup. Bumped 10 → 60 minutes after a real-world case
 * where two "reschedule meeting with Artyom" proposals from audio_capture
 * landed ~3 minutes apart but the user only noticed both 30 minutes later —
 * Proposer + inbox-dedup is the primary gate, this signature compare is a
 * belt for cases where wording drift defeats the bag-of-words match.
 */
const DEDUP_WINDOW_MS = 60 * 60 * 1000

export class ProposalWriter {
  constructor(private store: ProposalStore) {}

  async write(input: WriteProposalInput): Promise<WriteProposalResult> {
    const title = cleanTitle(input.proposal.title)
    // For waiting cards, Mindwtr's native assignedTo field is the right place
    // for the person we're waiting on — Organize > Waiting groups by it.
    const assignedTo =
      input.proposal.suggested_category === 'waiting' && input.proposal.who_to
        ? input.proposal.who_to
        : undefined
    const signature = buildSignature(title, input.proposal.who_to, input.proposal.by_when)

    // Dedup: if a recent proposal from the same agent has the same normalized
    // signature, reuse it instead of creating a near-duplicate.
    const recent = this.store.listRecentByAgent(SOURCE_AGENT_COMMITMENT_DETECTOR, DEDUP_WINDOW_MS)
    const existing = recent.find((p) => signatureForRecord(p) === signature)
    if (existing) {
      return {
        proposalId: existing.id,
        version: existing.currentVersion,
        title,
        proposal: existing,
        duplicate: true,
      }
    }

    const description = buildDescription(input)
    const task: MindwtrTaskBlueprint = {
      title,
      status: 'inbox',
      tags: [],
      description,
      ...(assignedTo ? { assignedTo } : {}),
      metadata: {
        ai_origin: true,
        ai_confidence: input.proposal.confidence,
        ai_reasoning: input.proposal.reasoning,
        ai_who_owes: input.proposal.who_owes,
        ai_recipient: input.proposal.recipient,
        ai_who_to: input.proposal.who_to,
        // Canonical wiki slug when who_to matched a KNOWN_PERSONS entry.
        // Empty string means new/unknown person (capture-wiki rollup will
        // promote them to canonical on next pass).
        ai_who_to_slug: input.proposal.who_to_slug,
        ai_what: input.proposal.what,
        ai_by_when: input.proposal.by_when,
        // Hint for downstream triage / Enricher / UI badge. Task still lands
        // in inbox status — this is just where it WOULD belong after processing.
        ai_suggested_category: input.proposal.suggested_category,
        source_channel: input.sourceChannel,
        source_capture_id: input.sourceCaptureId,
      },
    }

    const payload: CreatePayload = {
      kind: 'create',
      task,
      traceback: {
        captureExcerpt: smartExcerpt(input.captureText, input.proposal.evidence_quote),
        sourceChannel: input.sourceChannel,
        sourceMeta: input.sourceMeta ?? null,
        evidenceQuote: input.proposal.evidence_quote || undefined,
        cuesDetected:
          input.proposal.cues_detected.length > 0 ? input.proposal.cues_detected : undefined,
        reasoningSteps:
          input.proposal.reasoning_steps.length > 0 ? input.proposal.reasoning_steps : undefined,
      },
    }

    const created = this.store.create({
      type: 'create',
      targetTaskIds: [],
      sourceAgent: SOURCE_AGENT_COMMITMENT_DETECTOR,
      sourceCaptureId: input.sourceCaptureId,
      payload,
      summary: input.proposal.reasoning.slice(0, 160),
    })

    return {
      proposalId: created.id,
      version: created.currentVersion,
      title,
      proposal: created,
    }
  }
}

function cleanTitle(proposedTitle: string): string {
  return proposedTitle
    .trim()
    .replace(/^\[AI\]\s*/i, '')
    .slice(0, 200)
}

function buildDescription(input: WriteProposalInput): string {
  // User-readable description that will land on the Mindwtr task body upon
  // apply. The traceback is stored separately on the proposal payload (and
  // exposed via the Proposals UI), so we only include human-relevant context
  // here — no `proposal-ai` tag mention, no [AI] prefix talk.
  const lines: string[] = []
  if (input.proposal.what && input.proposal.what !== input.proposal.title) {
    lines.push(input.proposal.what)
  }
  if (input.proposal.by_when) {
    lines.push(`Due: ${input.proposal.by_when}`)
  }
  if (input.proposal.who_to) {
    lines.push(`With/to: ${input.proposal.who_to}`)
  }
  return lines.join('\n')
}


// Stopwords are dropped from title normalization so dedup is robust against
// the LLM emitting "Send Alice X" vs "Send Alice the X" on consecutive ticks.
// Bag-of-words + sort makes word order irrelevant ("X to Alice" == "to Alice X").
const STOPWORDS_EN = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'with', 'for', 'to', 'in', 'on', 'at',
  'of', 'by', 'from', 'as', 'is', 'are', 'be', 'this', 'that', 'these', 'those',
])
const STOPWORDS_RU = new Set([
  'и', 'или', 'но', 'для', 'на', 'в', 'с', 'к', 'по', 'до', 'от', 'из', 'у', 'о',
  'об', 'про', 'через', 'над', 'под', 'это', 'эти', 'тот', 'та',
])

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS_EN.has(w) && !STOPWORDS_RU.has(w))
    .sort()
    .join(' ')
}

function buildSignature(title: string, whoTo: string | null, byWhen: string | null): string {
  return [normalize(title), normalize(whoTo ?? ''), normalize(byWhen ?? '')].join('|')
}

/** Build the same signature shape from a stored Proposal, or null when not a create. */
function signatureForRecord(p: ProposalRecord): string | null {
  const payload = p.currentPayload as ProposalPayload | null
  if (!payload || payload.kind !== 'create') return null
  const meta = payload.task.metadata as Record<string, unknown> | undefined
  const whoTo = typeof meta?.ai_who_to === 'string' ? meta.ai_who_to : null
  const byWhen = typeof meta?.ai_by_when === 'string' ? meta.ai_by_when : null
  return buildSignature(payload.task.title, whoTo, byWhen)
}
