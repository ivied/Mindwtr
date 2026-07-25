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

export type AiTaskType =
  | 'code'
  | 'research'
  | 'draft'
  | 'summarize'
  | 'data'
  | 'review'
  | 'other'

export interface EnrichedProposal {
  is_actionable: boolean
  proposed_title: string
  /**
   * A short, self-contained description so the task carries enough context
   * to act on later — without re-reading the original capture. Restates the
   * goal in 1-3 sentences, folds in any concrete detail the Enricher saw
   * (who/what/when, named entities, the source channel). Empty string only
   * when the title is already fully self-explanatory.
   */
  proposed_description: string
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
  /**
   * Whether this task could be handed off to an AI agent rather than
   * executed by the user. When true, the apply step routes it to the
   * agent lane (assignedTo='@ai-agent'); the user reviews the suggestion
   * via a dedicated badge in the UI and can accept or reject independently.
   */
  is_ai_routable: boolean
  ai_task_type: AiTaskType
  ai_routing_reasoning: string
  /**
   * Free-text hint for WHERE an AI-routable task should run, lifted from a
   * matching KNOWN_PLAYBOOK entry (tool / repo / session it names, e.g.
   * "Upwork Monitor", "openclaw", a repo slug). The pipeline feeds this into
   * the deterministic target matcher; empty string when no playbook signal.
   */
  ai_target_hint: string
  confidence: number
  reasoning: string
}

