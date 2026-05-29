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
import { isSelfObservingCapture } from '../self-observation'

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
const MAX_MENTIONS_IN_PROMPT = 40
/** Per-mention cap on full capture body text fed to the LLM (chars). */
const MAX_CAPTURE_BODY_CHARS = 500
const MAX_ABOUT_CHARS = 500
/** How many co-occurrence candidates to hand the LLM for relationship typing. */
const MAX_RELATED_CANDIDATES = 20
const MAX_RELATIONSHIPS_CHARS = 800

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

  // Process entities through a bounded concurrency pool. Each is an
  // independent LLM call; serial was fine for the 20/pass scheduled cadence
  // but far too slow for a forced full re-synth of every entity. State is
  // updated in memory per-entity (safe — single-threaded) and persisted once
  // at the end, so concurrent writes never race the state file.
  const concurrency = Math.max(1, Number(process.env.WIKI_SYNTH_CONCURRENCY ?? 6))

  const processOne = async (c: Candidate): Promise<void> => {
    const fm = c.parsed!.frontmatter
    const relatedCandidates = (fm.related ?? [])
      .slice(0, MAX_RELATED_CANDIDATES)
      .map((r) => r.slug)
    const mentions = await gatherMentions(
      entitiesDir,
      c.slug,
      relatedCandidates,
      MAX_MENTIONS_IN_PROMPT
    )
    if (mentions.length === 0) {
      result.decisions.push({
        slug: c.slug,
        action: 'skip-empty-mentions',
        rationale: 'no .mentions.jsonl file or empty',
      })
      return
    }

    if (dryRun) {
      result.decisions.push({
        slug: c.slug,
        action: 'synth',
        rationale: `would synthesize (mentions=${fm.mentionCount}, sample=${mentions.length})`,
      })
      result.synthesized += 1
      return
    }

    try {
      // gatherMentions already guaranteed captures co-occurring with each
      // candidate are in the sample; the LLM verifies each candidate against
      // that evidence and drops screen-adjacency noise.
      const sections = await synthesizeEntity(
        options.llm,
        c.parsed!.frontmatter,
        mentions,
        relatedCandidates
      )
      if (!sections.about && !sections.timeline && !sections.relationships) {
        result.decisions.push({
          slug: c.slug,
          action: 'synth',
          rationale: 'LLM returned empty — skipped write',
        })
        return
      }
      let updatedBody = c.parsed!.body
      if (sections.about) {
        updatedBody = spliceSection(updatedBody, fm.name, 'About', sections.about)
      }
      if (sections.timeline) {
        updatedBody = spliceSection(updatedBody, fm.name, 'Timeline', sections.timeline)
      }
      if (sections.relationships) {
        updatedBody = spliceSection(updatedBody, fm.name, 'Relationships', sections.relationships)
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
        sections.relationships ? `${sections.relationships.split('\n').filter((l) => l.trim().startsWith('-')).length}-rel Relationships` : '',
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

  let nextIdx = 0
  const worker = async () => {
    while (true) {
      const i = nextIdx++
      if (i >= budget.length) return
      await processOne(budget[i]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, budget.length) }, worker)
  )

  if (!dryRun) {
    await saveState(options.wikiDir, { ...state, synth: synthState })
  }

  return result
}

// ---------------- LLM ----------------

const SYSTEM_PROMPT = `You write up to three short sections for an entity in a developer's personal knowledge graph.

Output exactly this format (omit a section if there's nothing meaningful to say there):

## About
<1-3 sentences describing what the entity IS and why it shows up in the user's captures>

## Timeline
- YYYY-MM-DD: <event in 1 short clause>
- YYYY-MM-DD: <event in 1 short clause>
(3-8 milestones max — only events clearly grounded in the mentions; skip if there's no clear timeline arc)

## Relationships
- <candidate-slug> — <short plain-language phrase describing how it relates to this entity, grounded in the mentions>

Rules:
- Use ONLY information from the mentions. No speculation, no invented names/dates.
- Plain text inside About — no bullets or sub-headers.
- Timeline dates come from the timestamps in the mentions; group nearby events into one milestone if they describe the same thing.
- Relationships: you are given CANDIDATE related entities — they merely appeared on screen at the same time, which does NOT mean they are related. Include a candidate ONLY when the mentions actually show how it relates to this entity, and describe that relation in a short natural phrase (e.g. "client who commissioned the build", "freelancer doing the API", "separate project, unrelated", "deploy target"). If a candidate has no real evidence in the mentions, OMIT it. Never guess. Omit ambient noise (radio/music apps, OS chrome, unrelated apps/tabs) entirely. It is correct to output few or zero relationships.
- If mentions are OCR-garbled noise with no meaning, output exactly: SKIP
- Output ONLY the section blocks above. No preamble, no closing summary, no quoting, no fences.`

interface SynthSections {
  about: string
  timeline: string
  relationships: string
}

export async function synthesizeEntity(
  llm: LlmClient,
  fm: { name: string; type: string; aliases: string[] },
  mentions: string[],
  relatedCandidates: string[] = []
): Promise<SynthSections> {
  const userPrompt = [
    `Entity: ${fm.name}`,
    `Type: ${fm.type}`,
    fm.aliases.length > 0 ? `Aliases: ${fm.aliases.join(', ')}` : '',
    relatedCandidates.length > 0
      ? `Candidate related entities (co-occurred on screen — verify against mentions before trusting): ${relatedCandidates.join(', ')}`
      : '',
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
  if (!cleaned || /^SKIP\b/i.test(cleaned))
    return { about: '', timeline: '', relationships: '' }
  if (cleaned.startsWith('{') || cleaned.startsWith('['))
    return { about: '', timeline: '', relationships: '' }

  const about = extractSection(cleaned, 'about')
  const timeline = extractSection(cleaned, 'timeline')
  const relationships = extractSection(cleaned, 'relationships')
  return {
    about: about.slice(0, MAX_ABOUT_CHARS),
    timeline: sanitizeTimeline(timeline),
    relationships: relationships.slice(0, MAX_RELATIONSHIPS_CHARS),
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

interface MentionRecord {
  path: string
  excerpt: string
  ts: string
  source: string
  app: string
}

function parseMentionFile(text: string): MentionRecord[] {
  // Newest-first (file is append-only chronological).
  const out: MentionRecord[] = []
  for (const line of text.split('\n').filter((l) => l.trim()).reverse()) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      out.push({
        path: typeof o.capturePath === 'string' ? o.capturePath : '',
        excerpt: typeof o.excerpt === 'string' ? o.excerpt : '',
        ts: typeof o.ts === 'string' ? o.ts : '',
        source: typeof o.source === 'string' ? o.source : '',
        app: typeof o.app === 'string' ? o.app : '',
      })
    } catch {
      /* skip malformed */
    }
  }
  return out
}

/**
 * Build the mention sample fed to the LLM. Two goals beyond "recent captures":
 *
 *  1. Guarantee relationship evidence. For each co-occurrence candidate, pull
 *     a couple of captures where the candidate AND this entity actually appear
 *     together (intersection of their capturePaths). Without this, a strict
 *     "recent only" sample drops real relationships (e.g. a client discussed
 *     weeks ago) just because newer captures crowd them out.
 *  2. Diversity. Dedup repeated excerpts so identical phrases don't eat the
 *     budget, and skip self-referential meta-captures (where the entity's own
 *     wiki page is what's on screen) — those describe the tooling, not the
 *     entity.
 */
export async function gatherMentions(
  entitiesDir: string,
  slug: string,
  candidates: string[],
  max: number
): Promise<string[]> {
  const selfPath = join(entitiesDir, `${slug}.mentions.jsonl`)
  if (!existsSync(selfPath)) return []
  const records = parseMentionFile(await readFile(selfPath, 'utf-8'))

  // candidate slug -> set of capturePaths it appears in
  const candPaths = new Map<string, Set<string>>()
  for (const cand of candidates) {
    const cp = join(entitiesDir, `${cand}.mentions.jsonl`)
    if (!existsSync(cp)) continue
    const set = new Set<string>()
    for (const r of parseMentionFile(await readFile(cp, 'utf-8'))) {
      if (r.path) set.add(r.path)
    }
    candPaths.set(cand, set)
  }

  const usedPaths = new Set<string>()
  const usedExcerpt = new Set<string>()
  const chosen: MentionRecord[] = []
  const EVIDENCE_PER_CANDIDATE = 2

  const take = (r: MentionRecord) => {
    if (r.path && usedPaths.has(r.path)) return
    if (r.path) usedPaths.add(r.path)
    const ek = r.excerpt.trim().toLowerCase()
    if (ek) usedExcerpt.add(ek)
    chosen.push(r)
  }

  // Pass 1: relationship evidence — a few co-occurring captures per candidate.
  // (Only possible for records that carry a capturePath.)
  for (const cand of candidates) {
    const set = candPaths.get(cand)
    if (!set) continue
    let added = 0
    for (const r of records) {
      if (added >= EVIDENCE_PER_CANDIDATE || chosen.length >= max) break
      if (r.path && set.has(r.path) && !usedPaths.has(r.path)) {
        take(r)
        added += 1
      }
    }
    if (chosen.length >= max) break
  }

  // Pass 2: fill remaining budget with recent, distinct-excerpt captures.
  for (const r of records) {
    if (chosen.length >= max) break
    const ek = r.excerpt.trim().toLowerCase()
    if (ek && usedExcerpt.has(ek)) continue
    take(r)
  }

  // Read full bodies, skipping meta-captures (the entity's own wiki page).
  const out: string[] = []
  for (const r of chosen) {
    const content = await readCaptureContent(r, slug)
    if (content === null) continue
    out.push(`[${r.ts.slice(0, 16)}] ${r.source}/${r.app}: ${content}`.trim())
  }
  return out
}

/**
 * Return the full capture body (capped), or the excerpt as fallback. Returns
 * null when the capture is self-referential meta-noise — i.e. it's showing
 * this entity's own wiki page (frontmatter `slug: <slug>` or the entity .md
 * filename on screen), which describes the knowledge-graph tooling rather
 * than the entity itself.
 */
async function readCaptureContent(r: MentionRecord, slug: string): Promise<string | null> {
  const excerpt = r.excerpt.slice(0, 200)
  if (!r.path || !existsSync(r.path)) return excerpt
  try {
    const raw = await readFile(r.path, 'utf-8')
    const body = stripFrontmatter(raw).replace(/\s+/g, ' ').trim()
    const lower = body.toLowerCase()
    if (lower.includes(`slug: ${slug}`) || lower.includes(`entities/${slug}.md`)) {
      return null
    }
    // The GTD/Mindwtr task-manager UI on screen — the entity is just a row in
    // a list; nothing here describes the entity itself. Drop it.
    if (isSelfObservingCapture(body)) return null
    return body.length > excerpt.length ? body.slice(0, MAX_CAPTURE_BODY_CHARS) : excerpt
  } catch {
    return excerpt
  }
}

function stripFrontmatter(md: string): string {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end >= 0) return md.slice(md.indexOf('\n', end + 1) + 1)
  }
  return md
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
