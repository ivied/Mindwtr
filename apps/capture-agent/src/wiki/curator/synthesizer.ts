/**
 * Synthesizer — Phase C of the curator.
 *
 * For each substantive entity (mention_count >= minMentions), call the
 * LLM with its `.mentions.jsonl` and write a 1–3 sentence "About"
 * block into the entity page body. The block sits between the title
 * and the existing "## Related" / "## Recent mentions" sections.
 *
 * Why a separate pass and not at rollup time:
 *   - Rollup is high-frequency (10 min) and idempotent over many
 *     captures; calling the LLM per-capture-per-entity would dominate
 *     cost and rate-limit budget.
 *   - We want stable summaries that only refresh when an entity
 *     actually accrued new context — tracked via state file.
 *
 * Per-pass budget: synth runs against the top-K eligible entities by
 * mention growth. State at `wiki/.curator-state.json` records when
 * each slug was last synthesized and at what mention count, so the
 * pass is cheap on a stable wiki and bounded on a growing one.
 *
 * Determinism / safety:
 *   - LLM output is treated as untrusted; we strip code fences, clip
 *     to a small character cap, and reject anything that looks like
 *     a tool/JSON dump.
 *   - The splice only touches the "## About" block — Related, Recent
 *     mentions, and any other body content are preserved verbatim.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntityMd, serializeEntityMd } from './entity-frontmatter'
import type { LlmClient } from '../llm-client'

export interface SynthesizerOptions {
  wikiDir: string
  llm: LlmClient
  /** Only synthesize entities with at least this many mentions. Default 3. */
  minMentions?: number
  /** Cap entities processed per pass. Default 20. */
  maxPerPass?: number
  /** Re-synthesize when mention_count grew by at least this since last synth. Default 3. */
  resynthMentionDelta?: number
  /** Re-synthesize if synth is older than this regardless of growth. Default 7d. */
  resynthAfterMs?: number
  /** Override wall clock. */
  now?: () => Date
  /** When true, emit decisions but don't write. */
  dryRun?: boolean
  log?: (msg: string) => void
}

export interface SynthDecision {
  slug: string
  action: 'synth' | 'skip-recent' | 'skip-low-count' | 'skip-budget' | 'skip-empty-mentions'
  rationale: string
}

export interface SynthesizerResult {
  scanned: number
  eligible: number
  synthesized: number
  errors: number
  decisions: SynthDecision[]
}

interface SynthState {
  synth?: Record<string, { lastSynthAt: string; mentionCountAtSynth: number }>
}

const STATE_FILE = '.curator-state.json'
const MAX_MENTIONS_IN_PROMPT = 25
const MAX_ABOUT_CHARS = 500

