import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runSynthesizer, spliceAbout, sanitizeAbout } from './synthesizer'
import { parseEntityMd } from './entity-frontmatter'
import type { LlmClient } from '../llm-client'

class FakeLlm {
  public calls: Array<{ system: string; user: string }> = []
  constructor(private readonly responder: (user: string) => string) {}
  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const system = messages.find((m) => m.role === 'system')?.content ?? ''
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    this.calls.push({ system, user })
    return this.responder(user)
  }
}

function entityMd(opts: {
  slug: string
  name?: string
  type?: string
  mentionCount?: number
  body?: string
}): string {
  const name = opts.name ?? opts.slug
  const type = opts.type ?? 'app'
  const mentionCount = opts.mentionCount ?? 1
  const body = opts.body ?? `# ${name}\n\n## Related\n\n## Recent mentions (last 0 of 0)\n`
  return [
    '---',
    `slug: ${opts.slug}`,
    `name: "${name}"`,
    `type: ${type}`,
    'aliases: []',
    'first_seen: 2026-05-01T00:00:00.000Z',
    'last_seen: 2026-05-10T00:00:00.000Z',
    `mention_count: ${mentionCount}`,
    'related: []',
    '---',
    '',
    body,
  ].join('\n')
}

const NOW = new Date('2026-05-11T12:00:00.000Z')

