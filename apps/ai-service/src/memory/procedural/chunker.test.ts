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
    expect(chunks[1]!.sectionTitle).toBe('## Section A')
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
})
