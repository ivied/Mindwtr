/**
 * Markdown chunker for procedural memory files (FR85 + FR87).
 *
 * Two-level split:
 *
 *  1. By `##` H2 headings into topical sections (`## Серега`, `## Slack`,
 *     `## Как работать с Notion`, ...). The H1 (`# ...`) is the document
 *     title and is stripped from the leading preamble so a file that
 *     opens with just a title doesn't become a junk chunk.
 *
 *  2. FR87 — within a *large* section, further split the body into
 *     sub-chunks so a section that mixes universal rules with
 *     OpenClaw-runtime specifics doesn't get classified (and hidden)
 *     wholesale. Each sub-chunk keeps the parent `## heading` as its
 *     `sectionTitle`, so retrieval + the KNOWN_PLAYBOOK prompt still
 *     group them under one topic, but classification operates per
 *     sub-chunk.
 *
 * Sub-split strategy (boundary-aligned, merge-small):
 *  - Sections shorter than SECTION_SPLIT_THRESHOLD stay one chunk —
 *    short sections rarely mix concerns and over-fragmenting hurts
 *    retrieval context.
 *  - Larger sections are tokenised into blocks at blank-line runs and
 *    forced breaks before `###` sub-headers. OpenClaw's MEMORY.md bullet
 *    lists often have NO blank lines, so any block still over
 *    SUBCHUNK_TARGET is additionally exploded on bullet-item boundaries
 *    (never mid-bullet — indented continuation lines stay with their
 *    bullet). We flush a sub-chunk at every natural boundary *once it
 *    has accumulated at least MIN_SUBCHUNK chars* — so a section that
 *    mixes a universal bullet-group and an OpenClaw bullet-group splits
 *    along that seam instead of being packed together. Tiny fragments
 *    below MIN_SUBCHUNK are merged forward so we never emit a lone
 *    bullet stripped of context.
 *
 * `index` is a flat running counter over ALL emitted sub-chunks (not the
 * `##` ordinal) so ProceduralStore keying on (source, path, index)
 * stays correct without a schema change. Sub-chunks of the same section
 * share `sectionTitle`.
 */

const MIN_BODY = 30
const SECTION_SPLIT_THRESHOLD = 600
const SUBCHUNK_TARGET = 500
const MIN_SUBCHUNK = 80

export interface RawChunk {
  /** Flat 0..N index over every emitted sub-chunk in the file. */
  index: number
  /** The H2 heading line, including `## `. Empty for leading preamble. */
  sectionTitle: string
  /** Body text of this (sub-)chunk. */
  text: string
}

interface Section {
  title: string
  bodyLines: string[]
}

export function chunkMarkdown(content: string): RawChunk[] {
  const sections = splitSections(content)

  const out: RawChunk[] = []
  let index = 0
  for (const s of sections) {
    // Strip the document H1 from a title-less preamble section.
    const bodyLines =
      s.title === ''
        ? s.bodyLines.filter((l) => !/^#\s+\S/.test(l))
        : s.bodyLines
    const body = bodyLines.join('\n').trim()
    if (body.length < MIN_BODY) continue

    const subTexts =
      body.length < SECTION_SPLIT_THRESHOLD ? [body] : splitIntoSubChunks(body)

    for (const text of subTexts) {
      if (text.length < MIN_BODY) continue
      out.push({ index, sectionTitle: s.title.trim(), text })
      index += 1
    }
  }
  return out
}

function splitSections(content: string): Section[] {
  const lines = content.split(/\r?\n/)
  const sections: Section[] = []
  let current: Section = { title: '', bodyLines: [] }
  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      sections.push(current)
      current = { title: line, bodyLines: [] }
    } else {
      current.bodyLines.push(line)
    }
  }
  sections.push(current)
  return sections
}

/**
 * Split a section body into blocks, then greedily pack into sub-chunks.
 * A "block" is a paragraph / bullet-group delimited by a blank line, or a
 * `###`-headed sub-section (the `###` line starts a new block and the
 * block runs until the next blank line or `###`).
 */
function splitIntoSubChunks(body: string): string[] {
  // splitBlocks separates on blank lines / ### headers. OpenClaw's
  // MEMORY.md bullet lists frequently have NO blank lines between
  // bullets, so a 2000-char section can be a single block that
  // splitBlocks never cuts. explodeOversizedBlocks falls back to
  // bullet-item boundaries for any block over the target, so a flat
  // wall of bullets still splits along rule seams.
  const blocks = explodeOversizedBlocks(splitBlocks(body))
  const subs: string[] = []
  let buf: string[] = []
  let bufLen = 0

  const flush = () => {
    if (buf.length === 0) return
    subs.push(buf.join('\n\n').trim())
    buf = []
    bufLen = 0
  }

  for (const block of blocks) {
    // Flush at this natural boundary if what we've accumulated is
    // already a self-contained sub-chunk. This aligns sub-chunk seams
    // to topic shifts (blank line / ### header) rather than to an
    // arbitrary size target — so a universal group and an OpenClaw
    // group in the same section end up in different sub-chunks.
    if (bufLen >= MIN_SUBCHUNK) flush()
    buf.push(block)
    bufLen += block.length + 2
    // Upper bound: a single huge block still gets cut so one runaway
    // block can't swallow the whole budget downstream.
    if (bufLen >= SUBCHUNK_TARGET) flush()
  }
  flush()

  // Merge a tiny trailing remainder into the previous sub-chunk so we
  // never strip a lone bullet of its surrounding context.
  if (subs.length >= 2) {
    const last = subs[subs.length - 1]!
    if (last.length < MIN_SUBCHUNK) {
      subs[subs.length - 2] = `${subs[subs.length - 2]}\n\n${last}`
      subs.pop()
    }
  }
  return subs.length > 0 ? subs : [body]
}

/** A line that starts a new top-level list item (`-`, `*`, `+`, `1.`). */
function isBulletStart(line: string): boolean {
  return /^\s{0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+)\S/.test(line)
}

/**
 * Any block longer than SUBCHUNK_TARGET that has no internal blank-line
 * structure (a flat bullet list) is re-split on bullet-item boundaries.
 * We accumulate lines and only cut *before* a line that begins a new
 * top-level bullet once the run has reached the target — so a bullet and
 * its indented continuation lines never get severed mid-rule.
 */
function explodeOversizedBlocks(blocks: string[]): string[] {
  const out: string[] = []
  for (const block of blocks) {
    if (block.length <= SUBCHUNK_TARGET) {
      out.push(block)
      continue
    }
    const lines = block.split('\n')
    let run: string[] = []
    let runLen = 0
    const flushRun = () => {
      if (run.length === 0) return
      const joined = run.join('\n').trim()
      if (joined.length > 0) out.push(joined)
      run = []
      runLen = 0
    }
    for (const line of lines) {
      if (runLen >= SUBCHUNK_TARGET && isBulletStart(line)) {
        flushRun()
      }
      run.push(line)
      runLen += line.length + 1
    }
    flushRun()
  }
  return out
}

function splitBlocks(body: string): string[] {
  const lines = body.split(/\r?\n/)
  const blocks: string[] = []
  let cur: string[] = []

  const push = () => {
    const joined = cur.join('\n').trim()
    if (joined.length > 0) blocks.push(joined)
    cur = []
  }

  for (const line of lines) {
    const isSubHeader = /^#{3,}\s+\S/.test(line)
    if (isSubHeader) {
      // `###` starts a fresh block.
      push()
      cur.push(line)
    } else if (line.trim() === '') {
      // Blank line ends the current block.
      push()
    } else {
      cur.push(line)
    }
  }
  push()
  return blocks
}
