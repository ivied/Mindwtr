/**
 * Proposer — first-pass AI for passive captures (screen, ambient).
 *
 * Asks the LLM: "is there anything actionable in this captured snapshot?"
 * If yes, returns a short proposed title + reason. The result is shown to the
 * user as a TG approval card; only on approve does it flow into the regular
 * classification queue.
 */

import type { LLMClient } from './client'

export interface Proposal {
  is_actionable: boolean
  title: string
  reasoning: string
  confidence: number
}

const PROPOSER_TOOL = {
  type: 'function',
  function: {
    name: 'propose_inbox_item',
    description:
      'Decide whether a captured screen snapshot contains an actionable item the user would want in their GTD inbox. If yes, propose a short title.',
    parameters: {
      type: 'object',
      properties: {
        is_actionable: {
          type: 'boolean',
          description:
            'True only when there is a concrete task, decision, commitment, or reminder visible. False for ambient browsing, code on screen, chat history, news feeds, ads, idle UI.',
        },
        title: {
          type: 'string',
          description:
            'Short imperative title (≤120 chars). Empty string if is_actionable=false.',
        },
        reasoning: {
          type: 'string',
          description: 'One sentence explaining the decision.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0..1 in the actionable decision.',
        },
      },
      required: ['is_actionable', 'title', 'reasoning', 'confidence'],
    },
  },
} as const

const PROPOSER_PROMPT = `You triage passive screen captures for a GTD inbox.

The capture is OCR text from whatever the user was looking at. Most of the time
it's NOT actionable: code on screen, chat history with yourself, browsing news,
reading docs, idle apps. Default to is_actionable=false.

Mark is_actionable=true ONLY when the capture clearly contains:
- An explicit task or commitment ("I need to...", "Don't forget to...")
- A decision the user is being asked to make
- A meeting/event with date and details
- A bill, invoice, or payment due
- A bug/issue that needs follow-up
- A request from someone (email, message) requiring action

NOT actionable (be ruthless):
- Code, terminals, IDE chat history
- Reading articles, docs, twitter/news feeds
- Generic UI: settings, file browsers, dashboards
- Conversations the user is having WITH AN AGENT (like this chat)
- Marketing, ads, promo emails
- Static reference info already saved elsewhere

Title (when actionable): short imperative ("Pay invoice from Acme", "Reply
to Alice about Q4 plan"). NOT a description of what's on screen.

Confidence:
- 0.85+: clearly actionable, obvious
- 0.6-0.85: probably actionable but ambiguous
- <0.6: skip (set is_actionable=false even if you're unsure)

Always call propose_inbox_item.`

export class Proposer {
  constructor(private llm: LLMClient) {}

  async propose(text: string, sourceMeta?: Record<string, unknown>): Promise<Proposal> {
    const userMessage = sourceMeta
      ? `Capture context: ${JSON.stringify(sourceMeta)}\n\nOCR/text:\n${text}`
      : `OCR/text:\n${text}`

    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: PROPOSER_PROMPT },
        { role: 'user', content: userMessage },
      ],
      tools: [PROPOSER_TOOL],
      tool_choice: 'required',
      temperature: 0.1,
      max_tokens: 800,
    })

    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (!toolCall) {
      throw new Error('Proposer: LLM did not return tool call')
    }
    const parsed = JSON.parse(toolCall.function.arguments) as Partial<Proposal>
    return {
      is_actionable: Boolean(parsed.is_actionable),
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 120) : '',
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    }
  }
}