let testDir: string
let entitiesDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `synth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  entitiesDir = join(testDir, 'entities')
  await mkdir(entitiesDir, { recursive: true })
})

afterEach(async () => {
  if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
})

async function seedEntity(
  slug: string,
  mentionCount: number,
  mentions: string[]
): Promise<void> {
  await writeFile(join(entitiesDir, `${slug}.md`), entityMd({ slug, mentionCount }))
  await writeFile(
    join(entitiesDir, `${slug}.mentions.jsonl`),
    mentions.join('\n') + '\n'
  )
}

describe('sanitizeAbout', () => {
  it('strips code fences', () => {
    expect(sanitizeAbout('```\nHello world.\n```')).toBe('Hello world.')
  })
  it('returns empty for SKIP marker', () => {
    expect(sanitizeAbout('SKIP')).toBe('')
    expect(sanitizeAbout('SKIP — too noisy')).toBe('')
  })
  it('rejects JSON-shaped output', () => {
    expect(sanitizeAbout('{"about": "..."}')).toBe('')
    expect(sanitizeAbout('[1,2,3]')).toBe('')
  })
  it('clips to a max length', () => {
    expect(sanitizeAbout('x'.repeat(1000)).length).toBeLessThanOrEqual(500)
  })
  it('passes through clean text', () => {
    expect(sanitizeAbout('A 1-sentence summary.')).toBe('A 1-sentence summary.')
  })
})

describe('spliceAbout', () => {
  it('inserts About after the title', () => {
    const body = '# GTD Mindwtr\n\n## Related\n\n- [[x]]\n'
    const out = spliceAbout(body, 'GTD Mindwtr', 'A task-capture app.')
    expect(out).toContain('# GTD Mindwtr')
    expect(out).toMatch(/# GTD Mindwtr[\s\S]*## About[\s\S]*A task-capture app\.[\s\S]*## Related/)
  })
  it('replaces existing About section', () => {
    const body =
      '# X\n\n## About\n\nOld text.\n\n## Related\n\n- [[y]]\n'
    const out = spliceAbout(body, 'X', 'New text.')
    expect(out).not.toContain('Old text.')
    expect(out).toContain('New text.')
    expect(out).toContain('## Related')
  })
  it('preserves Related and Recent mentions blocks', () => {
    const body =
      '# X\n\n## Related\n\n- [[a]]\n\n## Recent mentions (last 2 of 5)\n\n- one\n- two\n'
    const out = spliceAbout(body, 'X', 'Summary.')
    expect(out).toContain('## Related')
    expect(out).toContain('- [[a]]')
    expect(out).toContain('## Recent mentions (last 2 of 5)')
    expect(out).toContain('- one')
  })
  it('handles body without title by prepending one', () => {
    const body = 'No title here.\n'
    const out = spliceAbout(body, 'Synth', 'Hello.')
    expect(out.startsWith('# Synth')).toBe(true)
    expect(out).toContain('## About')
  })
})

describe('runSynthesizer', () => {
  it('skips entities below minMentions', async () => {
    await seedEntity('lonely', 1, ['{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}'])
    const llm = new FakeLlm(() => 'should not be called')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      minMentions: 3,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(0)
    expect(llm.calls).toHaveLength(0)
    expect(r.decisions.some((d) => d.action === 'skip-low-count')).toBe(true)
  })

  it('synthesizes eligible entities and splices About into body', async () => {
    await seedEntity('claude', 5, [
      '{"ts":"2026-05-10T00:00:00.000Z","source":"screen","app":"Claude","excerpt":"Claude opens a new chat"}',
      '{"ts":"2026-05-09T00:00:00.000Z","source":"screen","app":"Claude","excerpt":"asks Claude to summarize"}',
    ])
    const llm = new FakeLlm(() => 'Claude is Anthropic\'s AI assistant.')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(1)
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]!.user).toContain('claude')
    const p = parseEntityMd(await readFile(join(entitiesDir, 'claude.md'), 'utf-8'))!
    expect(p.body).toContain('## About')
    expect(p.body).toContain('Claude is Anthropic')
  })

  it('writes state file with mention_count snapshot', async () => {
    await seedEntity('x', 5, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}',
    ])
    const llm = new FakeLlm(() => 'A thing.')
    await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })
    const state = JSON.parse(
      await readFile(join(testDir, '.curator-state.json'), 'utf-8')
    )
    expect(state.synth.x.mentionCountAtSynth).toBe(5)
    expect(state.synth.x.lastSynthAt).toBe(NOW.toISOString())
  })

  it('skips re-synthesis when recent and growth below delta', async () => {
    await seedEntity('x', 5, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}',
    ])
    // Pre-populate state: last synth at NOW-1d, at mention_count=4 — growth=1.
    await writeFile(
      join(testDir, '.curator-state.json'),
      JSON.stringify({
        synth: {
          x: {
            lastSynthAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
            mentionCountAtSynth: 4,
          },
        },
      })
    )
    const llm = new FakeLlm(() => 'should not be called')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      resynthMentionDelta: 3,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(0)
    expect(llm.calls).toHaveLength(0)
    expect(r.decisions.some((d) => d.action === 'skip-recent')).toBe(true)
  })

  it('re-synthesizes when mention growth crosses delta', async () => {
    await seedEntity('x', 10, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}',
    ])
    await writeFile(
      join(testDir, '.curator-state.json'),
      JSON.stringify({
        synth: {
          x: {
            lastSynthAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
            mentionCountAtSynth: 5,
          },
        },
      })
    )
    const llm = new FakeLlm(() => 'A thing.')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      resynthMentionDelta: 3,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(1)
  })

  it('respects maxPerPass budget', async () => {
    for (const slug of ['a', 'b', 'c', 'd']) {
      await seedEntity(slug, 5, [
        `{"ts":"2026-05-10T00:00:00.000Z","excerpt":"${slug}"}`,
      ])
    }
    const llm = new FakeLlm(() => 'Summary.')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      maxPerPass: 2,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(2)
    expect(r.decisions.filter((d) => d.action === 'skip-budget')).toHaveLength(2)
  })

  it('SKIP from LLM → no write, no state update', async () => {
    await seedEntity('noisy', 5, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"garbled"}',
    ])
    const llm = new FakeLlm(() => 'SKIP')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(0)
    expect(existsSync(join(testDir, '.curator-state.json'))).toBe(true)
    const state = JSON.parse(
      await readFile(join(testDir, '.curator-state.json'), 'utf-8')
    )
    expect(state.synth?.noisy).toBeUndefined()
    const p = parseEntityMd(await readFile(join(entitiesDir, 'noisy.md'), 'utf-8'))!
    expect(p.body).not.toContain('## About')
  })

  it('dryRun does not call LLM and does not write state', async () => {
    await seedEntity('x', 5, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}',
    ])
    const llm = new FakeLlm(() => 'should not be called')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
      dryRun: true,
    })
    expect(r.synthesized).toBe(1)
    expect(llm.calls).toHaveLength(0)
    expect(existsSync(join(testDir, '.curator-state.json'))).toBe(false)
  })

  it('skips when no mentions.jsonl exists', async () => {
    await writeFile(
      join(entitiesDir, 'orphan.md'),
      entityMd({ slug: 'orphan', mentionCount: 5 })
    )
    const llm = new FakeLlm(() => 'never called')
    const r = await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })
    expect(r.synthesized).toBe(0)
    expect(r.decisions.some((d) => d.action === 'skip-empty-mentions')).toBe(true)
  })

  it('handles missing entities dir gracefully', async () => {
    const empty = join(testDir, 'no-here')
    const llm = new FakeLlm(() => 'x')
    const r = await runSynthesizer({
      wikiDir: empty,
      llm: llm as unknown as LlmClient,
      now: () => NOW,
    })
    expect(r.scanned).toBe(0)
    expect(r.synthesized).toBe(0)
  })

  it('prioritizes never-synthesized entities over previously synthesized ones', async () => {
    await seedEntity('fresh-high', 5, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}',
    ])
    await seedEntity('previously-synthed', 100, [
      '{"ts":"2026-05-10T00:00:00.000Z","excerpt":"x"}',
    ])
    await writeFile(
      join(testDir, '.curator-state.json'),
      JSON.stringify({
        synth: {
          'previously-synthed': {
            lastSynthAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
            mentionCountAtSynth: 50, // growth = 50 → eligible
          },
        },
      })
    )
    const order: string[] = []
    const llm = new FakeLlm((user) => {
      const m = user.match(/Entity: (\S+)/)
      if (m) order.push(m[1]!)
      return 'A thing.'
    })
    await runSynthesizer({
      wikiDir: testDir,
      llm: llm as unknown as LlmClient,
      maxPerPass: 2,
      now: () => NOW,
    })
    // fresh-high (never synthed) should come first despite lower count.
    expect(order[0]).toBe('fresh-high')
    expect(order[1]).toBe('previously-synthed')
  })
})
