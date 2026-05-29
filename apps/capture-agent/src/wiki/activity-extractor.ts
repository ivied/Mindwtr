/**
 * Activity extractor — the vision+OCR replacement for entity-extractor.
 *
 * Instead of pulling a bag of named entities out of mangled OCR text, this
 * looks at the actual screenshot (vision) with the OCR text as an exact-words
 * hint, and answers "what is the user doing here" as a structured ActivityRecord:
 * the activity, who's involved, and — crucially — the attributed statements
 * (who said / asked / committed what), so the knowledge graph can later answer
 * "who do I talk to about X" rather than just "these nouns co-occurred".
 *
 * The image is primary (layout, who-said-what, structure); OCR anchors exact
 * names/quotes the downscaled image might misread. The model is told to treat
 * OCR as a hint and ignore it where it's garbage.
 */

import type { LlmClient } from './llm-client'

export type StatementKind =
  | 'said'
  | 'asked'
  | 'committed'
  | 'decided'
  | 'blocked'
  | 'other'

export interface Statement {
  /** Who made it — a person/name as shown, or "user" for Sergey. */
  who: string
  /** The content, paraphrased but faithful (use exact wording when it matters). */
  what: string
  kind: StatementKind
}

export interface ActivityEntityRef {
  /** Entity as shown (name/slug-ish); canonicalized downstream. */
  entity: string
  /** Its role IN THIS activity — e.g. "project being edited", "person messaged". */
  role: string
}

export interface Commitment {
  who_owes: string
  to_whom: string
  what: string
  by_when?: string
}

export interface ActivityRecord {
  /** One-line headline of what's happening. */
  activity: string
  /** Project/context this belongs to, '' when unclear. */
  project: string
  /** Where — app + site/file, e.g. "VS Code · rollup.ts", "Telegram · Мастер чат". */
  surface: string
  /** People present/involved (names as shown). */
  participants: string[]
  /** Attributed atomic content — the assignable signal. */
  statements: Statement[]
  /** The few entities that matter here, each with its role in this activity. */
  entities: ActivityEntityRef[]
  /** Actionable subset — tasks/promises visible. */
  commitments: Commitment[]
  state: 'focused' | 'switching' | 'blocked' | 'browsing' | 'unclear'
  /** Brief grounding note — what on screen supports this. */
  evidence: string
}

export interface ExtractActivityInput {
  imageBase64: string
  /** OCR text of the screen — exact-words hint; may be garbled. */
  ocrText: string
  /** Foreground app name, when known. */
  app?: string
  /** Capture timestamp (ISO) for context. */
  ts?: string
  mime?: string
}

const SYSTEM_PROMPT = `You observe a single screenshot of a developer's screen and report what they are doing, as STRICT JSON.

You are given the screen IMAGE (primary — use it for layout, structure, and who-said-what in chats) and its OCR TEXT (a hint for exact words/names; it is often garbled — rely on the image, use OCR only to get exact spellings/quotes, ignore OCR noise).

Output ONLY a JSON object (no prose, no fences) with this shape:
{
  "activity": "one-line: what is the user doing right now",
  "project": "project/context name, or \\"\\" if unclear",
  "surface": "where — app + site/file (e.g. \\"VS Code · rollup.ts\\", \\"Telegram · <chat name>\\")",
  "participants": ["names of people present/involved, as shown"],
  "statements": [
    { "who": "name or \\"user\\"", "what": "what they said/asked/want, faithful to the text", "kind": "said|asked|committed|decided|blocked|other" }
  ],
  "entities": [ { "entity": "name", "role": "its role in THIS activity" } ],
  "commitments": [ { "who_owes": "name", "to_whom": "name", "what": "the task", "by_when": "when or \\"\\"" } ],
  "state": "focused|switching|blocked|browsing|unclear",
  "evidence": "brief: what on screen supports this"
}

Rules:
- Report ONLY what is actually visible. Never invent names, statements, projects, or relationships. Empty arrays / "" are correct when unknown.
- statements: when a chat/message/doc shows attributed content, capture WHO said/asked/committed WHAT — this is the most valuable output. Attribute carefully using the image (who is the sender). Do not merge different people's statements.
- entities: only the few that matter to this activity, each with a concrete role. Not every noun on screen.
- commitments: only real tasks/promises (a subset of statements). [] if none.
- "user" = the person whose screen this is (Sergey).
- If the screen is pure UI chrome / OCR garbage with nothing meaningful, return {"activity":"","project":"","surface":"","participants":[],"statements":[],"entities":[],"commitments":[],"state":"unclear","evidence":"no meaningful content"}.`

export async function extractActivity(
  llm: LlmClient,
  input: ExtractActivityInput
): Promise<ActivityRecord> {
  const ocr = (input.ocrText ?? '').slice(0, 4000)
  const text = [
    input.app ? `Foreground app: ${input.app}` : '',
    input.ts ? `Captured at: ${input.ts}` : '',
    '',
    'OCR text of the screen (hint — image is primary; ignore garbled parts):',
    ocr || '(no OCR)',
  ]
    .filter(Boolean)
    .join('\n')

  const raw = await llm.chatWithImage({
    system: SYSTEM_PROMPT,
    text,
    imageBase64: input.imageBase64,
    mime: input.mime,
  })
  return parseActivity(raw)
}

export function parseActivity(raw: string): ActivityRecord {
  const empty: ActivityRecord = {
    activity: '',
    project: '',
    surface: '',
    participants: [],
    statements: [],
    entities: [],
    commitments: [],
    state: 'unclear',
    evidence: '',
  }
  const cleaned = raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return empty
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return empty
  }

  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const strArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

  const statements: Statement[] = Array.isArray(obj.statements)
    ? (obj.statements as unknown[])
        .map((s) => s as Record<string, unknown>)
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          who: str(s.who),
          what: str(s.what),
          kind: (['said', 'asked', 'committed', 'decided', 'blocked', 'other'] as const).includes(
            s.kind as StatementKind
          )
            ? (s.kind as StatementKind)
            : 'other',
        }))
        .filter((s) => s.what)
    : []

  const entities: ActivityEntityRef[] = Array.isArray(obj.entities)
    ? (obj.entities as unknown[])
        .map((e) => e as Record<string, unknown>)
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({ entity: str(e.entity), role: str(e.role) }))
        .filter((e) => e.entity)
    : []

  const commitments: Commitment[] = Array.isArray(obj.commitments)
    ? (obj.commitments as unknown[])
        .map((c) => c as Record<string, unknown>)
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          who_owes: str(c.who_owes),
          to_whom: str(c.to_whom),
          what: str(c.what),
          by_when: str(c.by_when) || undefined,
        }))
        .filter((c) => c.what)
    : []

  const state = (['focused', 'switching', 'blocked', 'browsing', 'unclear'] as const).includes(
    obj.state as ActivityRecord['state']
  )
    ? (obj.state as ActivityRecord['state'])
    : 'unclear'

  return {
    activity: str(obj.activity),
    project: str(obj.project),
    surface: str(obj.surface),
    participants: strArr(obj.participants),
    statements,
    entities,
    commitments,
    state,
    evidence: str(obj.evidence),
  }
}
