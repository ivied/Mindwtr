import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMerger } from './merger'
import { parseEntityMd } from './entity-frontmatter'

interface EntitySpec {
  slug: string
  name?: string
  type?: string
  aliases?: string[]
  mentionCount?: number
  firstSeen?: string
  lastSeen?: string
  related?: Array<{ slug: string; count: number }>
}

function entityMd(s: EntitySpec): string {
  const name = s.name ?? s.slug
  const type = s.type ?? 'app'
  const aliases = s.aliases ?? []
  const firstSeen = s.firstSeen ?? '2026-05-01T00:00:00.000Z'
  const lastSeen = s.lastSeen ?? '2026-05-10T00:00:00.000Z'
  const mentionCount = s.mentionCount ?? 1
  const related = s.related ?? []
  return [
    '---',
    `slug: ${s.slug}`,
    `name: "${name}"`,
    `type: ${type}`,
    `aliases: [${aliases.map((a) => `"${a}"`).join(', ')}]`,
    `first_seen: ${firstSeen}`,
    `last_seen: ${lastSeen}`,
    `mention_count: ${mentionCount}`,
    `related: [${related.map((r) => `"${r.slug}":${r.count}`).join(', ')}]`,
    '---',
    '',
    `# ${name}`,
  ].join('\n')
}

let testDir: string
let entitiesDir: string

async function seed(specs: EntitySpec[], opts?: { mentions?: Record<string, string[]> }) {
  for (const s of specs) {
    await writeFile(join(entitiesDir, `${s.slug}.md`), entityMd(s))
    const lines = opts?.mentions?.[s.slug]
    if (lines) {
      await writeFile(join(entitiesDir, `${s.slug}.mentions.jsonl`), lines.join('\n') + '\n')
    }
  }
}

