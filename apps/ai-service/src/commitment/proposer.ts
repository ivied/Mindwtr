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
import type { KnownPerson } from '../wiki/persons-reader'
import type { RecentItem } from './inbox-titles'

export type WhoOwes = 'user' | 'other' | 'unclear'
export type Recipient = 'user' | 'other' | 'unclear'
export type SuggestedCategory = 'next' | 'waiting' | 'someday' | 'reference' | 'two_minute'

export interface UserIdentity {
  /** Primary display name of the user (e.g. "Sergey Kurdyuk"). */
  name: string
  /** Alternative spellings, usernames, handles that may appear in OCR / transcripts. */
  aliases: string[]
}

export interface Proposal {
  is_actionable: boolean
  title: string
  who_owes: WhoOwes
  /** Who the action is OWED TO — relevant when who_owes='other' (someone else
   *  promised something to user → waiting). 'unclear' or 'other' for third-party. */
  recipient: Recipient
  who_to: string | null
  /**
   * Canonical slug of who_to when it matched a KNOWN_PERSONS entry, empty
   * otherwise. Writer uses this to deep-link from the proposal to the wiki
   * entity and as the stable foreign key for downstream joins.
   */
  who_to_slug: string
  what: string
  by_when: string | null
  confidence: number
  /** GTD category hint for the task. All proposals still land in inbox status;
   *  this is metadata for downstream triage / Enricher / user. */
  suggested_category: SuggestedCategory
  /** One-line summary of the decision (back-compat short reasoning). */
  reasoning: string
  /**
   * Title of an existing inbox task that this proposal semantically duplicates.
   * Empty when not a duplicate. When set, is_actionable MUST be false so the
   * pipeline reports outcome 'duplicate-of-existing' instead of creating a
   * second card for the same intent.
   */
  duplicate_of_title: string
  /**
   * Exact verbatim quote from the source text that triggered the decision.
   * Empty when nothing was clearly quotable (e.g. the cue was structural,
   * not a sentence). Used by the writer to build a smart excerpt window.
   */
  evidence_quote: string
  /** Short tags for cues the Proposer noticed ("direct request", "named recipient", "deadline phrase", ...). */
  cues_detected: string[]
  /** Ordered 2–5 step rationale: what was observed, how it was interpreted, why actionable. */
  reasoning_steps: string[]
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
            'Whose obligation is this? user = the user identified in YOU ARE WORKING FOR. other = someone else. unclear = ambiguous.',
        },
        recipient: {
          type: 'string',
          enum: ['user', 'other', 'unclear'],
          description:
            'Who the obligation is owed TO. When who_owes=other AND recipient=user, the user is WAITING for someone else (set suggested_category=waiting). When who_owes=other AND recipient=other, it is a third-party conversation (set is_actionable=false). When who_owes=user, recipient is whoever the user owes (use "unclear" if no one specific).',
        },
        who_to: {
          type: 'string',
          description:
            'Who the action involves (recipient/counterparty). E.g. "Alice", "wife", "my team". When this person matches a KNOWN_PERSONS entry, use the canonical Name from that entry (not the literal OCR spelling). Empty string when not applicable.',
        },
        who_to_slug: {
          type: 'string',
          description:
            'When who_to matched a KNOWN_PERSONS entry, the bracketed slug from that entry (e.g. "amir-red"). Empty string when no match (new/unknown person) or when who_to is not applicable.',
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
            'One sentence summary of the decision (the short headline reason). The detailed train-of-thought goes in reasoning_steps.',
        },
        evidence_quote: {
          type: 'string',
          description:
            'Exact verbatim quote (≤200 chars) from the source text that triggered the decision. Use the raw substring as-it-appears, including any OCR artefacts. Empty string when nothing was quotable (the cue was structural, e.g. an invoice line with a date column).',
        },
        cues_detected: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Short tags for sniffed cues, 1-5 items. Examples: "direct request", "named recipient", "explicit action verb", "deadline phrase", "due date", "money amount", "self-reminder phrasing", "imperative tone", "past tense (NOT cue)", "structural cue (invoice line)". Include cues against actionability too when relevant.',
        },
        reasoning_steps: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered 2-5 step train-of-thought. Each step is one short sentence. Sequence: (1) what concrete text you spotted, (2) how you interpreted it (request? observation? past-tense?), (3) who owns the action, (4) why this is/isn\'t a personal commitment for the user, (5) confidence justification. Skip steps that don\'t apply.',
        },
        duplicate_of_title: {
          type: 'string',
          description:
            'When the proposed task is semantically the same as an entry in RECENT_USER_ITEMS (same intent / target / deadline as one of those, possibly worded differently), set this to the EXACT title of that entry AND set is_actionable=false. Read the [label] on each item to choose the right reasoning: [in inbox] / [pending AI review] / [user accepted N ago] / [user rejected N ago] / [user already done N ago] / [no longer applicable N ago]. Empty string when no match (genuinely new commitment, or item is old enough that a fresh recurrence is plausible).',
        },
        suggested_category: {
          type: 'string',
          enum: ['next', 'waiting', 'someday', 'reference', 'two_minute'],
          description:
            'GTD category hint after the user processes inbox. Decision order: two_minute (<2 min do-now) → waiting (who_owes=other AND recipient=user; user is blocked on someone else) → someday (vague intent without deadline) → reference (info, not action) → next (default for concrete user actions with target/deadline).',
        },
      },
      required: [
        'is_actionable',
        'title',
        'who_owes',
        'recipient',
        'who_to',
        'who_to_slug',
        'what',
        'by_when',
        'confidence',
        'reasoning',
        'evidence_quote',
        'cues_detected',
        'reasoning_steps',
        'duplicate_of_title',
        'suggested_category',
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

Role disambiguation (who_owes / recipient):
The capture is from THE USER's machine. Other names visible in screenshots/transcripts
(message authors in chats, emails, etc.) are NOT the user unless they match the
identity given in YOU ARE WORKING FOR. First-person pronouns ("I", "я") inside a
message authored by someone else refer to THAT person, not the user.

- who_owes=user: the user (per YOU ARE WORKING FOR) made the commitment.
- who_owes=other: another person made a commitment.
- who_owes=unclear: ambiguous.

When who_owes=other, set recipient correctly:
- recipient=user → user is WAITING for that person → still actionable as a "waiting"
  card (suggested_category=waiting). Example: "Amir: По Flutter я завтра скажу" addressed
  to Sergey → user (Sergey) waits for Amir's Flutter answer.
- recipient=other → conversation between third parties → is_actionable=false.

Title format (when actionable): short imperative GTD next action.
- Good: "Pay Acme invoice", "Reply to Alice re Q4 plan", "Send weekly report"
- Bad: "Invoice from Acme is due", "Got message from Alice"

When uncertain, lean toward is_actionable=false.

Explain your work:
- evidence_quote — copy the EXACT substring from the source that drove your decision (≤200 chars). Don't paraphrase. Empty string only when the cue is structural, not textual (e.g. an invoice line in a table).
- cues_detected — 1-5 short tags. Use specific shapes: "direct request", "named recipient", "explicit first-person verb", "deadline phrase", "due date", "money amount", "self-reminder phrasing", "imperative tone", "past tense (NOT cue)", "structural cue (form / invoice line)", "design mockup language", "third-party conversation".
- reasoning_steps — 2-5 short sentences in order: (1) what concrete text/structure you spotted, (2) how you interpreted it, (3) who owns the action, (4) why this IS or ISN'T a personal commitment for the user, (5) confidence justification. Skip steps that don't apply.
- reasoning — one-sentence summary; use the same tone as a PR title.

PERSON NORMALIZATION:
The user message MAY include a KNOWN_PERSONS block — canonical names with slug
and aliases (transliterations, nicknames, OCR spellings) for people seen in past
captures. When you set who_to, check if the person matches one of these entries:
- Match (exact, alias, transliteration, or obvious shortening) →
  - who_to = the canonical "Name" from the entry (e.g. "Amir Red"), not the OCR spelling
  - who_to_slug = the bracketed slug (e.g. "amir-red")
- No match (new/unknown person) →
  - who_to = literal name from source text
  - who_to_slug = "" (empty)
Use this to keep the same person consistent across captures — "Эллисон", "Allison",
"A. Walker" should all collapse to one canonical entity.

DUPLICATE SUPPRESSION:
The user message MAY include a RECENT_USER_ITEMS block — items the user has recently
seen or acted on, each tagged with a label:
  - [in inbox]                  → open task already sitting in the user's inbox
  - [pending AI review]         → AI already proposed this; the user hasn't decided yet
  - [user accepted N ago]       → AI proposal approved; the task should already be in inbox
  - [user rejected N ago]       → AI was wrong; the user dismissed this idea
  - [user already done N ago]   → AI was right but the user did the action manually
  - [no longer applicable N ago]→ situation changed (meeting cancelled, ticket closed)

If the action you'd propose is essentially the same as one of these (different wording
but same target person/object, same intent, same deadline window), set is_actionable=false,
duplicate_of_title to the EXACT title from that entry, and write a one-line reasoning
that mirrors the label, e.g.:
- "Already in inbox: Reply to Alice re Q4 plan"
- "Pending AI review: Pay Acme invoice"
- "User just rejected this 2 days ago — suppressing replay"
- "User already did this yesterday"
- "No longer applicable (cancelled 3 days ago)"

