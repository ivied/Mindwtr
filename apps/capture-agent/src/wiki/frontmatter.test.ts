import { describe, it, expect } from 'bun:test'
import { parseCaptureMd } from './frontmatter'

describe('parseCaptureMd', () => {
  it('parses a typical screen capture', () => {
    const md = `---
id: aaaa-bbbb
ts: 2026-05-10T17:30:45.123Z
source: screen
app: "Slack"
title: "channel: #general"
image: "173045-screen-aaaa.png"
---

ocr text body
`
    const { meta, body } = parseCaptureMd(md)
    expect(meta.id).toBe('aaaa-bbbb')
    expect(meta.ts).toBe('2026-05-10T17:30:45.123Z')
    expect(meta.app).toBe('Slack')
    expect(meta.title).toBe('channel: #general')
    expect(meta.image).toBe('173045-screen-aaaa.png')
    expect(body.trim()).toBe('ocr text body')
  })

  it('parses numeric values', () => {
    const md = `---
duration_ms: 30000
rms: 0.0123
---

x
`
    const { meta } = parseCaptureMd(md)
    expect(meta.duration_ms).toBe(30000)
    expect(meta.rms).toBe(0.0123)
  })

  it('unescapes backslash-quoted strings', () => {
    const md = `---
title: "has \\"quotes\\" and \\\\ slash"
---

x
`
    const { meta } = parseCaptureMd(md)
    expect(meta.title).toBe('has "quotes" and \\ slash')
  })

  it('returns empty meta when frontmatter is malformed', () => {
    const { meta, body } = parseCaptureMd('no frontmatter here')
    expect(meta).toEqual({})
    expect(body).toBe('no frontmatter here')
  })
})
