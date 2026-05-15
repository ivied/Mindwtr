/**
 * Markdown chunker for procedural memory files.
 *
 * Splits a markdown file into sections by `##` H2 headings. Each section
 * becomes one chunk with the heading as `section_title` and the body as
 * `text`. The H1 (single `#` heading) is treated as document title and
 * not split on. Lines before the first `##` are emitted as a leading
 * "header" chunk so frontmatter / preamble is still retrievable.
 *
 * Why `##`-only: OpenClaw's MEMORY.md and journals use `##` as their
 * primary topic separator (`## Серега`, `## Slack`, `## Notion`, ...).
 * Going finer (`###`, `####`) shreds context that belongs together for
 * Proposer prompting. Going coarser (`#`) leaves the whole file as one
 * massive chunk.
 *
 * Minimum chunk body is 30 chars (skip near-empty sections).
 */

const MIN_BODY = 30

export interface RawChunk {
  /** 0..N within the file. */
  index: number
  /** The H2 heading line, including the `## ` prefix. Empty for leading preamble. */
  sectionTitle: string
  /** Body text excluding the heading line. */
  text: string
}

export function chunkMarkdown(content: string): RawChunk[] {
  const lines = content.split(/\r?\n/)
  const sections: { title: string; bodyLines: string[] }[] = []
  let current: { title: string; bodyLines: string[] } = { title: '', bodyLines: [] }

  for (const line of lines) {
    if (/^##\s+\S/.test(line)) {
      // New H2 — close the previous section, start fresh.
      sections.push(current)
      current = { title: line, bodyLines: [] }
    } else {
      current.bodyLines.push(line)
    }
  }
  sections.push(current)

  const out: RawChunk[] = []
  let index = 0
  for (const s of sections) {
    const text = s.bodyLines.join('\n').trim()
    if (text.length < MIN_BODY) continue
    out.push({
      index,
      sectionTitle: s.title.trim(),
      text,
    })
    index += 1
  }
  return out
}
