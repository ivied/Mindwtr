import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCuratorPipeline } from './pipeline'
import type { LlmClient } from '../llm-client'

class FakeLlm {
  public calls = 0
  async chat(): Promise<string> {
    this.calls += 1
    return 'A short summary.'
  }
}

function entityMd(opts: {
  slug: string
  name?: string
  type?: string
  mentionCount?: number
  firstSeen?: string
  lastSeen?: string
  related?: Array<{ slug: string; count: number }>
}): string {
  const name = opts.name ?? opts.slug
  return [
    '---',
    `slug: ${opts.slug}`,
    `name: "${name}"`,
    `type: ${opts.type ?? 'app'}`,
    'aliases: []',
    `first_seen: ${opts.firstSeen ?? '2026-05-01T00:00:00.000Z'}`,
    `last_seen: ${opts.lastSeen ?? '2026-05-10T00:00:00.000Z'}`,
    `mention_count: ${opts.mentionCount ?? 1}`,
    `related: [${(opts.related ?? []).map((r) => `"${r.slug}":${r.count}`).join(', ')}]`,
    '---',
    '',
    `# ${name}`,
  ].join('\n')
}

const NOW = new Date('2026-05-11T12:00:00.000Z')

let testDir: string
let entitiesDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `pipe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  entitiesDir = join(testDir, 'entities')
  await mkdir(entitiesDir, { recursive: true })
})

afterEach(async () => {
  if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
})

describe('runCuratorPipeline', () => {
  it('runs all four phases by default', async () => {
    // 1 noise entity (gc archives), 2 duplicate entities (merger collapses)
    await writeFile(
      join(entitiesDir, 'noise.md'),
      entityMd({
        slug: 'noise',
        mentionCount: 1,
        lastSeen: '2026-01-01T00:00:00.000Z',
      })
    )
    await writeFile(
      join(entitiesDir, 'sergey.md'),
      entityMd({ slug: 'sergey', name: 'Sergey', mentionCount: 5 })
    )
    await writeFile(
      join(entitiesDir, 'sergey-k.md'),
      entityMd({ slug: 'sergey-k', name: 'Sergey', mentionCount: 2 })
    )
    await writeFile(
      join(entitiesDir, 'sergey.mentions.jsonl'),
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"hi"}\n'
    )

    const llm = new FakeLlm()
    const r = await runCuratorPipeline({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })

    expect(r.gc?.archived).toBe(1)
    expect(r.merge?.merged).toBe(1)
    expect(r.synth?.synthesized).toBeGreaterThanOrEqual(1)
    expect(r.cluster).toBeDefined()
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('respects the phases option', async () => {
    await writeFile(
      join(entitiesDir, 'noise.md'),
      entityMd({
        slug: 'noise',
        mentionCount: 1,
        lastSeen: '2026-01-01T00:00:00.000Z',
      })
    )
    const llm = new FakeLlm()
    const r = await runCuratorPipeline({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      phases: ['gc'],
      now: () => NOW,
    })
    expect(r.gc).toBeDefined()
    expect(r.merge).toBeUndefined()
    expect(r.synth).toBeUndefined()
    expect(r.cluster).toBeUndefined()
    expect(llm.calls).toBe(0)
  })

  it('dryRun: no files mutated', async () => {
    await writeFile(
      join(entitiesDir, 'noise.md'),
      entityMd({
        slug: 'noise',
        mentionCount: 1,
        lastSeen: '2026-01-01T00:00:00.000Z',
      })
    )
    const llm = new FakeLlm()
    const r = await runCuratorPipeline({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      dryRun: true,
      now: () => NOW,
    })
    expect(r.gc?.archived).toBe(1) // counted but not performed
    expect(existsSync(join(entitiesDir, 'noise.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, '.archive'))).toBe(false)
    expect(llm.calls).toBe(0)
  })

  it('correct phase order: gc before merge', async () => {
    // entity that should be archived AND has a duplicate slug
    // gc removes it first, so merge sees only the canonical
    await writeFile(
      join(entitiesDir, 'foo.md'),
      entityMd({ slug: 'foo', name: 'Foo', mentionCount: 10 })
    )
    await writeFile(
      join(entitiesDir, 'foo-x.md'),
      entityMd({
        slug: 'foo-x',
        name: 'Foo',
        mentionCount: 1,
        lastSeen: '2026-01-01T00:00:00.000Z',
      })
    )
    const llm = new FakeLlm()
    const r = await runCuratorPipeline({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })
    // GC archives foo-x first; merger has nothing left to merge.
    expect(r.gc?.archived).toBe(1)
    expect(r.merge?.merged).toBe(0)
  })
})
