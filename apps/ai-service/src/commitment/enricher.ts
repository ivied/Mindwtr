/**
 * Enricher — LLM call that enriches a user-entered inbox card into a full
 * GTD proposal (title rewrite + category + contexts + tags + project decision
 * with sub-actions + SMART fields).
 *
 * Compared to Proposer (which decides whether a passive capture is a commitment
 * at all, defaulting to false), Enricher assumes the user explicitly added
 * the card — actionable=true is the default, and the work is structuring it
 * properly rather than gatekeeping.
 *
 * Output is a structured tool-call payload so callers can build a Proposal
 * (type=modify for single-step, type=split for projects) without free-text parsing.
 */

import type { LLMClient } from '../ai/client'
import type { GtdCategory } from '../ai/types'

export interface SubAction {
  title: string
  suggested_category: GtdCategory
}

export interface SmartFields {
  /** One-sentence outcome statement: what "done" looks like. */
  specific: string
  /** Deadline string ("Friday", ISO date, or "no deadline"). */
  time_bound: string
  /** Completion criteria. For next-actions, may equal `specific`. */
  measurable: string
}

export interface EnrichedProposal {
  is_actionable: boolean
  proposed_title: string
  category: GtdCategory
  suggested_contexts: string[]
  suggested_tags: string[]
  is_project: boolean
  project_name: string
  sub_actions: SubAction[]
  smart: SmartFields
  is_noise: boolean
  noise_reason: string
  is_delegation: boolean
  delegate_to: string
  confidence: number
  reasoning: string
}

const VALID_CATEGORIES: GtdCategory[] = [
  'next',
  'waiting',
  'someday',
  'reference',
  'two_minute',
]

const ENRICHER_TOOL = {
  type: 'function',
  function: {
    name: 'enrich_inbox_card',
    description:
      'Enrich a user-entered inbox card by suggesting a GTD-standard title, category, contexts, tags, and (for multi-step items) a project name with 1-3 first next-actions. Always populate SMART fields.',
    parameters: {
      type: 'object',
      properties: {
        is_actionable: {
          type: 'boolean',
          description:
            'True by default — the user explicitly added this card. False only when the text is clearly non-actionable (a quote saved for reference, an obvious mistake/junk).',
        },
        proposed_title: {
          type: 'string',
          description:
            'Rewrite of the card title in GTD next-action form: imperative verb + concrete object (≤120 chars). Examples: "Pay Acme invoice", "Text nanny about Saturday 7pm", "Renew GoDaddy domain". If the original is already a good GTD next action, return it unchanged. Keep the language of the original text.',
        },
        category: {
          type: 'string',
          enum: ['next', 'waiting', 'someday', 'reference', 'two_minute'],
          description:
            'GTD category. Decision order top-down: two_minute (<2 min) → waiting (blocked on someone) → someday (vague aspiration) → reference (info only) → next (everything else actionable).',
        },
        is_project: {
          type: 'boolean',
          description:
            'True if completing this requires multiple steps (e.g. "renovate bathroom", "plan birthday party", "set up new laptop", "find new dentist"). False for single-step actions.',
        },
        project_name: {
          type: 'string',
          description:
            'Project name (≤80 chars) if is_project=true. Noun phrase, not imperative. E.g. "Bathroom renovation", "Kid 5th birthday party". Empty string when is_project=false.',
        },
        sub_actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Imperative-form title for the next-action (≤120 chars).',
              },
              suggested_category: {
                type: 'string',
                enum: ['next', 'two_minute', 'waiting'],
                description: 'Category for this sub-action. Usually "next" or "two_minute".',
              },
            },
            required: ['title', 'suggested_category'],
          },
          description:
            'When is_project=true, propose 1-3 concrete first next-actions for the project. Ordered: first item is what to do first. Return [] when is_project=false.',
        },
        suggested_contexts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'GTD contexts prefixed with @ (e.g. @home, @work, @errands, @phone, @computer, @anywhere). PREFER matching contexts the user already uses (see "Past similar items" in input) over inventing new ones.',
        },
        suggested_tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Free-form tags. PREFER reusing tags the user has applied to similar past items. Do not invent ad-hoc labels.',
        },
        smart: {
          type: 'object',
          properties: {
            specific: {
              type: 'string',
              description:
                'One-sentence outcome: what does "done" mean? Always required. E.g. "Nanny confirmed for Saturday 7pm", "Domain auto-renewal enabled for 1 year".',
            },
            time_bound: {
              type: 'string',
              description:
                'Deadline as ISO YYYY-MM-DD or natural ("Friday", "this week"). Use "no deadline" when none applies.',
            },
            measurable: {
              type: 'string',
              description:
                'How will the user know it is done? Required for is_project=true (concrete completion criteria, e.g. "all rooms repainted, contractor paid in full"). For single-step actions may restate `specific`.',
            },
          },
          required: ['specific', 'time_bound', 'measurable'],
        },
        is_noise: {
          type: 'boolean',
          description:
            'True if the entry looks like accidentally captured clipboard junk, a forward the user did not mean to add, or marketing content. Conservatively false for real user notes.',
        },
        noise_reason: {
          type: 'string',
          description: 'Short reason if is_noise=true. Empty string otherwise.',
        },
        is_delegation: {
          type: 'boolean',
          description: 'True if the user is waiting on someone else\'s output.',
        },
        delegate_to: {
          type: 'string',
          description: 'Person/team being waited on (when is_delegation=true). Empty string otherwise.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Overall confidence in this enrichment (0..1).',
        },
        reasoning: {
          type: 'string',
          description: 'One sentence explaining the main category + project decision.',
        },
      },
      required: [
        'is_actionable',
        'proposed_title',
        'category',
        'is_project',
        'project_name',
        'sub_actions',
        'suggested_contexts',
        'suggested_tags',
        'smart',
        'is_noise',
        'noise_reason',
        'is_delegation',
        'delegate_to',
        'confidence',
        'reasoning',
      ],
    },
  },
} as const