How strict to be by label (calibrate suppression strength):
- [in inbox] / [pending AI review]    → strongest match; suppress on near-paraphrase.
- [user rejected N ago]               → strong; the user said no recently. Suppress unless
                                        wording shows a clearly different occurrence.
- [no longer applicable N ago]        → moderate; situation changed, but a NEW instance of
                                        the same kind of action can legitimately recur.
- [user already done N ago]           → moderate; the user did it, but a recurring task
                                        (daily report, weekly sync) can fire again.
- [user accepted N ago]               → expect this is already in inbox; treat as such
                                        unless the recurrence interval clearly elapsed.

Recurrence escape hatch: when the recent item is OLD relative to its natural cadence
("send weekly report" rejected 8 days ago → a new week has started → propose as fresh)
or wording suggests a distinct instance (different invoice, different meeting), DO NOT
suppress. Set duplicate_of_title = "".

Semantic match examples (DO suppress):
- "Send Polina's hours to Dylan" ≡ "Forward Polina's timesheet to Dylan Feeney"
- "Reply to Alice about Q4 plan" ≡ "Get back to Alice re Q4 strategy email"
- "Pay Acme invoice" ≡ "Settle Acme invoice $500"
NOT a match (DON'T suppress):
- Different recipient ("Reply to Alice" vs "Reply to Bob")
- Different timeframe (this Friday vs next Friday)
- Different scope (one-off task vs an open recurring project)

Always call propose_inbox_item with all fields filled (use empty string / empty array when N/A).`

export class Proposer {
  constructor(
    private llm: LLMClient,
    private model?: string
  ) {}

  async propose(
    text: string,
    sourceMeta?: Record<string, unknown>,
    /**
     * Recent user items for semantic dedup. Accepts the new `RecentItem[]`
     * (labelled with source/resolution/age) or the legacy `string[]` of bare
     * inbox titles. Strings are auto-promoted to RecentItem with source='inbox'
     * so older callers keep working.
     */
    recentItems?: RecentItem[] | string[],
    userIdentity?: UserIdentity | null,
    knownPersons?: KnownPerson[],
    /** Optional pre-assembled summary of relevant past context. Goes into
     *  the user-message as a RECENT_CONTEXT block so the Proposer can
     *  factor open threads / waiting-fors / prior decisions into its
     *  is_actionable / suggested_category / duplicate_of_title verdict.
     *  Plain text, ≤ ~400 chars expected. */
    recentContext?: string | null
  ): Promise<Proposal> {
    const systemPrompt = buildSystemPrompt(userIdentity)
    const parts: string[] = []
    if (sourceMeta) parts.push(`Capture context: ${JSON.stringify(sourceMeta)}`)
    if (knownPersons && knownPersons.length > 0) {
      const lines = knownPersons
        .slice(0, 50)
        .map((p) => {
          const aliasesPart =
            p.aliases.length > 0 ? ` (aliases: ${p.aliases.join(', ')})` : ''
          return `- ${p.name} [${p.slug}]${aliasesPart}`
        })
        .join('\n')
      parts.push(
        `KNOWN_PERSONS (registry from past captures — normalize who_to to one of these when matched):\n${lines}`
      )
    }
    const normalizedItems = normalizeRecentItems(recentItems)
    if (normalizedItems.length > 0) {
      const lines = normalizedItems
        .slice(0, 50)
        .map((it) => `- "${it.title}" ${formatRecentItemLabel(it)}`)
        .join('\n')
      parts.push(
        `RECENT_USER_ITEMS (dedup against these — labels show provenance and age; calibrate suppression strength per the rules in the system prompt):\n${lines}`
      )
    }
    if (recentContext && recentContext.trim().length > 0) {
      parts.push(
        `RECENT_CONTEXT (relevant facts and recent events from the user's history — use to spot duplicates, recognize ongoing threads, attribute roles correctly):\n${recentContext.trim()}`
      )
    }
    parts.push(`Text:\n${text}`)
    const userMessage = parts.join('\n\n')

    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
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

    const cues = Array.isArray((parsed as { cues_detected?: unknown }).cues_detected)
      ? ((parsed as { cues_detected: unknown[] }).cues_detected
          .filter((c) => typeof c === 'string' && c.length > 0) as string[])
      : []
    const steps = Array.isArray((parsed as { reasoning_steps?: unknown }).reasoning_steps)
      ? ((parsed as { reasoning_steps: unknown[] }).reasoning_steps
          .filter((s) => typeof s === 'string' && s.length > 0) as string[])
      : []
    const evidence =
      typeof (parsed as { evidence_quote?: unknown }).evidence_quote === 'string'
        ? ((parsed as { evidence_quote: string }).evidence_quote || '').slice(0, 240)
        : ''
    const duplicateOf =
      typeof (parsed as { duplicate_of_title?: unknown }).duplicate_of_title === 'string'
        ? ((parsed as { duplicate_of_title: string }).duplicate_of_title || '').slice(0, 240)
        : ''
    const recipientRaw = (parsed as { recipient?: unknown }).recipient
    const recipient: Recipient = ['user', 'other', 'unclear'].includes(recipientRaw as string)
      ? (recipientRaw as Recipient)
      : 'unclear'
    const categoryRaw = (parsed as { suggested_category?: unknown }).suggested_category
    const suggestedCategory: SuggestedCategory = (
      ['next', 'waiting', 'someday', 'reference', 'two_minute'] as const
    ).includes(categoryRaw as SuggestedCategory)
      ? (categoryRaw as SuggestedCategory)
      : 'next'

    return {
      is_actionable: Boolean(parsed.is_actionable),
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 120) : '',
      who_owes: ['user', 'other', 'unclear'].includes(parsed.who_owes as string)
        ? (parsed.who_owes as WhoOwes)
        : 'unclear',
      recipient,
      who_to: typeof parsed.who_to === 'string' && parsed.who_to.length > 0 ? parsed.who_to : null,
      who_to_slug:
        typeof (parsed as { who_to_slug?: unknown }).who_to_slug === 'string'
          ? ((parsed as { who_to_slug: string }).who_to_slug || '').slice(0, 120)
          : '',
      what: typeof parsed.what === 'string' ? parsed.what : '',
      by_when: typeof parsed.by_when === 'string' && parsed.by_when.length > 0 ? parsed.by_when : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
      evidence_quote: evidence,
      cues_detected: cues,
      reasoning_steps: steps,
      duplicate_of_title: duplicateOf,
      suggested_category: suggestedCategory,
    }
  }
}

