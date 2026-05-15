/**
 * Procedural chunk classifier (FR86, Phase 0.5).
 *
 * Layered approach:
 *   1. Heuristic regex — cheap, runs at ingest time. Catches the bulk of
 *      OpenClaw-runtime contamination (`[[skill_call]]`, launchctl, cron
 *      job IDs, heartbeat sections) without paying for an LLM call.
 *   2. LLM batch — for whatever the heuristic leaves as 'needs-review'.
 *      Asks a tiny structured-output prompt: «is this rule universal or
 *      OpenClaw-runtime?».
 *   3. User confirmation — for low-confidence verdicts (Phase 0.5
 *      extension; not in the initial PR). Lands as a `playbook-classify`
 *      proposal in the Mindwtr inbox via the existing proposal pipeline.
 *
 * The classifier outputs an `AppliesTo` verdict that the reader writes
 * into `procedural_chunks.applies_to`. The retriever then filters chunks
 * by `applies_to IN ('universal','mindwtr-only')` so the Proposer prompt
 * only sees rules that actually apply to it.
 */

export type AppliesTo =
  | 'universal'      // applies to any AI acting on Sergey's behalf
  | 'openclaw-only'  // OpenClaw runtime / tool calls / its own algorithm
  | 'mindwtr-only'   // Mindwtr-side curation (future)
  | 'archived'       // superseded / outdated
  | 'needs-review'   // default for new chunks until classified

export type ClassifiedBy = 'heuristic' | 'llm' | 'user' | null

export interface ClassificationVerdict {
  appliesTo: AppliesTo
  classifiedBy: ClassifiedBy
  /** Optional human-readable reason — kept short, for audit. */
  reason: string
}

/**
 * Patterns that mark a chunk as OpenClaw-specific. Order matters only
 * for `reason` reporting (first hit wins).
 */
const OPENCLAW_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Wiki-style skill calls — `[[reply_to_current]]`, `[[message read]]`, etc.
  { pattern: /\[\[[a-zA-Z][\w\s_]*\]\]/, reason: 'wiki-style skill call notation [[xxx]]' },
  // Algorithm self-instructions and OpenClaw-runtime concepts.
  { pattern: /\b(?:ALGORITHM\.md|heartbeat|subagent|H1-H4|P1-P2|U1-U4)\b/, reason: 'OpenClaw self-algorithm reference' },
  // macOS launchd / OpenClaw process management.
  { pattern: /\blaunchctl\b|com\.openclaw\./, reason: 'OpenClaw process / launchd management' },
  // Cron job UUIDs OpenClaw manages — uuid-shape after `job id`.
  { pattern: /job id:\s*[a-f0-9]{8}-/i, reason: 'OpenClaw cron job ID reference' },
  // OpenClaw-side credentials directory + plugin folders.
  { pattern: /\.openclaw\/|secrets\/(?:github|codeberg|notion|claude|telegram)/, reason: 'OpenClaw credential / config path' },
  // Phrases that only make sense from OpenClaw's first-person POV.
  { pattern: /я (?:как |)(?:агент|OpenClaw|ассистент)|мой алгоритм|self-update|самоизменени/i, reason: 'OpenClaw first-person self-reference' },
]

/**
 * Patterns that confidently mark a chunk as universal — applies to any
 * assistant. Used to short-circuit even when OpenClaw-runtime mentions
 * appear (a section may have both rules and tool-name references).
 */
const UNIVERSAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Privacy / do-not-touch rules — these always apply.
  { pattern: /НЕ\s+(?:вмешиваться|читать|спамить|трогать|писать|отправлять|пересылать)|NO_REPLY|do\s+not\s+(?:reply|interfere|disturb)/i, reason: 'privacy / hard-do-not constraint' },
  // Identity / family / people facts.
  { pattern: /^(##\s*)?(?:Люди|Семья|Серега|Контакты)/im, reason: 'identity / people header' },
  // Timezones, addresses, phone numbers, DNI / passport.
  { pattern: /\bAmerica\/[A-Za-z_]+|GMT[+-]\d|\+7\d|\bDNI\b|\bАргентина\b|Buenos Aires/, reason: 'identity / location fact' },
]

/**
 * Run the cheap heuristic classifier over a chunk. Returns a verdict
 * that the caller writes to `procedural_chunks`. If no pattern matches
 * decisively, returns 'needs-review' so the LLM classifier (or user)
 * can take a second pass.
 */
export function classifyByHeuristic(text: string, sectionTitle: string | null): ClassificationVerdict {
  const combined = `${sectionTitle ?? ''}\n${text}`

  // Universal patterns win — a section with a hard privacy rule shouldn't
  // be locked away just because it also mentions an OpenClaw tool.
  for (const { pattern, reason } of UNIVERSAL_PATTERNS) {
    if (pattern.test(combined)) {
      return { appliesTo: 'universal', classifiedBy: 'heuristic', reason }
    }
  }

  for (const { pattern, reason } of OPENCLAW_PATTERNS) {
    if (pattern.test(combined)) {
      return { appliesTo: 'openclaw-only', classifiedBy: 'heuristic', reason }
    }
  }

  return {
    appliesTo: 'needs-review',
    classifiedBy: null,
    reason: 'no heuristic match — LLM or user classifier needed',
  }
}

// ---------------- LLM classifier ----------------

import type { LLMClient } from '../../ai/client'

const LLM_CLASSIFIER_PROMPT = `You triage chunks of Sergey's long-term playbook to decide which of his AI assistants should see them.

Output one of four verdicts:

- universal   — the rule applies to ANY assistant acting on Sergey's behalf. Facts about him (timezone, family, addresses), people in his life, communication conventions ("reply in threads"), privacy do-not-rules ("don't write in DM with Nastya"), business state (active epics, ongoing autonomous earning).
- openclaw-only — the rule is specific to OpenClaw's runtime: its own skill-call syntax ([[xxx]]), its launchd jobs, its algorithm.md self-reference, cron job IDs it manages, its plugin folders, first-person self-instructions ("I as the agent should …").
- mindwtr-only  — extremely rare; reserved for future Mindwtr-side rules.
- archived     — clearly outdated / superseded by a newer dated entry.

When unclear, prefer "needs-review" over guessing.

Return ONLY a JSON object with these keys (no preamble, no markdown):
{"verdict":"universal"|"openclaw-only"|"mindwtr-only"|"archived"|"needs-review","reason":"one short sentence"}`

export interface LlmClassifierOptions {
  llm: LLMClient
  model?: string
}

export class LlmChunkClassifier {
  constructor(private readonly opts: LlmClassifierOptions) {}

  async classify(
    sectionTitle: string | null,
    text: string
  ): Promise<ClassificationVerdict> {
    const head = (sectionTitle ?? '').slice(0, 200)
    const body = text.slice(0, 2400)
    const user = `Section title: ${head}\n\nSection body:\n${body}`

    let response
    try {
      response = await this.opts.llm.chatCompletion({
        messages: [
          { role: 'system', content: LLM_CLASSIFIER_PROMPT },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: 120,
        model: this.opts.model,
      })
    } catch (err) {
      return {
        appliesTo: 'needs-review',
        classifiedBy: null,
        reason: `LLM error: ${(err as Error).message.slice(0, 120)}`,
      }
    }

    const raw = response.choices[0]?.message?.content?.trim() ?? ''
    const stripped = raw.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
    try {
      const parsed = JSON.parse(stripped) as { verdict?: string; reason?: string }
      const verdict = normaliseVerdict(parsed.verdict)
      return {
        appliesTo: verdict,
        classifiedBy: 'llm',
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
      }
    } catch {
      return {
        appliesTo: 'needs-review',
        classifiedBy: null,
        reason: 'LLM returned non-JSON',
      }
    }
  }
}

function normaliseVerdict(v: unknown): AppliesTo {
  const lower = typeof v === 'string' ? v.toLowerCase() : ''
  if (lower === 'universal') return 'universal'
  if (lower === 'openclaw-only' || lower === 'openclaw_only') return 'openclaw-only'
  if (lower === 'mindwtr-only' || lower === 'mindwtr_only') return 'mindwtr-only'
  if (lower === 'archived') return 'archived'
  return 'needs-review'
}
