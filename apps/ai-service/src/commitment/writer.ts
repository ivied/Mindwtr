/**
 * Proposal Writer — turns an actionable Proposal into a Mindwtr inbox task.
 *
 * The task carries enough metadata for later feedback loops:
 *   - tag `proposal-ai` so user can filter
 *   - title prefix `[AI]` so it's visually obvious in any inbox view
 *   - description includes traceback (capture excerpt + AI reasoning) so user
 *     understands WHY this was proposed without leaving the task view
 *   - metadata.ai_proposal=true marks the task as awaiting decision
 *   - metadata.source_capture_id links back to Context Store for forensics
 */

import type { MindwtrClient } from '../api/mindwtr-client'
import type { Proposal } from './proposer'

export interface WriteProposalInput {
  proposal: Proposal
  /** Original capture text (used in traceback) */
  captureText: string
  /** ID of the Context Store capture that produced this proposal */
  sourceCaptureId: string
  /** Source channel for context (e.g. screen_capture) */
  sourceChannel: string
  /** Optional metadata from capture (window title, app, etc.) */
  sourceMeta?: Record<string, unknown> | null
}

export interface WriteProposalResult {
  /** Mindwtr task id */
  taskId: string
  /** What ended up as the task title (with [AI] prefix) */
  title: string
}

const PROPOSAL_TAG = 'proposal-ai'
const TITLE_PREFIX = '[AI] '
const TRACEBACK_EXCERPT_LENGTH = 500

export class ProposalWriter {
  constructor(private mindwtr: MindwtrClient) {}

  async write(input: WriteProposalInput): Promise<WriteProposalResult> {
    const title = this.buildTitle(input.proposal.title)
    const description = this.buildDescription(input)

    const task = await this.mindwtr.createTask({
      title,
      status: 'inbox',
      tags: [PROPOSAL_TAG],
      description,
      metadata: {
        ai_proposal: true,
        ai_confidence: input.proposal.confidence,
        ai_reasoning: input.proposal.reasoning,
        ai_who_owes: input.proposal.who_owes,
        ai_who_to: input.proposal.who_to,
        ai_what: input.proposal.what,
        ai_by_when: input.proposal.by_when,
        source_channel: input.sourceChannel,
        source_capture_id: input.sourceCaptureId,
        awaiting_decision: true,
      },
    })

    return { taskId: task.id, title: task.title }
  }

  private buildTitle(proposedTitle: string): string {
    const clean = proposedTitle.trim().replace(/^\[AI\]\s*/i, '')
    return `${TITLE_PREFIX}${clean}`.slice(0, 200)
  }

  private buildDescription(input: WriteProposalInput): string {
    const lines = [
      `**AI proposal** (confidence ${(input.proposal.confidence * 100).toFixed(0)}%)`,
      '',
      `**Reasoning:** ${input.proposal.reasoning}`,
    ]

    if (input.proposal.what && input.proposal.what !== input.proposal.title) {
      lines.push(`**What:** ${input.proposal.what}`)
    }
    if (input.proposal.by_when) {
      lines.push(`**By:** ${input.proposal.by_when}`)
    }
    if (input.proposal.who_to) {
      lines.push(`**With/to:** ${input.proposal.who_to}`)
    }

    lines.push('', `**Source:** ${input.sourceChannel}`)
    const sourceMetaSummary = formatMeta(input.sourceMeta)
    if (sourceMetaSummary) lines.push(`**Context:** ${sourceMetaSummary}`)

    lines.push('', '**Captured text:**', '```', this.excerpt(input.captureText), '```')
    lines.push(
      '',
      `_Approve: remove the \`${PROPOSAL_TAG}\` tag (and the [AI] prefix). Reject: delete the task._`
    )
    return lines.join('\n')
  }

  private excerpt(text: string): string {
    if (text.length <= TRACEBACK_EXCERPT_LENGTH) return text
    return `${text.slice(0, TRACEBACK_EXCERPT_LENGTH)}…`
  }
}

function formatMeta(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return ''
  const parts: string[] = []
  if (typeof meta.app === 'string') parts.push(`app=${meta.app}`)
  if (typeof meta.windowTitle === 'string') parts.push(`window=${meta.windowTitle}`)
  if (typeof meta.url === 'string') parts.push(`url=${meta.url}`)
  if (typeof meta.from === 'string') parts.push(`from=${meta.from}`)
  return parts.join(' · ')
}