beforeEach(async () => {
  testDir = join(tmpdir(), `merger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  entitiesDir = join(testDir, 'entities')
  await mkdir(entitiesDir, { recursive: true })
})

afterEach(async () => {
  if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
})

describe('runMerger', () => {
  it('merges entities with the same normalized slug', async () => {
    await seed([
      { slug: 'sergey-kurdyuk', name: 'Sergey Kurdyuk', mentionCount: 3 },
      { slug: 'sergeykurdyuk', name: 'sergeykurdyuk', mentionCount: 5 },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.merged).toBe(1)
    expect(r.losersArchived).toBe(1)
    // higher mention_count wins → sergeykurdyuk is canonical
    expect(existsSync(join(entitiesDir, 'sergeykurdyuk.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, 'sergey-kurdyuk.md'))).toBe(false)
    expect(existsSync(join(entitiesDir, '.archive', 'sergey-kurdyuk.md'))).toBe(true)

    const parsed = parseEntityMd(
      await readFile(join(entitiesDir, 'sergeykurdyuk.md'), 'utf-8')
    )!
    expect(parsed.frontmatter.mentionCount).toBe(8)
  })

  it('merges entities with shared alias / name', async () => {
    await seed([
      { slug: 'claude', name: 'Claude', aliases: ['Claude AI'], mentionCount: 10 },
      { slug: 'claude-ai', name: 'Claude AI', mentionCount: 2 },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.merged).toBe(1)
    expect(existsSync(join(entitiesDir, 'claude.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, 'claude-ai.md'))).toBe(false)
  })

  it('aliases union — canonical name not duplicated', async () => {
    await seed([
      { slug: 'amir', name: 'Amir', aliases: ['A'], mentionCount: 5 },
      { slug: 'amir-x', name: 'Amir', aliases: ['Амир'], mentionCount: 2 },
    ])
    await runMerger({ wikiDir: testDir })
    const p = parseEntityMd(await readFile(join(entitiesDir, 'amir.md'), 'utf-8'))!
    expect(p.frontmatter.name).toBe('Amir')
    expect(p.frontmatter.aliases).toContain('A')
    expect(p.frontmatter.aliases).toContain('Амир')
    expect(p.frontmatter.aliases.filter((a) => a === 'Amir')).toEqual([])
  })

  it('type=person wins when any group member is person', async () => {
    await seed([
      { slug: 'polina', name: 'Polina', type: 'concept', mentionCount: 4 },
      { slug: 'polina-l', name: 'Polina', type: 'person', mentionCount: 1 },
    ])
    await runMerger({ wikiDir: testDir })
    const p = parseEntityMd(await readFile(join(entitiesDir, 'polina.md'), 'utf-8'))!
    expect(p.frontmatter.type).toBe('person')
  })

  it('firstSeen=min, lastSeen=max', async () => {
    await seed([
      {
        slug: 'alpha',
        name: 'Alpha',
        mentionCount: 3,
        firstSeen: '2026-05-05T00:00:00.000Z',
        lastSeen: '2026-05-08T00:00:00.000Z',
      },
      {
        slug: 'alpha-x',
        name: 'Alpha',
        mentionCount: 1,
        firstSeen: '2026-05-01T00:00:00.000Z',
        lastSeen: '2026-05-10T00:00:00.000Z',
      },
    ])
    await runMerger({ wikiDir: testDir })
    const p = parseEntityMd(await readFile(join(entitiesDir, 'alpha.md'), 'utf-8'))!
    expect(p.frontmatter.firstSeen).toBe('2026-05-01T00:00:00.000Z')
    expect(p.frontmatter.lastSeen).toBe('2026-05-10T00:00:00.000Z')
  })

  it('related: summed counts, self-refs dropped', async () => {
    await seed([
      {
        slug: 'main',
        name: 'Main',
        mentionCount: 5,
        related: [
          { slug: 'helper', count: 2 },
          { slug: 'shared', count: 1 },
        ],
      },
      {
        slug: 'main-x',
        name: 'Main',
        mentionCount: 1,
        related: [
          { slug: 'shared', count: 3 },
          { slug: 'main', count: 1 }, // would become self-ref
        ],
      },
      { slug: 'helper', name: 'Helper', mentionCount: 5 },
      { slug: 'shared', name: 'Shared', mentionCount: 5 },
    ])
    await runMerger({ wikiDir: testDir })
    const p = parseEntityMd(await readFile(join(entitiesDir, 'main.md'), 'utf-8'))!
    const byslug = Object.fromEntries(p.frontmatter.related.map((r) => [r.slug, r.count]))
    expect(byslug['helper']).toBe(2)
    expect(byslug['shared']).toBe(4)
    expect(byslug['main']).toBeUndefined()
    expect(byslug['main-x']).toBeUndefined()
  })

  it('rewrites related[] in other entities to point to canonical', async () => {
    await seed([
      { slug: 'sergey', name: 'Sergey', mentionCount: 5 },
      { slug: 'sergey-k', name: 'Sergey', mentionCount: 2 },
      {
        slug: 'project-x',
        name: 'Project X',
        mentionCount: 10,
        related: [{ slug: 'sergey-k', count: 2 }],
      },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.refsRewritten).toBeGreaterThanOrEqual(1)
    const p = parseEntityMd(await readFile(join(entitiesDir, 'project-x.md'), 'utf-8'))!
    expect(p.frontmatter.related[0]?.slug).toBe('sergey')
  })

  it('mentions.jsonl concatenated + sorted by ts', async () => {
    await seed(
      [
        { slug: 'foo', name: 'Foo', mentionCount: 2 },
        { slug: 'fooo', name: 'Foo', mentionCount: 1 },
      ],
      {
        mentions: {
          foo: [
            '{"ts":"2026-05-10T00:00:00.000Z","capture":"a"}',
            '{"ts":"2026-05-09T00:00:00.000Z","capture":"b"}',
          ],
          fooo: ['{"ts":"2026-05-08T00:00:00.000Z","capture":"c"}'],
        },
      }
    )
    await runMerger({ wikiDir: testDir })
    const lines = (
      await readFile(join(entitiesDir, 'foo.mentions.jsonl'), 'utf-8')
    )
      .split('\n')
      .filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('2026-05-08')
    expect(lines[2]).toContain('2026-05-10')
  })

  it('dryRun: emits decisions but does not move files', async () => {
    await seed([
      { slug: 'alpha', name: 'Alpha', mentionCount: 5 },
      { slug: 'alpha-x', name: 'Alpha', mentionCount: 1 },
    ])
    const r = await runMerger({ wikiDir: testDir, dryRun: true })
    expect(r.decisions).toHaveLength(1)
    expect(r.decisions[0]?.performed).toBe(false)
    expect(r.merged).toBe(0)
    expect(existsSync(join(entitiesDir, 'alpha-x.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, '.archive'))).toBe(false)
  })

  it('respects maxTotalMentionsForAutoMerge cap', async () => {
    await seed([
      { slug: 'big', name: 'Same', mentionCount: 40 },
      { slug: 'big-other', name: 'Same', mentionCount: 30 },
    ])
    const r = await runMerger({ wikiDir: testDir, maxTotalMentionsForAutoMerge: 50 })
    expect(r.merged).toBe(0)
    expect(r.decisions).toHaveLength(1)
    expect(r.decisions[0]?.performed).toBe(false)
    expect(r.decisions[0]?.reason).toContain('skipped')
    expect(existsSync(join(entitiesDir, 'big-other.md'))).toBe(true)
  })

  it('is a no-op when no groups exist', async () => {
    await seed([
      { slug: 'alpha', name: 'Alpha', mentionCount: 3 },
      { slug: 'beta', name: 'Beta', mentionCount: 2 },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.merged).toBe(0)
    expect(r.groupsFound).toBe(0)
  })

  it('is idempotent — second run finds no more groups', async () => {
    await seed([
      { slug: 'one', name: 'One', mentionCount: 3 },
      { slug: 'one-1', name: 'One', mentionCount: 1 },
    ])
    const r1 = await runMerger({ wikiDir: testDir })
    expect(r1.merged).toBe(1)
    const r2 = await runMerger({ wikiDir: testDir })
    expect(r2.merged).toBe(0)
  })

  it('canonical: higher mentionCount wins; ties → earliest first_seen', async () => {
    await seed([
      {
        slug: 'newer-one',
        name: 'Same Name',
        mentionCount: 5,
        firstSeen: '2026-05-05T00:00:00.000Z',
      },
      {
        slug: 'older-one',
        name: 'Same Name',
        mentionCount: 5,
        firstSeen: '2026-05-01T00:00:00.000Z',
      },
    ])
    await runMerger({ wikiDir: testDir })
    expect(existsSync(join(entitiesDir, 'older-one.md'))).toBe(true) // earlier first_seen wins on tie
    expect(existsSync(join(entitiesDir, 'newer-one.md'))).toBe(false)
  })

  it('returns gracefully when entities dir does not exist', async () => {
    const r = await runMerger({ wikiDir: join(testDir, 'nope') })
    expect(r.scanned).toBe(0)
    expect(r.merged).toBe(0)
  })

  it('does NOT merge across incompatible types (person + app)', async () => {
    await seed([
      { slug: 'kate', name: 'Kate', type: 'person', mentionCount: 8 },
      { slug: 'kate-notion', name: 'Kate', type: 'app', mentionCount: 3 },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.merged).toBe(0)
    expect(existsSync(join(entitiesDir, 'kate.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, 'kate-notion.md'))).toBe(true)
  })

  it('does merge when one type is a bland fallback (concept)', async () => {
    await seed([
      { slug: 'amir', name: 'Amir', type: 'person', mentionCount: 5 },
      { slug: 'amir-x', name: 'Amir', type: 'concept', mentionCount: 2 },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.merged).toBe(1)
  })

  it('handles three-way merge', async () => {
    await seed([
      { slug: 'sergey', name: 'Sergey', mentionCount: 5 },
      { slug: 'sergey-k', name: 'Sergey', mentionCount: 2 },
      { slug: 'sergeyk', name: 'Sergey', mentionCount: 1 },
    ])
    const r = await runMerger({ wikiDir: testDir })
    expect(r.merged).toBe(1)
    expect(r.losersArchived).toBe(2)
    const p = parseEntityMd(await readFile(join(entitiesDir, 'sergey.md'), 'utf-8'))!
    expect(p.frontmatter.mentionCount).toBe(8)
  })
})