export async function runSynthesizer(
  options: SynthesizerOptions
): Promise<SynthesizerResult> {
  const minMentions = options.minMentions ?? 3
  const maxPerPass = options.maxPerPass ?? 20
  const resynthDelta = options.resynthMentionDelta ?? 3
  const resynthAfterMs = options.resynthAfterMs ?? 7 * 24 * 60 * 60 * 1000
  const now = options.now ? options.now() : new Date()
  const log = options.log ?? (() => {})
  const dryRun = options.dryRun === true

  const entitiesDir = join(options.wikiDir, 'entities')
  const result: SynthesizerResult = {
    scanned: 0,
    eligible: 0,
    synthesized: 0,
    errors: 0,
    decisions: [],
  }

  if (!existsSync(entitiesDir)) {
    log(`[synth] entities dir does not exist yet: ${entitiesDir}`)
    return result
  }

  const state = await loadState(options.wikiDir)
  const synthState = state.synth ?? {}

  // Discover candidates.
  const entries = await readdir(entitiesDir)
  const mdFiles = entries.filter((f) => f.endsWith('.md'))

  type Candidate = {
    slug: string
    path: string
    parsed: ReturnType<typeof parseEntityMd>
  }
  const candidates: Candidate[] = []

  for (const file of mdFiles) {
    const slug = file.slice(0, -'.md'.length)
    const path = join(entitiesDir, file)
    try {
      const s = await stat(path)
      if (!s.isFile()) continue
    } catch {
      continue
    }
    const text = await readFile(path, 'utf-8')
    const parsed = parseEntityMd(text)
    if (!parsed) continue
    result.scanned += 1
    candidates.push({ slug, path, parsed })
  }

  // Eligibility filtering.
  const eligible: Candidate[] = []
  for (const c of candidates) {
    const fm = c.parsed!.frontmatter
    if (fm.mentionCount < minMentions) {
      result.decisions.push({
        slug: c.slug,
        action: 'skip-low-count',
        rationale: `mention_count ${fm.mentionCount} < ${minMentions}`,
      })
      continue
    }
    const prev = synthState[c.slug]
    if (prev) {
      const growth = fm.mentionCount - prev.mentionCountAtSynth
      const ageMs = now.getTime() - Date.parse(prev.lastSynthAt)
      if (growth < resynthDelta && ageMs < resynthAfterMs) {
        result.decisions.push({
          slug: c.slug,
          action: 'skip-recent',
          rationale: `growth ${growth} < ${resynthDelta} and synth age ${Math.round(ageMs / 86_400_000)}d`,
        })
        continue
      }
    }
    eligible.push(c)
  }
  result.eligible = eligible.length

  // Sort: ungenerated first, then by mention_count desc.
  eligible.sort((a, b) => {
    const aHas = !!synthState[a.slug]
    const bHas = !!synthState[b.slug]
    if (aHas !== bHas) return aHas ? 1 : -1
    return b.parsed!.frontmatter.mentionCount - a.parsed!.frontmatter.mentionCount
  })

  const budget = eligible.slice(0, maxPerPass)
  for (const c of eligible.slice(maxPerPass)) {
    result.decisions.push({
      slug: c.slug,
      action: 'skip-budget',
      rationale: `exceeded maxPerPass=${maxPerPass}`,
    })
  }

  for (const c of budget) {
    const fm = c.parsed!.frontmatter
    const mentionsPath = join(entitiesDir, `${c.slug}.mentions.jsonl`)
    const mentions = await readMentions(mentionsPath, MAX_MENTIONS_IN_PROMPT)
    if (mentions.length === 0) {
      result.decisions.push({
        slug: c.slug,
        action: 'skip-empty-mentions',
        rationale: 'no .mentions.jsonl file or empty',
      })
      continue
    }

    if (dryRun) {
      result.decisions.push({
        slug: c.slug,
        action: 'synth',
        rationale: `would synthesize (mentions=${fm.mentionCount}, sample=${mentions.length})`,
      })
      result.synthesized += 1
      continue
    }

    try {
      const aboutText = await synthesizeAbout(options.llm, c.parsed!.frontmatter, mentions)
      if (!aboutText) {
        result.decisions.push({
          slug: c.slug,
          action: 'synth',
          rationale: 'LLM returned empty — skipped write',
        })
        continue
      }
      const updatedBody = spliceAbout(c.parsed!.body, fm.name, aboutText)
      const newDoc = serializeEntityMd({ frontmatter: fm, body: updatedBody })
      await writeFile(c.path, newDoc, 'utf-8')
      synthState[c.slug] = {
        lastSynthAt: now.toISOString(),
        mentionCountAtSynth: fm.mentionCount,
      }
      result.synthesized += 1
      result.decisions.push({
        slug: c.slug,
        action: 'synth',
        rationale: `wrote ${aboutText.length}-char About`,
      })
    } catch (err) {
      result.errors += 1
      log(`[synth] failed for ${c.slug}: ${(err as Error).message}`)
    }
  }

  if (!dryRun) {
    await saveState(options.wikiDir, { ...state, synth: synthState })
  }

  return result
}

// ---------------- LLM ----------------

const SYSTEM_PROMPT = `You write very short "About" descriptions for entities in a developer's personal knowledge graph.

Rules:
- 1 to 3 sentences. Plain text, no markdown, no headers, no bullet points.
- Describe what the entity IS and why it shows up in the user's captures, based ONLY on the mentions provided.
- Do not speculate, invent names, or add details that aren't in the input.
- If mentions are OCR-garbled noise with no clear meaning, output exactly: SKIP
- Output ONLY the About text or SKIP — no preamble, no quoting, no "Here is...".`

