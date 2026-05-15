import { describe, it, expect, mock } from 'bun:test'
import { ProceduralProposerBlock } from './proposer-block'
import type { ProceduralRetriever } from './retriever'

function mkRetriever(rows: Array<{ source: string; path: string; sectionTitle: string; text: string }>): ProceduralRetriever {
  return {
    retrieve: mock(async () =>
      rows.map((r, i) => ({
        id: `id-${i}`,
        source: r.source,
        path: r.path,
        sectionIndex: i,
        sectionTitle: r.sectionTitle,
        text: r.text,
        contentHash: 'h',
        fileMtime: 0,
        indexedAt: '',
        score: 1 / (i + 1),
        ranks: { fts: i },
      }))
    ),
  } as unknown as ProceduralRetriever
}

describe('ProceduralProposerBlock', () => {
  it('formats chunks with [source:path section] prefix', async () => {
    const block = new ProceduralProposerBlock({
      retriever: mkRetriever([
        { source: 'openclaw', path: 'MEMORY.md', sectionTitle: '## Slack', text: 'reply_to_current for thread' },
      ]),
    })
    const out = await block.getPlaybookContext('какая-то capture про slack thread')
    expect(out).toContain('[openclaw:MEMORY.md ## Slack]')
    expect(out).toContain('reply_to_current')
  })

  it('returns null when retriever yields nothing', async () => {
    const block = new ProceduralProposerBlock({ retriever: mkRetriever([]) })
    const out = await block.getPlaybookContext('anything')
    expect(out).toBeNull()
  })

  it('truncates per-chunk excerpt to perChunkChars', async () => {
    const long = 'word '.repeat(500).trim()
    const block = new ProceduralProposerBlock({
      retriever: mkRetriever([
        { source: 'openclaw', path: 'M.md', sectionTitle: '## A', text: long },
      ]),
      perChunkChars: 50,
    })
    const out = await block.getPlaybookContext('q')
    // tag + newline + 50-char excerpt = under 80 chars
    expect(out!.length).toBeLessThan(100)
  })

  it('stops when budget would be exceeded by next chunk', async () => {
    const block = new ProceduralProposerBlock({
      retriever: mkRetriever([
        { source: 'a', path: 'A.md', sectionTitle: '## A', text: 'aaa'.repeat(100) },
        { source: 'a', path: 'B.md', sectionTitle: '## B', text: 'bbb'.repeat(100) },
        { source: 'a', path: 'C.md', sectionTitle: '## C', text: 'ccc'.repeat(100) },
      ]),
      maxChars: 350,
      perChunkChars: 250,
    })
    const out = await block.getPlaybookContext('q')
    // Each block is ~tag + 1 newline + 250 chars. ~265 each. budget 350 → 1 block fits.
    expect(out!.includes('## A')).toBe(true)
    expect(out!.includes('## C')).toBe(false)
  })

  it('passes source option through to retriever', async () => {
    const retrieve = mock(async () => [])
    const retriever = { retrieve } as unknown as ProceduralRetriever
    const block = new ProceduralProposerBlock({ retriever, source: 'notion' })
    await block.getPlaybookContext('q')
    expect((retrieve as unknown as { mock: { calls: Array<[{ source?: string }]> } }).mock.calls[0]![0].source).toBe('notion')
  })

  it('truncates query text to 1500 chars before passing to retriever', async () => {
    const retrieve = mock(async () => [])
    const retriever = { retrieve } as unknown as ProceduralRetriever
    const block = new ProceduralProposerBlock({ retriever })
    const longCapture = 'x'.repeat(5000)
    await block.getPlaybookContext(longCapture)
    const arg = (retrieve as unknown as { mock: { calls: Array<[{ query: string }]> } }).mock.calls[0]![0].query
    expect(arg.length).toBe(1500)
  })
})
