/**
 * Proposer — LLM call that decides whether a captured passive item contains
 * an actionable item the user would want in their GTD inbox.
 *
 * Three things matter that simple "is this a task?" classifiers miss:
 *   1) Role disambiguation — captured screen text often contains promises by
 *      OTHER people, or messages BY the user TO others. The proposer needs to
 *      identify whose obligation it is.
 *   2) Action vs description — "I should pay the invoice" is actionable;
 *      "the invoice was paid" is reference info, not a task.
 *   3) Be conservative — false positives spam the inbox. When in doubt, say no.
 *
 * Output is structured (LLM tool calling) so callers don't parse free text.
 */

import type { LLMClient } from '../ai/client'

export type WhoOwes = 'user' | 'other' | 'unclear'

export interface Proposal {
  is_actionable: boolean
  title: string
  who_owes: WhoOwes
  who_to: string | null
  what: string
  by_when: string | null
  confidence: number
  reasoning: string
}

const PROPOSER_TOOL = {
  type: 'function',
  function: {
    name: 'propose_inbox_item',
    description:
      'Decide whether a captured passive item (screen OCR, audio transcript, etc.) contains an actionable commitment for the USER. If yes, propose a short title.',
    parameters: {
      type: 'object',
      properties: {
        is_actionable: {
          type: 'boolean',
          description:
            'True ONLY when the user has a concrete obligation, decision, or commitment that they need to act on. False for: code/UI/chats unrelated to user, observations about other people, ambient browsing, ads, news, things already done.',
        },
        title: {
          type: 'string',
          description:
            'Short imperative title (≤120 chars). Empty string if is_actionable=false. Should look like a normal GTD next action: "Pay Acme invoice", "Reply to Alice about Q4 plan", "Send weekly report".',
        },
        who_owes: {
          type: 'string',
          enum: ['user', 'other', 'unclear'],
          description:
            'Whose obligation is this? user = the person whose machine the capture came from. other = someone else (skip — not actionable for user). unclear = ambiguous (still consider actionable only if user is most likely target).',
        },
        who_to: {
          type: 'string',
          description:
            'Who the action involves (recipient/counterparty). E.g. "Alice", "wife", "my team". Empty string when not applicable.',
        },
        what: {
          type: 'string',
          description:
            'One-sentence description of the action. Distinct from title — title is the GTD next action, what is the underlying commitment in plain language.',
        },
        by_when: {
          type: 'string',
          description:
            'Deadline if mentioned (ISO date YYYY-MM-DD or natural like "tomorrow", "Friday"). Empty string when not specified.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Confidence 0..1. 0.85+ obvious actionable. 0.6-0.85 probably actionable. <0.6 do not propose (set is_actionable=false).',
        },
        reasoning: {
          type: 'string',
          description:
            'One sentence explaining the decision. Reference the cue you saw ("user typed I will send X to Y", "screen showed invoice with due date").',
        },
      },
      required: [
        'is_actionable',
        'title',
        'who_owes',
        'who_to',
        'what',
        'by_when',
        'confidence',
        'reasoning',
      ],
    },
  },
} as const

const PROPOSER_PROMPT = `You triage passive captures (screen OCR, audio transcripts) for a GTD inbox.

The capture is what was visible/audible to the user. Most captures are NOT actionable:
ambient browsing, code on screen, chat history, idle UI, marketing, conversations the
user is not part of. Default to is_actionable=false.

Mark is_actionable=true ONLY when:
- The USER explicitly committed to do something ("I'll send X to Y", "I'll review the PR")
- A concrete request arrived FOR the user that needs response
  ("Alice: can you review my PR?", "Boss: please approve invoice")
- A bill, invoice, or payment with a due date addressed to the user
- A meeting/event with date AND user is required attendee
- A bug/issue assigned to the user that needs follow-up

NOT actionable (be ruthless):
- Code, terminals, IDE windows, IDE chat with another AI agent
- Reading articles/docs, twitter/news feeds
- Generic UI: settings, file browsers, dashboards
- Conversations between OTHER people
- Past tense: "X was done", "I sent it" — already done, no action
- Marketing, ads, promo emails, newsletters
- Mentions in a group chat that don't address the user directly

Role disambiguation (who_owes):
- "user" = obligation belongs to the user (their machine, they typed it, addressed to them)
- "other" = obligation belongs to someone else seen in the capture (skip — not actionable for user)
- "unclear" = ambiguous (only mark actionable if context clearly suggests the user)

Title format (when actionable): short imperative GTD next action.
- Good: "Pay Acme invoice", "Reply to Alice re Q4 plan", "Send weekly report"
- Bad: "Invoice from Acme is due", "Got message from Alice"

When uncertain, lean toward is_actionable=false.

Always call propose_inbox_item with all fields filled (use empty string when N/A).`

export class Proposer {
  constructor(
    private llm: LLMClient,
    private model?: string
  ) {}

  async propose(text: string, sourceMeta?: Record<string, unknown>): Promise<Proposal> {
    const userMessage = sourceMeta
      ? `Capture context: ${JSON.stringify(sourceMeta)}\n\nText:\n${text}`
      : `Text:\n${text}`

    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: PROPOSER_PROMPT },
        { role: 'user', content: userMessage },
      ],
      tools: [PROPOSER_TOOL],
      tool_choice: 'required',
      temperature: 0.1,
      max_tokens: 800,
      model: this.model,
    })

    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (!toolCall) {
      throw new Error('Proposer: LLM did not return tool call')
    }

    let parsed: Partial<Proposal>
    try {
      parsed = JSON.parse(toolCall.function.arguments) as Partial<Proposal>
    } catch (err) {
      throw new Error(`Proposer: failed to parse tool call args: ${(err as Error).message}`)
    }

    return {
      is_actionable: Boolean(parsed.is_actionable),
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 120) : '',
      who_owes: ['user', 'other', 'unclear'].includes(parsed.who_owes as string)
        ? (parsed.who_owes as WhoOwes)
        : 'unclear',
      who_to: typeof parsed.who_to === 'string' && parsed.who_to.length > 0 ? parsed.who_to : null,
      what: typeof parsed.what === 'string' ? parsed.what : '',
      by_when: typeof parsed.by_when === 'string' && parsed.by_when.length > 0 ? parsed.by_when : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    }
  }
}
