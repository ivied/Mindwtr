/**
 * OnboardingExtractor — cold-start seeding of the glossary from existing tasks.
 *
 * Reads the user's current Mindwtr tasks (titles + descriptions) and asks the
 * LLM to surface NON-person shorthand it sees — project codenames, acronyms,
 * internal terms, technologies, organizations — that a newcomer (the AI) would
 * not understand. It does NOT write anything: it returns candidates for the
 * onboarding wizard to confirm/edit/reject.
 *
 * Each candidate is graded:
 *   - 'high'        — confident this is real shorthand AND has a plausible
 *                     expansion derivable from the tasks themselves.
 *   - 'needs_input' — likely shorthand but the meaning is unclear → ASK the user.
 *
 * People are intentionally excluded here (persons have their own registry); the
 * extractor is told to skip them so the glossary stays non-person.
 */

import type { LLMClient } from '../ai/client'
import type { GlossaryKind } from '../wiki/glossary-reader'

export type CandidateGrade = 'high' | 'needs_input'

export interface GlossaryCandidate {
  slug: string
  term: string
  kind: GlossaryKind
  /** Best-effort decode the model inferred from the tasks. May be empty for
   *  needs_input candidates. */
  expansion: string
  grade: CandidateGrade
  confidence: number
  /** Short quote/why from the tasks, shown in the wizard for context. */
  evidence: string
}

export interface OnboardingTaskInput {
  title: string
  description?: string
}

const VALID_KINDS: ReadonlySet<string> = new Set<GlossaryKind>([
  'project',
  'term',
  'technology',
  'organization',
])

const SYSTEM_PROMPT = `You bootstrap a personal-assistant's glossary by reading a user's existing to-do tasks and spotting SHORTHAND a newcomer wouldn't understand.

Find NON-person shorthand only:
- project codenames ("Phoenix", "Bluebird")
- acronyms / initialisms ("PRD", "СБП", "MR", "QBR")
- internal terms / jargon specific to the user's work
- technologies / products referenced by a short or ambiguous name
- organizations / teams referenced by a short name

DO NOT include:
- people / names / nicknames (they have a separate registry)
- ordinary words, common English/Russian vocabulary, generic GTD terms
  ("call", "email", "review", "buy", "meeting", "report")
- well-known public brands that need no decoding ("Gmail", "iPhone")

For each candidate decide a grade:
- "high": you are confident it is real shorthand AND you can infer a plausible
  one-line expansion from the tasks themselves.
- "needs_input": likely shorthand but its meaning is unclear from the tasks —
  the user must explain it. Leave expansion "" (empty) in that case.

Output STRICT JSON, no prose, no fences:
{
  "candidates": [
    {"term": "Phoenix", "kind": "project|term|technology|organization", "expansion": "<one line, or empty>", "grade": "high|needs_input", "confidence": 0.0-1.0, "evidence": "<=80 chars quote from a task"}
  ]
}

Be conservative — a short, high-signal list beats a long noisy one. If nothing
qualifies, return {"candidates": []}.`

export class OnboardingExtractor {
  constructor(
    private readonly llm: LLMClient,
    private readonly model?: string
  ) {}

  async collect(tasks: OnboardingTaskInput[]): Promise<GlossaryCandidate[]> {
    const usable = tasks
      .map((t) => ({ title: (t.title ?? '').trim(), description: (t.description ?? '').trim() }))
      .filter((t) => t.title.length > 0)
    if (usable.length === 0) return []

    const userPrompt = buildUserPrompt(usable)
    const res = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1500,
      temperature: 0,
      model: this.model,
    })
    const raw = res.choices[0]?.message?.content ?? ''
    return parseCandidates(raw)
  }
}

function buildUserPrompt(tasks: OnboardingTaskInput[]): string {
  // Cap to keep the prompt bounded on large inboxes.
  const lines = tasks.slice(0, 200).map((t, i) => {
    const desc = t.description ? ` — ${t.description.slice(0, 200)}` : ''
    return `${i + 1}. ${t.title}${desc}`
  })
  return `User's existing tasks:\n${lines.join('\n')}`
}

export function parseCandidates(raw: string): GlossaryCandidate[] {
  const cleaned = stripFences(raw).trim()
  if (!cleaned) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const arr = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(arr)) return []
  const seen = new Set<string>()
  const out: GlossaryCandidate[] = []
  for (const item of arr) {
    const c = normalizeCandidate(item)
    if (!c) continue
    if (seen.has(c.slug)) continue
    seen.add(c.slug)
    out.push(c)
  }
  return out
}

function normalizeCandidate(raw: unknown): GlossaryCandidate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const term = typeof o.term === 'string' ? o.term.trim() : ''
  if (!term) return null
  const slug = slugify(term)
  if (!slug) return null
  const kind = typeof o.kind === 'string' && VALID_KINDS.has(o.kind) ? (o.kind as GlossaryKind) : 'term'
  const grade: CandidateGrade = o.grade === 'high' ? 'high' : 'needs_input'
  const expansion = typeof o.expansion === 'string' ? o.expansion.trim() : ''
  const confidence = typeof o.confidence === 'number' ? clamp01(o.confidence) : grade === 'high' ? 0.7 : 0.4
  const evidence = typeof o.evidence === 'string' ? o.evidence.slice(0, 80) : ''
  return {
    slug,
    term,
    kind,
    // needs_input candidates carry no inferred expansion — the user supplies it.
    expansion: grade === 'high' ? expansion : '',
    grade,
    confidence,
    evidence,
  }
}

function slugify(s: string): string {
  // Keep Unicode letters/digits so non-Latin terms (e.g. "СБП") get a stable,
  // non-empty slug instead of collapsing to "". Diacritics are stripped; only
  // separators/punctuation are replaced with hyphens.
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')
}