/**
 * Accept either the rich RecentItem[] (preferred) or a legacy string[] of
 * bare inbox titles. Strings are promoted to source='inbox' so the rest of
 * the rendering pipeline doesn't branch.
 */
function normalizeRecentItems(
  input: RecentItem[] | string[] | undefined
): RecentItem[] {
  if (!input || input.length === 0) return []
  const out: RecentItem[] = []
  for (const it of input) {
    if (typeof it === 'string') {
      const trimmed = it.trim()
      if (trimmed.length > 0) out.push({ title: trimmed, source: 'inbox' })
    } else if (it && typeof it.title === 'string' && it.title.trim().length > 0) {
      out.push(it)
    }
  }
  return out
}

/** Human-readable bracket label for the Proposer prompt. */
function formatRecentItemLabel(item: RecentItem): string {
  if (item.source === 'inbox') return '[in inbox]'
  if (item.source === 'pending') return '[pending AI review]'
  // resolved
  const age = formatAge(item.ageMs)
  switch (item.resolution) {
    case 'approved':
      return `[user accepted${age ? ` ${age}` : ''}]`
    case 'already-done':
      return `[user already done${age ? ` ${age}` : ''}]`
    case 'not-applicable':
      return `[no longer applicable${age ? ` ${age}` : ''}]`
    case 'rejected':
    default:
      return `[user rejected${age ? ` ${age}` : ''}]`
  }
}

function formatAge(ms: number | undefined): string {
  if (!Number.isFinite(ms) || (ms as number) < 0) return ''
  const minutes = Math.floor((ms as number) / 60_000)
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

function buildSystemPrompt(identity: UserIdentity | null | undefined): string {
  if (!identity || !identity.name) return PROPOSER_PROMPT
  const aliases = identity.aliases.filter((a) => a && a.length > 0)
  const aliasList = aliases.length > 0 ? aliases.join(', ') : '(none)'
  const block = [
    'YOU ARE WORKING FOR:',
    `- Name: ${identity.name}`,
    `- Aliases on screen (handles, nicknames, transliterations): ${aliasList}`,
    'When OCR/transcript shows these names — that is THE USER. Other names are NOT the user.',
    'First-person pronouns ("I", "я") inside a message authored by someone else refer to THAT author, never to the user.',
    '',
  ].join('\n')
  return `${block}${PROPOSER_PROMPT}`
}
