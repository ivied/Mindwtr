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

const SYSTEM_PROMPT = `You build a personal "decoder ring" for ONE user by reading their to-do tasks.
Goal: capture the names and labels that are SPECIFIC TO THIS USER'S WORLD —
things an outsider could NOT understand or look up, because they only exist
inside the user's projects, team, or company.

THE ONLY TEST THAT MATTERS:
"Could a smart, well-read stranger understand this WITHOUT access to the user's
projects — e.g. by searching the web or from general/professional knowledge?"
- If YES (they could figure it out) → DO NOT include it.
- If NO (it's a private name/label that means nothing outside this user's world)
  → include it.

INCLUDE (proper names & private labels):
- project / product / initiative codenames ("Phoenix", "Idyoma", "Mercury")
- internal team / company / org short-names that only insiders know ("UD", "UDev")
- private internal abbreviations or jargon unique to this user's work, where the
  meaning cannot be guessed without context

DO NOT INCLUDE (anything an outsider can already understand):
- people / names / nicknames (they have a separate registry)
- well-known public/industry acronyms — e.g. API, SSO, LLM, AI, ML, PR, MR,
  CI/CD, ERP, CRM, SDK, UI, UX, SQL, HTTP, OKR, KPI, B2B, MVP, ROI
- general business / startup / domain vocabulary even if it looks technical —
  e.g. CustDev, CAC, LTV, GTD, DMCA, churn, runway, backlog
- ordinary words and common verbs ("call", "review", "meeting", "report", "buy")
- well-known public brands / products ("Gmail", "iPhone", "Slack", "Notion")

Bias HARD toward proper nouns (kind="project" or "organization"). Only use
kind="term" or "technology" for a private/internal label whose meaning truly
cannot be looked up. When unsure whether something is "specific to the user"
vs "generally known", LEAVE IT OUT.

For each candidate decide a grade:
- "high": confident it is a user-specific name AND you can infer a plausible
  one-line meaning from the tasks themselves.
- "needs_input": likely a user-specific name but its meaning is unclear from the
  tasks — the user must explain it. Leave expansion "" (empty) in that case.

Output STRICT JSON, no prose, no fences:
{
  "candidates": [
    {"term": "Idyoma", "kind": "project|term|technology|organization", "expansion": "<one line, or empty>", "grade": "high|needs_input", "confidence": 0.0-1.0, "evidence": "<=80 chars quote from a task"}
  ]
}

Be very conservative — a short, high-signal list of user-specific names beats a
long list of dictionary terms. If nothing qualifies, return {"candidates": []}.`

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

    // Scan the WHOLE inbox, not just the first page — newer / more specific
    // codenames often live in the tail. Batch so a large inbox neither blows
    // the prompt nor gets the response truncated by max_tokens.
    const batches = chunk(usable, BATCH_SIZE)
    const merged = new Map<string, GlossaryCandidate>()
    for (const batch of batches) {
      const res = await this.llm.chatCompletion({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(batch) },
        ],
        max_tokens: 2500,
        temperature: 0,
        model: this.model,
      })
      const raw = res.choices[0]?.message?.content ?? ''
      for (const cand of parseCandidates(raw)) {
        const prev = merged.get(cand.slug)
        // Keep the strongest sighting across batches.
        if (!prev || cand.confidence > prev.confidence) merged.set(cand.slug, cand)
      }
    }
    return [...merged.values()].filter(passesQualityGate)
  }
}

const BATCH_SIZE = 120

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Second-line defence after the prompt: drop low-confidence guesses and any
 * well-known public acronym / generic domain term that slipped through. The
 * glossary is for user-specific names, not a dictionary.
 */
const MIN_CONFIDENCE = 0.6

// Public acronyms + generic business/domain vocabulary an outsider can already
// understand. Matched case-insensitively against the whole term (not substrings).
const GENERIC_TERMS: ReadonlySet<string> = new Set(
  [
    'api', 'sso', 'llm', 'ai', 'ml', 'pr', 'mr', 'ci', 'cd', 'ci/cd', 'erp',
    'crm', 'sdk', 'ui', 'ux', 'sql', 'http', 'https', 'okr', 'kpi', 'b2b',
    'b2c', 'mvp', 'roi', 'saas', 'paas', 'json', 'csv', 'pdf', 'url', 'qa',
    'custdev', 'cac', 'ltv', 'gtd', 'dmca', 'seo', 'cms', 'cto', 'ceo', 'cfo',
    'hr', 'kyc', 'nda', 'eta', 'faq', 'os', 'db', 'ide', 'cli', 'vpn', 'dns',
  ].map((s) => s.toLowerCase())
)

function passesQualityGate(c: GlossaryCandidate): boolean {
  if (c.confidence < MIN_CONFIDENCE) return false
  if (GENERIC_TERMS.has(c.term.trim().toLowerCase())) return false
  return true
}

function buildUserPrompt(tasks: OnboardingTaskInput[]): string {
  // Caller already chunks to BATCH_SIZE, so no slice here — scan every task.
  const lines = tasks.map((t, i) => {
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