const VALID_AI_TASK_TYPES: AiTaskType[] = [
  'code',
  'research',
  'draft',
  'summarize',
  'data',
  'review',
  'other',
]

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
        proposed_description: {
          type: 'string',
          description:
            'A self-contained description (1-3 sentences, ≤600 chars) that gives the task enough context to act on later WITHOUT re-reading the original source. Fold in concrete details you can see in the input: named people/projects/tools, what specifically is wanted, any deadline or constraint, and where it came from. Use the context blocks (past-similar / temporal) when relevant. If the task is ambiguous, state your best interpretation and what is unclear. Write in the language of the original text. Return empty string ONLY when the title is already fully self-explanatory (e.g. "Buy milk").',
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
              // NOT named `title` — see the note in proposer.ts: the router's
              // Gemini schema conversion eats properties called `title`, which
              // silently emptied every sub-action here.
              action_title: {
                type: 'string',
                description: 'Imperative-form title for the next-action (≤120 chars).',
              },
              suggested_category: {
                type: 'string',
                enum: ['next', 'two_minute', 'waiting'],
                description: 'Category for this sub-action. Usually "next" or "two_minute".',
              },
            },
            required: ['action_title', 'suggested_category'],
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
        is_ai_routable: {
          type: 'boolean',
          description:
            'True if this task could realistically be delegated to a generalist AI agent (one that has tools for web search, code editing, file I/O, drafting text, calling APIs) WITHOUT requiring secrets the agent does not have, physical action, or the user\'s personal judgment. False when the task needs the user IRL or hinges on their specific opinion/context.',
        },
        ai_task_type: {
          type: 'string',
          enum: ['code', 'research', 'draft', 'summarize', 'data', 'review', 'other'],
          description:
            'When is_ai_routable=true, the kind of work involved. code = code edits/refactor/bugfix; research = look up information / compare options; draft = write text (email, doc, post) that the user will review; summarize = condense source material; data = extract or transform structured data; review = read a doc/PR and produce feedback; other = doesn\'t fit. When is_ai_routable=false, default to "other".',
        },
        ai_routing_reasoning: {
          type: 'string',
          description:
            'One short sentence explaining the routing verdict — what about this task lets an agent (or doesn\'t let it) handle it. Shown to the user in the routing badge so they understand the recommendation.',
        },
        ai_target_hint: {
          type: 'string',
          description:
            'When a KNOWN_PLAYBOOK entry matches and names a specific tool, repository, service, or session to run the procedure in (e.g. "Upwork Monitor", "openclaw", a repo slug), put that name here so the system can route the task there. Empty string when no playbook names a concrete target.',
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
        'proposed_description',
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
        'is_ai_routable',
        'ai_task_type',
        'ai_routing_reasoning',
        'ai_target_hint',
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
6. AI-routability — could a generalist AI agent realistically take this off the user's plate? Set is_ai_routable=true when the task is one of:
   - CODE — code edits, refactors, bug fixes, scripts, configuration changes the agent can make in a repo.
   - RESEARCH — looking up information online, comparing options, gathering facts.
   - DRAFT — writing text the user will review: email, doc, post, summary, slide content.
   - SUMMARIZE — condensing source material the user provides or the agent can fetch.
   - DATA — extracting / transforming structured data, filling a spreadsheet, parsing a file.
   - REVIEW — reading a doc/PR/article and producing structured feedback.
   Set is_ai_routable=FALSE when ANY of these apply:
   - Requires physical action (call someone live, attend, drive, buy in person).
   - Requires the user's personal opinion / emotional response / social judgment that cannot be delegated.
   - Requires secrets/access the agent realistically does not have (a specific person's DMs, paid SaaS without API, internal company tools the user can but agent can't reach).
   - The goal is ambiguous and only the user can decide what "done" looks like.
   - It's a private/relationship task addressed to a specific named person who expects YOU.
   Always fill ai_task_type (use 'other' when not routable). ai_routing_reasoning = one short sentence explaining the verdict.

Quality bar:
- Title ≤ 120 chars. Imperative. No hashtags. No emojis.
- "позвать няню на субботу" → proposed_title "Написать няне про субботу", category "two_minute", specific "Няня подтвердила субботу", time_bound "Saturday", is_ai_routable=FALSE (private message to a specific person).
- "renovate bathroom" → is_project=true, project_name "Bathroom renovation", sub_actions: [{action_title:"Measure bathroom and list required works", suggested_category:"next"}, {action_title:"Get 3 contractor quotes", suggested_category:"next"}], is_ai_routable=FALSE (physical work).
- "summarise the BLE protocol spec PDF from Gady" → is_ai_routable=TRUE, ai_task_type="summarize", routing_reasoning="agent can read the PDF and produce a structured summary".
- "Write a draft reply to Allison Walker about Custom Tracking App estimate" → is_ai_routable=TRUE, ai_task_type="draft" (user will review and send).
- Mixed-language input is fine — keep titles in the source language.

KNOWN_PLAYBOOK (long-term operational rules and recorded procedures):
The user message MAY include a KNOWN_PLAYBOOK block — excerpts from the user's
procedural memory: channel rules, conventions, DO-NOT rules, and step-by-step
procedures the user has recorded for recurring work. Each entry is prefixed
with its source path and section (e.g. [user:recorded/... ## Title]).
Use it:
- When a recorded procedure matches the task, reference it: mention the
  procedure title in proposed_description ("Playbook: <title>") and align
  suggested contexts/tags with how the procedure is executed.
- When splitting a project, prefer sub_actions that follow the recorded
  procedure's steps over inventing your own.
- Lines starting with ⚠️ or НЕ / DO NOT are HARD RULES — never propose
  something they forbid.
- A matching procedure that an AI agent could execute end-to-end is a strong
  hint for is_ai_routable=true (mention the playbook in ai_routing_reasoning).

KNOWN_GLOSSARY (decode shorthand — acronyms, project codenames, internal terms):
The user message MAY include a KNOWN_GLOSSARY block — "term = expansion (kind)"
lines for NON-person shorthand seen in past captures. When the card text uses one
of these terms (or an alias), use the expansion to write a clearer
proposed_title / proposed_description (spell out the meaning instead of echoing the
raw shorthand). Reference only — it never forces a category and adds no fields. If a
term is not listed, leave it as-is; do not invent an expansion.

⚠️ PLAYBOOKS ARE RECIPES FOR THE AI AGENT, NOT MANUAL CHECKLISTS FOR THE USER.
The user records playbooks specifically so an AI agent runs them. So when a
recorded procedure matches the task:
- Set is_ai_routable=true and pick the ai_task_type that fits the procedure.
- DO NOT set is_project=true to break the procedure into manual next-actions
  for the user. The agent executes the whole procedure itself. Keep it a
  single routable task (is_project=false), put the procedure's outcome in
  proposed_description (you may list its steps there as the agent's plan, but
  they are the AGENT's steps, not the user's to-dos).
- Set ai_target_hint to the tool/repo/service/session the playbook names
  (e.g. "Upwork Monitor", a repo slug, "openclaw"). Empty string if none.
- ai_routing_reasoning should cite the playbook ("matches recorded playbook
  '<title>' — agent can run it end-to-end").
Only fall back to is_project=true (manual split) when NO agent-executable
playbook matches AND the task genuinely needs the user to do physical or
judgment steps.

Re-enrichment (NEW_EVIDENCE block):
The user message MAY include a NEW_EVIDENCE block — information captured AFTER the task was created (a later conversation, screen text, or audio transcript that mentions this task). When present, the card text is an EXISTING task and your job is to UPDATE the enrichment to reflect the new information:
- Task was delegated / handed to someone ("перепоручил Насте", "asked Bob to handle it") → category=waiting, is_delegation=true, delegate_to=<person>. Keep the title's intent but reframe as waiting-for ("Дождаться от Насти ...").
- Deadline moved or appeared → update smart.time_bound.
- Scope/details clarified → fold them into proposed_description (and title only if the old title is now wrong).
- Evidence says it's already done → is_noise=false, keep category, but say so in reasoning (the user resolves completion themselves).
Do NOT rewrite fields the evidence doesn't touch — keep them consistent with the existing task.

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
    options: {
      sourceMeta?: Record<string, unknown>
      priorContext?: string
      /** Fresh capture about an EXISTING task — triggers re-enrichment mode
       *  (rendered as a NEW_EVIDENCE block, see prompt). */
      newEvidence?: string
      /** Relevant playbook excerpt from procedural memory (rendered as a
       *  KNOWN_PLAYBOOK block, see prompt). */
      playbookContext?: string
      /** Decoder-ring of non-person shorthand (rendered as a KNOWN_GLOSSARY
       *  block, see prompt). Reference only. */
      glossaryContext?: string
    } = {}
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
    options: {
      sourceMeta?: Record<string, unknown>
      priorContext?: string
      newEvidence?: string
      playbookContext?: string
      glossaryContext?: string
    }
  ): string {
    const parts: string[] = []
    if (options.sourceMeta && Object.keys(options.sourceMeta).length > 0) {
      parts.push(`Source context: ${JSON.stringify(options.sourceMeta)}`)
    }
    if (options.priorContext && options.priorContext.length > 0) {
      parts.push(`Past similar items:\n${options.priorContext}`)
    }
    if (options.playbookContext && options.playbookContext.trim().length > 0) {
      parts.push(
        `KNOWN_PLAYBOOK (rules and recorded procedures from the user's procedural memory — respect ⚠️ / НЕ entries as hard constraints, reference matching procedures):\n${options.playbookContext.trim()}`
      )
    }
    if (options.glossaryContext && options.glossaryContext.trim().length > 0) {
      parts.push(options.glossaryContext.trim())
    }
    if (options.newEvidence && options.newEvidence.trim().length > 0) {
      parts.push(
        `NEW_EVIDENCE (captured AFTER this task was created — update the enrichment per the re-enrichment rules):\n${options.newEvidence.trim().slice(0, 2000)}`
      )
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
      const obj = (sa ?? {}) as Partial<SubAction> & { action_title?: unknown }
      const title = asString(obj.action_title ?? obj.title).slice(0, 120)
      if (!title) return null
      const sc = obj.suggested_category as GtdCategory | undefined
      const suggested_category: GtdCategory = VALID_CATEGORIES.includes(sc as GtdCategory)
        ? (sc as GtdCategory)
        : 'next'
      return { title, suggested_category }
    })
    .filter((x): x is SubAction => x !== null)
    .slice(0, 5)

  const ai_task_type: AiTaskType = VALID_AI_TASK_TYPES.includes(
    parsed.ai_task_type as AiTaskType
  )
    ? (parsed.ai_task_type as AiTaskType)
    : 'other'

  return {
    is_actionable: parsed.is_actionable !== false,
    proposed_title: asString(parsed.proposed_title).slice(0, 120),
    proposed_description: asString(parsed.proposed_description).slice(0, 600),
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
    is_ai_routable: parsed.is_ai_routable === true,
    ai_task_type,
    ai_routing_reasoning: asString(parsed.ai_routing_reasoning).slice(0, 280),
    ai_target_hint: asString(parsed.ai_target_hint).slice(0, 120),
    confidence:
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : 0,
    reasoning: asString(parsed.reasoning),
  }
}
