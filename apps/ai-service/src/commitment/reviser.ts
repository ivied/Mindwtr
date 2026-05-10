/**
 * Reviser — LLM call that updates a Proposal in response to a user comment.
 *
 * Triggered by the comment handler whenever a user posts a message on a
 * pending proposal. Outputs one of three actions:
 *   - revise:    new payload (creates a new proposal_versions row)
 *   - clarify:   plain agent message asking for more info, no version bump
 *   - withdraw:  agent has decided proposal isn't worth pursuing → status=rejected
 *
 * The output is structured (LLM tool calling) so the handler can dispatch
 * without parsing free text.
 */

import type { LLMClient } from '../ai/client'
import type {
  ProposalDetail,
  ProposalMessageRecord,
} from '../proposal-store/types'

export type ReviseOutcome =
  | { kind: 'revise'; newPayload: unknown; summary: string; agentMessage: string }
  | { kind: 'clarify'; agentMessage: string }
  | { kind: 'withdraw'; reason: string; agentMessage: string }

export interface ReviseInput {
  proposal: ProposalDetail
  /**
   * Snapshot of target task(s) at the time of revision. Empty for create.
   * Plain JSON shape passed straight to the LLM.
   */
  targetTaskState: Record<string, unknown>[]
  /** Retrieved Context Store hits relevant to the proposal/thread (free-form text). */
  contextSnippets: string[]
}

const REVISER_TOOL = {
  type: 'function',
  function: {
    name: 'revise_proposal',
    description:
      'Decide what to do with a pending proposal in response to the latest user comment. Choose exactly one action: revise (update the payload), clarify (ask the user a follow-up question without changing the payload), or withdraw (cancel the proposal because the user no longer wants it).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['revise', 'clarify', 'withdraw'] },
        new_payload: {
          type: 'object',
          description:
            'Required when action=revise. The full updated proposal payload (same JSON shape as currentPayload). Must keep the same kind/type. Omit (use empty object) for clarify/withdraw.',
        },
        summary: {
          type: 'string',
          description:
            'Required when action=revise. One-line description of WHAT changed, not why. Empty string for clarify/withdraw.',
        },
        agent_message: {
          type: 'string',
          description:
            'Plain message from the agent to the user, posted into the thread. For revise: explain in 1-2 sentences what was changed and why. For clarify: ask the question. For withdraw: explain why the proposal is being withdrawn.',
        },
        reason: {
          type: 'string',
          description:
            'Required when action=withdraw. Short reason recorded in audit (e.g. "user said no", "user clarified target was unrelated"). Empty for revise/clarify.',
        },
      },
      required: ['action', 'new_payload', 'summary', 'agent_message', 'reason'],
    },
  },
} as const

const REVISER_PROMPT = `You are an AI assistant that maintains GTD proposals in a dialogue with the user.

A proposal can be in one of these types:
- create:  brand-new task to add to the inbox
- modify:  edit an existing task (field-level diff)
- delete:  remove an existing task
- move:    move a task to a different project
- merge:   combine multiple tasks into one
- split:   break one task into several

You see the proposal payload, all prior versions, the full message thread, current state of any target tasks, and a few relevant snippets from the user's context store.

Your job is to decide ONE of three actions for the LATEST user comment:
1. revise:   the user wants a different version. Output a complete new payload (same kind, refined fields). Always include a thread message explaining what changed.
2. clarify:  the user's intent isn't clear or you need more info. Output only a thread message with a focused follow-up question.
3. withdraw: the user clearly does not want this proposal. Status will become rejected. Output a short reason for audit + a thread message acknowledging.

Rules:
- Stay within the SAME proposal kind. Never switch from modify to create, etc.
- Preserve fields the user didn't ask to change.
- If the user gives a partial correction ("just change title, keep tags"), revise only that part.
- If the user says "no", "skip", "not relevant" → withdraw.
- If unsure between revise and clarify, prefer clarify — don't guess.
- Be brief in agent_message: 1-2 sentences, no preamble, no apologies.

Always call revise_proposal with all fields filled (use empty string / empty object when N/A).`

export class Reviser {
  constructor(
    private llm: LLMClient,
    private model?: string
  ) {}

  async revise(input: ReviseInput): Promise<ReviseOutcome> {
    const userBlock = buildUserBlock(input)
    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: REVISER_PROMPT },
        { role: 'user', content: userBlock },
      ],
      tools: [REVISER_TOOL],
      tool_choice: 'required',
      temperature: 0.1,
      max_tokens: 1500,
      model: this.model,
    })

    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (!toolCall) throw new Error('Reviser: LLM did not return tool call')

    let parsed: {
      action?: string
      new_payload?: unknown
      summary?: unknown
      agent_message?: unknown
      reason?: unknown
    }
    try {
      parsed = JSON.parse(toolCall.function.arguments)
    } catch (err) {
      throw new Error(`Reviser: failed to parse args: ${(err as Error).message}`)
    }

    const agentMessage = typeof parsed.agent_message === 'string' ? parsed.agent_message.trim() : ''
    if (!agentMessage) throw new Error('Reviser: agent_message is required')

    switch (parsed.action) {
      case 'revise': {
        const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
        const newPayload = parsed.new_payload
        if (!newPayload || typeof newPayload !== 'object') {
          throw new Error('Reviser: revise action requires new_payload object')
        }
        return { kind: 'revise', newPayload, summary, agentMessage }
      }
      case 'clarify':
        return { kind: 'clarify', agentMessage }
      case 'withdraw': {
        const reason = typeof parsed.reason === 'string' ? parsed.reason : 'agent withdraw'
        return { kind: 'withdraw', reason, agentMessage }
      }
      default:
        throw new Error(`Reviser: unknown action ${String(parsed.action)}`)
    }
  }
}

function buildUserBlock(input: ReviseInput): string {
  const { proposal, targetTaskState, contextSnippets } = input
  const lines: string[] = []
  lines.push(`Proposal id: ${proposal.id}`)
  lines.push(`Type: ${proposal.type}`)
  lines.push(`Source agent: ${proposal.sourceAgent}`)
  lines.push(`Current version: ${proposal.currentVersion}`)
  lines.push('Current payload:')
  lines.push(JSON.stringify(proposal.currentPayload, null, 2))

  if (targetTaskState.length > 0) {
    lines.push('', 'Target task(s) current state:')
    lines.push(JSON.stringify(targetTaskState, null, 2))
  }

  if (proposal.versions.length > 1) {
    lines.push('', 'Version history (oldest → newest):')
    for (const v of proposal.versions) {
      lines.push(`  v${v.version} (${v.author})${v.summary ? `: ${v.summary}` : ''}`)
    }
  }

  if (contextSnippets.length > 0) {
    lines.push('', 'Relevant context store snippets:')
    for (const snip of contextSnippets) lines.push(`- ${snip}`)
  }

  if (proposal.messages.length > 0) {
    lines.push('', 'Thread (oldest → newest):')
    for (const m of proposal.messages) lines.push(`  [${m.role}] ${m.text}`)
  }

  lines.push(
    '',
    'Decide what to do with the latest user comment. Call revise_proposal exactly once.'
  )
  return lines.join('\n')
}

/** Convenience helper for callers that build a synthetic thread tail. */
export function lastUserMessage(messages: ProposalMessageRecord[]): ProposalMessageRecord | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') return m
  }
  return null
}