const ENRICHER_PROMPT = `You enrich inbox cards that the user explicitly added (typed in Telegram, pasted, dictated). They mean it: default to is_actionable=true.

Job:
1. Rewrite the title in GTD next-action form: imperative verb + concrete object. "Call nanny about Saturday" — not "nanny on Saturday". Keep the language of the original text. If the original is already a good GTD next action, keep it.
2. Classify by GTD category, decision order top-down:
   - TWO_MINUTE: < 2 min (single phone call, send one message, pay one bill online, add event to calendar, yes/no reply). Be generous here.
   - WAITING: user is blocked on someone else's deliverable. Set is_delegation=true.
   - SOMEDAY: vague aspiration, no concrete commitment yet ("learn Spanish someday").
   - REFERENCE: pure info kept for lookup (a phone number, an address).
   - NEXT: everything else actionable that takes >2 min.
3. is_project = TRUE when finishing requires multiple steps:
   - "renovate bathroom", "plan birthday party", "set up new laptop", "find new dentist", "redesign landing page".
   When TRUE, also propose 1-3 first next-actions in sub_actions (ordered: first item = what to do first). Each sub-action is itself an imperative next-action with its own category.
4. SMART fields — always fill all three:
   - specific: one-sentence "done" outcome. ALWAYS.
   - time_bound: deadline ("Friday", "2026-05-15", or "no deadline" when none).
   - measurable: how to know it is done. For next-actions, restate specific. For projects, list the concrete completion criteria.
5. Contexts and tags — PREFER existing ones the user already uses. The user message may include a "Past similar items" block — match its contexts/tags rather than inventing labels.

Quality bar:
- Title ≤ 120 chars. Imperative. No hashtags. No emojis.
- "позвать няню на субботу" → proposed_title "Написать няне про субботу", category "two_minute", specific "Няня подтвердила субботу", time_bound "Saturday".
- "renovate bathroom" → is_project=true, project_name "Bathroom renovation", sub_actions: [{title:"Measure bathroom and list required works", suggested_category:"next"}, {title:"Get 3 contractor quotes", suggested_category:"next"}].
- Mixed-language input is fine — keep titles in the source language.

Edge cases:
- One word or unparseable text: confidence < 0.5, is_actionable=true (user added it for a reason), category="next", proposed_title=original text.
- Pure quote/URL/snippet with no commitment hint: is_noise=true OR category="reference" — use your judgement.

Always call enrich_inbox_card with all required fields. Use empty string / empty array / "no deadline" when a field does not apply — never omit fields.`

