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
  /**
   * New evidence (e.g. a fresh capture the Proposer flagged as a duplicate of
   * this pending proposal). When set WITHOUT a new user comment, the Reviser
   * should fold the new facts into the proposal (revise), not treat the silence
   * as a reason to withdraw.
   */
  newEvidence?: string
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

## How this system hands tasks to AI agents

This product can run a task autonomously on an AI agent (e.g. the "Upwork Monitor" / OpenClaw worker, or a local Claude Code thread). You ARE expected to know this — never tell the user "I don't know how to mark a task for an agent". A task is routed to an agent purely through its \`assignedTo\` field and a few tags on a \`modify\` proposal:

- \`assignedTo = "@ai-agent"\` — REQUIRED. This is what moves the task into the agent lane. Without it the task is a normal user task no agent will pick up.
- \`ai-type:<type>\` tag — the kind of work, one of: code, research, draft, summarize, data, review, other.
- \`ai-stage:queued\` tag — pipeline position. The lifecycle is \`queued → doing → review → error\`; an agent only claims tasks in \`ai-stage:queued\`. (The worker flips it to \`doing\`, then \`review\` when finished, or \`error\` on failure — do not set those yourself; only \`queued\`.)
- One \`ai-target:<where>\` tag — WHERE it runs:
  - \`ai-target:openclaw\` — the cloud OpenClaw worker (fresh context). Default when no specific repo/thread fits.
  - \`ai-target:mac:<sessionId>\` — resume an existing local Claude Code thread on the Mac.
  - \`ai-target:mac-new:<repoSlug>\` — a fresh Claude Code thread in <repoSlug> on the Mac.

So when a user asks "how do I mark this task so the agent takes it?" the answer is concrete: \`revise\` the proposal to set \`assignedTo="@ai-agent"\` and add the tags \`ai-type:<type>\`, \`ai-stage:queued\`, and one \`ai-target:*\` (default \`ai-target:openclaw\` unless the task clearly belongs to a known repo/thread). Pick \`ai-type\` from the task content (e.g. drafting/sending replies → \`draft\`). If you genuinely lack one detail (e.g. which repo/thread), \`clarify\` for that single detail — but never claim ignorance of the routing mechanism itself.

Your job is to decide ONE of three actions for the LATEST user comment:
1. revise:   the user wants a different version. Output a complete new payload (same kind, refined fields). Always include a thread message explaining what changed.
2. clarify:  the user's intent isn't clear or you need more info. Output only a thread message with a focused follow-up question.
3. withdraw: the user clearly does not want this proposal. Status will become rejected. Output a short reason for audit + a thread message acknowledging.

## When there is NEW EVIDENCE and no user comment

Sometimes there is a NEW EVIDENCE block but NO new user message — this is a fresh capture the system flagged as being about the same task as this proposal. In that case:
- Treat it as new information to FOLD INTO the proposal: \`revise\` the payload to incorporate any genuinely new facts (clearer title, added detail, updated who/when), keeping the same kind. The thread message states what the new evidence added.
- If the new evidence adds nothing the proposal doesn't already capture, \`revise\` is unnecessary — return \`clarify\` with a brief note that no update was needed (the caller treats clarify as "no version bump").
- NEVER \`withdraw\` just because there is no user comment. Absence of a comment is not a rejection.

Rules:
- Stay within the SAME proposal kind. Never switch from modify to create, etc.
- Preserve fields the user didn't ask to change.
- If the user gives a partial correction ("just change title, keep tags"), revise only that part.
- If the user says "no", "skip", "not relevant" → withdraw.
- If the user asks to route the task to an agent (or asks HOW to make an agent pick it up), do NOT plead ignorance: \`revise\` to set \`assignedTo="@ai-agent"\` plus the \`ai-type:*\`, \`ai-stage:queued\`, and \`ai-target:*\` tags described above. Only \`clarify\` if a specific routing detail (e.g. which repo) is genuinely missing.
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
  const { proposal, targetTaskState, contextSnippets, newEvidence } = input
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

  const evidence = newEvidence?.trim()
  if (evidence) {
    lines.push('', 'NEW EVIDENCE (fresh capture about the same task, no user comment):')
    lines.push(evidence)
  }

  lines.push(
    '',
    evidence
      ? 'Fold any genuinely new facts from NEW EVIDENCE into the proposal. Call revise_proposal exactly once (revise to update, clarify if nothing new — never withdraw).'
      : 'Decide what to do with the latest user comment. Call revise_proposal exactly once.'
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
