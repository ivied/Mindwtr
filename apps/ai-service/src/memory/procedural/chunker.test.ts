import { describe, it, expect } from 'bun:test'
import { chunkMarkdown } from './chunker'

describe('chunkMarkdown', () => {
  it('splits by ## headers and keeps each section as one chunk', () => {
    const md = `# MEMORY.md

## Серега
- Name: Sergey
- TZ: Buenos Aires

## Slack
- ⚠️ ВСЕГДА reply_to_current
- README на русском

## Notion
- Каждую задачу — сразу в Notion
`
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBe(3)
    expect(chunks[0]!.sectionTitle).toBe('## Серега')
    expect(chunks[0]!.text).toContain('Sergey')
    expect(chunks[1]!.sectionTitle).toBe('## Slack')
    expect(chunks[1]!.text).toContain('reply_to_current')
    expect(chunks[2]!.sectionTitle).toBe('## Notion')
    expect(chunks[2]!.text).toContain('сразу в Notion')
  })

  it('emits a leading preamble chunk when content precedes the first ##', () => {
    const md = `# Title
Preamble line one with enough text to clear the 30 char minimum body.
And more.

## Section A
body of A is long enough as well
`
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBe(2)
    expect(chunks[0]!.sectionTitle).toBe('') // preamble has no H2 title
    expect(chunks[0]!.text).toContain('Preamble line one')
    expect(chunks[0]!.text).not.toContain('# Title') // H1 stripped from preamble
    expect(chunks[1]!.sectionTitle).toBe('## Section A')
  })

  it('drops a preamble that is ONLY a document H1 (no substantive body)', () => {
    // Real-world: OpenClaw MEMORY.md opens with
    // `# MEMORY.md — Долгосрочная память` then jumps to `## Серега`.
    // That bare H1 must not become a junk chunk.
    const md = `# MEMORY.md — Долгосрочная память

## Серега
- Name: Sergey
- TZ: Buenos Aires GMT-3
`
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.sectionTitle).toBe('## Серега')
  })

  it('drops sections whose body is below the minimum length', () => {
    const md = `## A
short

## B
this body is more than thirty characters wide for sure
`
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.sectionTitle).toBe('## B')
  })

  it('treats ### and lower as part of the parent ## section', () => {
    const md = `## Parent
intro line for parent that exceeds the minimum length easily

### Child
detail under parent — should stay glued
`
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.text).toContain('### Child')
    expect(chunks[0]!.text).toContain('detail under parent')
  })

  it('renumbers section_index sequentially even when sections are skipped', () => {
    const md = `## Empty

## Real
this is the only real section with enough body content
`
    const chunks = chunkMarkdown(md)
    expect(chunks.length).toBe(1)
    expect(chunks[0]!.index).toBe(0)
  })

  describe('FR87 sub-section chunking', () => {
    it('keeps a short section as a single chunk (below split threshold)', () => {
      const md = `## Slack
- ⚠️ reply in threads
- README на русском
`
      const chunks = chunkMarkdown(md)
      expect(chunks.length).toBe(1)
      expect(chunks[0]!.sectionTitle).toBe('## Slack')
    })

    it('splits a large mixed section into sub-chunks sharing the parent title', () => {
      const universalBlock = Array.from(
        { length: 12 },
        (_, i) => `- universal rule ${i}: structure the task with a clear Done Criteria block`
      ).join('\n')
      const openclawBlock = Array.from(
        { length: 12 },
        (_, i) => `- openclaw step ${i}: call the Notion API via [[notion_write]] with database_id`
      ).join('\n')
      const md = `## Как работать с Notion
${universalBlock}

${openclawBlock}
`
      const chunks = chunkMarkdown(md)
      expect(chunks.length).toBeGreaterThanOrEqual(2)
      // All sub-chunks keep the parent ## heading.
      for (const c of chunks) {
        expect(c.sectionTitle).toBe('## Как работать с Notion')
      }
      // The two concern-groups land in different sub-chunks.
      const joinedFirst = chunks[0]!.text
      const joinedLast = chunks[chunks.length - 1]!.text
      expect(joinedFirst).toContain('universal rule 0')
      expect(joinedLast).toContain('[[notion_write]]')
      // Flat index is contiguous.
      expect(chunks.map((c) => c.index)).toEqual(
        chunks.map((_, i) => i)
      )
    })

    it('forces a sub-chunk boundary at ### sub-headers in a large section', () => {
      const pad = (s: string) =>
        Array.from({ length: 8 }, (_, i) => `${s} line ${i} with enough text`).join('\n')
      const md = `## Big Topic
### Universal part
${pad('universal')}

### OpenClaw part
${pad('openclaw [[skill]]')}
`
      const chunks = chunkMarkdown(md)
      expect(chunks.length).toBeGreaterThanOrEqual(2)
      const hasUniversalHeader = chunks.some((c) => c.text.includes('### Universal part'))
      const hasOpenclawHeader = chunks.some((c) => c.text.includes('### OpenClaw part'))
      expect(hasUniversalHeader).toBe(true)
      expect(hasOpenclawHeader).toBe(true)
    })

    it('merges a tiny trailing remainder into the previous sub-chunk', () => {
      const bigBlock = Array.from(
        { length: 20 },
        (_, i) => `- substantial rule number ${i} that carries real content for packing`
      ).join('\n')
      const md = `## Topic
${bigBlock}

- tiny
`
      const chunks = chunkMarkdown(md)
      // The lone "- tiny" must not be its own chunk.
      const tinyOwn = chunks.find((c) => c.text.trim() === '- tiny')
      expect(tinyOwn).toBeUndefined()
      expect(chunks[chunks.length - 1]!.text).toContain('- tiny')
    })
  })
})