export class Enricher {
  constructor(
    private llm: LLMClient,
    private model?: string
  ) {}

  async enrich(
    text: string,
    options: { sourceMeta?: Record<string, unknown>; priorContext?: string } = {}
  ): Promise<EnrichedProposal> {
    const userMessage = this.buildUserMessage(text, options)

    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: ENRICHER_PROMPT },
        { role: 'user', content: userMessage },
      ],
      tools: [ENRICHER_TOOL],
      tool_choice: 'required',
      temperature: 0.2,
      max_tokens: 1200,
      model: this.model,
    })

    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (!toolCall) {
      throw new Error('Enricher: LLM did not return tool call')
    }

    let parsed: Partial<EnrichedProposal>
    try {
      parsed = JSON.parse(toolCall.function.arguments) as Partial<EnrichedProposal>
    } catch (err) {
      throw new Error(`Enricher: failed to parse tool call args: ${(err as Error).message}`)
    }

    return normalize(parsed)
  }

  private buildUserMessage(
    text: string,
    options: { sourceMeta?: Record<string, unknown>; priorContext?: string }
  ): string {
    const parts: string[] = []
    if (options.sourceMeta && Object.keys(options.sourceMeta).length > 0) {
      parts.push(`Source context: ${JSON.stringify(options.sourceMeta)}`)
    }
    if (options.priorContext && options.priorContext.length > 0) {
      parts.push(`Past similar items:\n${options.priorContext}`)
    }
    parts.push(`Card text:\n${text}`)
    return parts.join('\n\n')
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return []
  return (v.filter((s) => typeof s === 'string' && s.length > 0) as string[]).slice(0, max)
}

function normalize(parsed: Partial<EnrichedProposal>): EnrichedProposal {
  const category = VALID_CATEGORIES.includes(parsed.category as GtdCategory)
    ? (parsed.category as GtdCategory)
    : 'next'

  const smartRaw = (parsed.smart && typeof parsed.smart === 'object'
    ? parsed.smart
    : {}) as Partial<SmartFields>
  const smart: SmartFields = {
    specific: asString(smartRaw.specific),
    time_bound: asString(smartRaw.time_bound) || 'no deadline',
    measurable: asString(smartRaw.measurable),
  }

  const subActionsRaw = Array.isArray(parsed.sub_actions) ? parsed.sub_actions : []
  const sub_actions: SubAction[] = subActionsRaw
    .map((sa) => {
      const obj = (sa ?? {}) as Partial<SubAction>
      const title = asString(obj.title).slice(0, 120)
      if (!title) return null
      const sc = obj.suggested_category as GtdCategory | undefined
      const suggested_category: GtdCategory = VALID_CATEGORIES.includes(sc as GtdCategory)
        ? (sc as GtdCategory)
        : 'next'
      return { title, suggested_category }
    })
    .filter((x): x is SubAction => x !== null)
    .slice(0, 5)

  return {
    is_actionable: parsed.is_actionable !== false,
    proposed_title: asString(parsed.proposed_title).slice(0, 120),
    category,
    suggested_contexts: asStringArray(parsed.suggested_contexts, 10),
    suggested_tags: asStringArray(parsed.suggested_tags, 20),
    is_project: parsed.is_project === true,
    project_name: asString(parsed.project_name).slice(0, 80),
    sub_actions,
    smart,
    is_noise: parsed.is_noise === true,
    noise_reason: asString(parsed.noise_reason),
    is_delegation: parsed.is_delegation === true,
    delegate_to: asString(parsed.delegate_to),
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0,
    reasoning: asString(parsed.reasoning),
  }
}
