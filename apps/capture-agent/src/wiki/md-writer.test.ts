import { describe, it, expect } from 'bun:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MdWikiWriter, render } from './md-writer'

describe('render', () => {
  it('emits frontmatter + body with required fields', () => {
    const md = render(
      {
        source: 'screen',
        ts: new Date('2026-05-10T17:30:45.123Z'),
        app: 'Slack',
        title: 'channel: #general',
        body: 'hello world',
      },
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    )
    expect(md).toContain('id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(md).toContain('ts: 2026-05-10T17:30:45.123Z')
    expect(md).toContain('source: screen')
    expect(md).toContain('app: "Slack"')
    expect(md).toContain('title: "channel: #general"')
    expect(md).toMatch(/---\n\nhello world\n$/)
  })

  it('includes audio-only fields when present', () => {
    const md = render(
      {
        source: 'audio',
        ts: new Date('2026-05-10T17:30:45.000Z'),
        app: 'Terminal',
        title: 'zsh',
        body: 'transcript text',
        device: ':4',
        durationMs: 30000,
        model: 'whisper-1',
        rms: 0.012345,
      },
      'id1'
    )
    expect(md).toContain('device: ":4"')
    expect(md).toContain('duration_ms: 30000')
    expect(md).toContain('model: "whisper-1"')
    expect(md).toContain('rms: 0.0123')
  })

  it('escapes quotes and backslashes in strings', () => {
    const md = render(
      {
        source: 'screen',
        ts: new Date('2026-05-10T00:00:00Z'),
        app: 'X',
        title: 'has "quotes" and \\ slash',
        body: '',
      },
      'id1'
    )
    expect(md).toContain('title: "has \\"quotes\\" and \\\\ slash"')
  })
})

describe('MdWikiWriter', () => {
  it('writes file under captures/YYYY/MM/DD with HHMMSS-source-id name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-test-'))
    const writer = new MdWikiWriter(root)
    const { mdPath } = await writer.write({
      source: 'audio',
      ts: new Date('2026-05-10T17:30:45.000Z'),
      app: 'Terminal',
      title: 'zsh',
      body: 'hello',
    })
    expect(mdPath).toContain(join(root, 'captures', '2026', '05', '10'))
    expect(mdPath).toMatch(/173045-audio-[0-9a-f]{8}\.md$/)
    const content = await readFile(mdPath, 'utf8')
    expect(content).toContain('source: audio')
    expect(content.endsWith('hello\n')).toBe(true)
  })

  it('two writes in same second do not collide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-test-'))
    const writer = new MdWikiWriter(root)
    const ts = new Date('2026-05-10T17:30:45.000Z')
    await writer.write({ source: 'screen', ts, app: 'A', title: 'a', body: 'one' })
    await writer.write({ source: 'screen', ts, app: 'A', title: 'a', body: 'two' })
    const dir = join(root, 'captures', '2026', '05', '10')
    const files = await readdir(dir)
    expect(files).toHaveLength(2)
  })

  it('writes image alongside md with the given extension and frontmatter ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-test-'))
    const writer = new MdWikiWriter(root)
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const { mdPath, imagePath } = await writer.write(
      {
        source: 'screen',
        ts: new Date('2026-05-10T17:30:45.000Z'),
        app: 'Terminal',
        title: 'zsh',
        body: 'ocr text',
      },
      { image: { bytes, ext: 'jpg' } }
    )
    expect(imagePath).toBeDefined()
    expect(imagePath).toMatch(/173045-screen-[0-9a-f]{8}\.jpg$/)
    const md = await readFile(mdPath, 'utf8')
    expect(md).toMatch(/image: "173045-screen-[0-9a-f]{8}\.jpg"/)
    const imgBytes = await readFile(imagePath!)
    expect(imgBytes.length).toBe(8)
    expect(imgBytes[0]).toBe(0xff)
  })

  it('still works with png ext for backward compat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-test-'))
    const writer = new MdWikiWriter(root)
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const { imagePath } = await writer.write(
      {
        source: 'screen',
        ts: new Date('2026-05-10T17:30:45.000Z'),
        app: 'Terminal',
        title: 'zsh',
        body: 'ocr',
      },
      { image: { bytes, ext: 'png' } }
    )
    expect(imagePath).toMatch(/\.png$/)
  })

  it('ignores image for audio captures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wiki-test-'))
    const writer = new MdWikiWriter(root)
    const bytes = Buffer.from([0x89, 0x50])
    const { imagePath } = await writer.write(
      {
        source: 'audio',
        ts: new Date('2026-05-10T17:30:45.000Z'),
        app: 'Terminal',
        title: 'zsh',
        body: 'transcript',
      },
      { image: { bytes, ext: 'jpg' } }
    )
    expect(imagePath).toBeUndefined()
  })
})
