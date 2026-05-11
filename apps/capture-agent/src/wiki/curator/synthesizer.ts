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
      const sections = await synthesizeEntity(options.llm, c.parsed!.frontmatter, mentions)
      if (!sections.about && !sections.timeline) {
        result.decisions.push({
          slug: c.slug,
          action: 'synth',
          rationale: 'LLM returned empty — skipped write',
        })
        continue
      }
      let updatedBody = c.parsed!.body
      if (sections.about) {
        updatedBody = spliceSection(updatedBody, fm.name, 'About', sections.about)
      }
      if (sections.timeline) {
        updatedBody = spliceSection(updatedBody, fm.name, 'Timeline', sections.timeline)
      }
      const newDoc = serializeEntityMd({ frontmatter: fm, body: updatedBody })
      await writeFile(c.path, newDoc, 'utf-8')
      synthState[c.slug] = {
        lastSynthAt: now.toISOString(),
        mentionCountAtSynth: fm.mentionCount,
      }
      result.synthesized += 1
      const wroteParts = [
        sections.about ? `${sections.about.length}-char About` : '',
        sections.timeline ? `${sections.timeline.split('\n').filter((l) => l.trim()).length}-line Timeline` : '',
      ]
        .filter(Boolean)
        .join(' + ')
      result.decisions.push({
        slug: c.slug,
        action: 'synth',
        rationale: `wrote ${wroteParts}`,
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

const SYSTEM_PROMPT = `You write two short sections for an entity in a developer's personal knowledge graph.

Output exactly this format (omit a section if there's nothing meaningful to say there):

## About
<1-3 sentences describing what the entity IS and why it shows up in the user's captures>

## Timeline
- YYYY-MM-DD: <event in 1 short clause>
- YYYY-MM-DD: <event in 1 short clause>
(3-8 milestones max — only events clearly grounded in the mentions; skip if there's no clear timeline arc)

Rules:
- Use ONLY information from the mentions. No speculation, no invented names/dates.
- Plain text inside About — no bullets or sub-headers.
- Timeline dates come from the timestamps in the mentions; group nearby events into one milestone if they describe the same thing.
- If mentions are OCR-garbled noise with no meaning, output exactly: SKIP
- Output ONLY the section blocks above. No preamble, no closing summary, no quoting, no fences.`

interface SynthSections {
  about: string
  timeline: string
}

export async function synthesizeEntity(
  llm: LlmClient,
  fm: { name: string; type: string; aliases: string[] },
  mentions: string[]
): Promise<SynthSections> {
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
  return parseSynthOutput(raw)
}

export function parseSynthOutput(raw: string): SynthSections {
  const cleaned = raw
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  if (!cleaned || /^SKIP\b/i.test(cleaned)) return { about: '', timeline: '' }
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) return { about: '', timeline: '' }

  const about = extractSection(cleaned, 'about')
  const timeline = extractSection(cleaned, 'timeline')
  return {
    about: about.slice(0, MAX_ABOUT_CHARS),
    timeline: sanitizeTimeline(timeline),
  }
}

function extractSection(text: string, name: string): string {
  const re = new RegExp(`^##\\s+${name}\\s*$`, 'im')
  const m = text.match(re)
  if (!m) {
    // If there's no header at all and the response is just prose, assume it's the About text.
    if (name === 'about' && !/^##\s+/m.test(text)) return text.trim()
    return ''
  }
  const start = m.index! + m[0].length
  const rest = text.slice(start)
  const nextHeader = rest.search(/^##\s+/m)
  const body = nextHeader >= 0 ? rest.slice(0, nextHeader) : rest
  return body.trim()
}

function sanitizeTimeline(raw: string): string {
  if (!raw) return ''
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  // keep only lines that look like "- YYYY-MM-DD: ..." or "- YYYY-MM: ..."
  const kept = lines.filter((l) => /^-\s*\d{4}(-\d{2}){0,2}\s*[:·—-]/.test(l))
  return kept.join('\n')
}

/** @deprecated — kept for backwards-compat with older tests that imported it. */
export function sanitizeAbout(raw: string): string {
  return parseSynthOutput(raw).about
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

/**
 * Insert (or replace) a `## <sectionName>` block in `body`, anchored just
 * after the `# <title>` heading. Each curator-owned section is updated
 * independently; rollup's `extractCustomSections` round-trips everything
 * between the title and `## Related` so these blocks survive.
 *
 * Ordering for new inserts: synthesizer writes About first, then Timeline,
 * so calling spliceSection twice produces "## About, ## Timeline" in that
 * order. Replacement is in-place at the existing header position.
 */
export function spliceSection(
  body: string,
  name: string,
  sectionName: string,
  sectionText: string
): string {
  const text = body.replace(/^\n+/, '')
  const lines = text.split('\n')
  const headerEsc = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headerRe = new RegExp(`^##\\s+${headerEsc}\\b`, 'i')

  let titleIdx = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (titleIdx < 0) {
    return `# ${name}\n\n## ${sectionName}\n\n${sectionText}\n\n${text}`
  }

  // Find existing block.
  let blockStart = -1
  let blockEnd = -1
  for (let i = titleIdx + 1; i < lines.length; i++) {
    if (headerRe.test(lines[i]!)) {
      blockStart = i
      blockEnd = lines.length
      for (let j = i + 1; j < lines.length; j++) {
        if (/^##\s+/.test(lines[j]!)) {
          blockEnd = j
          break
        }
      }
      break
    }
  }

  const block = [`## ${sectionName}`, '', sectionText, '']
  if (blockStart >= 0) {
    const before = lines.slice(0, blockStart)
    const after = lines.slice(blockEnd)
    return [...before, ...block, ...after].join('\n').replace(/\n{3,}/g, '\n\n')
  }

  // New insert: place the new block just before the first rollup-owned
  // section (Related / Recent mentions). Curator-owned sections (About,
  // Timeline, …) thus accumulate in call order between the title and the
  // rollup-owned tail.
  const rollupOwnedRe = /^##\s+(Related|Recent mentions\b)/i
  let insertAt = lines.length
  for (let i = titleIdx + 1; i < lines.length; i++) {
    if (rollupOwnedRe.test(lines[i]!)) {
      insertAt = i
      break
    }
  }
  const before = lines.slice(0, insertAt)
  const after = lines.slice(insertAt)
  // trim trailing blank lines on `before`
  while (before.length > 0 && before[before.length - 1] === '') before.pop()
  if (before.length > 0) before.push('')
  return [...before, ...block, ...after].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** @deprecated — kept for backwards-compat with older tests. Prefer spliceSection. */
export function spliceAbout(body: string, name: string, aboutText: string): string {
  return spliceSection(body, name, 'About', aboutText)
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