async function synthesizeAbout(
  llm: LlmClient,
  fm: { name: string; type: string; aliases: string[] },
  mentions: string[]
): Promise<string> {
  const userPrompt = [
    `Entity: ${fm.name}`,
    `Type: ${fm.type}`,
    fm.aliases.length > 0 ? `Aliases: ${fm.aliases.join(', ')}` : '',
    '',
    'Mentions (most recent first):',
    ...mentions.map((m, i) => `${i + 1}. ${m}`),
  ]
    .filter(Boolean)
    .join('\n')

  const raw = await llm.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ])
  return sanitizeAbout(raw)
}

export function sanitizeAbout(raw: string): string {
  const cleaned = raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  if (!cleaned) return ''
  if (/^SKIP\b/i.test(cleaned)) return ''
  // reject anything that looks like a JSON/tool dump
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) return ''
  return cleaned.slice(0, MAX_ABOUT_CHARS)
}

async function readMentions(path: string, max: number): Promise<string[]> {
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf-8')
  const lines = text.split('\n').filter((l) => l.trim())
  // Most-recent-first by parse order — file is append-only chronological,
  // so reverse and take first N.
  const recent = lines.slice(-max).reverse()
  return recent.map(prettifyMention)
}

function prettifyMention(jsonLine: string): string {
  try {
    const obj = JSON.parse(jsonLine) as Record<string, unknown>
    const ts = typeof obj.ts === 'string' ? obj.ts.slice(0, 16) : ''
    const source = typeof obj.source === 'string' ? obj.source : ''
    const app = typeof obj.app === 'string' ? obj.app : ''
    const excerpt = typeof obj.excerpt === 'string' ? obj.excerpt.slice(0, 200) : ''
    return `[${ts}] ${source}/${app}: ${excerpt}`.trim()
  } catch {
    return jsonLine.slice(0, 200)
  }
}

// ---------------- body splice ----------------

export function spliceAbout(body: string, name: string, aboutText: string): string {
  const text = body.replace(/^\n+/, '')
  const lines = text.split('\n')

  // Find header line "# <name>" (allow any case/whitespace)
  let titleIdx = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (titleIdx < 0) {
    // No title — prepend a synthesized one.
    return `# ${name}\n\n## About\n\n${aboutText}\n\n${text}`
  }

  // Find existing ## About section (case-insensitive).
  const aboutHeaderRe = /^##\s+about\b/i
  let aboutStart = -1
  let aboutEnd = -1
  for (let i = titleIdx + 1; i < lines.length; i++) {
    if (aboutHeaderRe.test(lines[i]!)) {
      aboutStart = i
      // find next ## or end
      aboutEnd = lines.length
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j]!)) {
          aboutEnd = j
          break
        }
      }
      break
    }
  }

  const aboutBlock = ['## About', '', aboutText, '']
  if (aboutStart >= 0) {
    // Replace existing block.
    const before = lines.slice(0, aboutStart)
    const after = lines.slice(aboutEnd)
    return [...before, ...aboutBlock, ...after].join('\n').replace(/\n{3,}/g, '\n\n')
  }

  // Insert after title (skip a blank line after title if present).
  let insertAt = titleIdx + 1
  if (insertAt < lines.length && lines[insertAt] === '') insertAt += 1
  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)
  // Ensure single blank line before About
  if (before.length > 0 && before[before.length - 1] !== '') before.push('')
  return [...before, ...aboutBlock, ...after].join('\n').replace(/\n{3,}/g, '\n\n')
}

// ---------------- state ----------------

async function loadState(wikiDir: string): Promise<SynthState> {
  const path = join(wikiDir, STATE_FILE)
  if (!existsSync(path)) return {}
  try {
    const text = await readFile(path, 'utf-8')
    return JSON.parse(text) as SynthState
  } catch {
    return {}
  }
}

async function saveState(wikiDir: string, state: SynthState): Promise<void> {
  const path = join(wikiDir, STATE_FILE)
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}
