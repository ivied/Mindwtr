import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runGarbageCollector } from './garbage-collector'

const NOW = new Date('2026-05-11T12:00:00.000Z')

function entityMd(opts: {
  slug: string
  type?: string
  mentionCount?: number
  lastSeen?: string
  firstSeen?: string
}): string {
  const type = opts.type ?? 'app'
  const mentionCount = opts.mentionCount ?? 1
  const lastSeen = opts.lastSeen ?? NOW.toISOString()
  const firstSeen = opts.firstSeen ?? lastSeen
  return [
    '---',
    `slug: ${opts.slug}`,
    `name: "${opts.slug}"`,
    `type: ${type}`,
    'aliases: []',
    `first_seen: ${firstSeen}`,
    `last_seen: ${lastSeen}`,
    `mention_count: ${mentionCount}`,
    'related: []',
    '---',
    '',
    `# ${opts.slug}`,
  ].join('\n')
}

async function makeEntity(
  entitiesDir: string,
  opts: Parameters<typeof entityMd>[0] & { withMentions?: boolean }
): Promise<void> {
  await writeFile(join(entitiesDir, `${opts.slug}.md`), entityMd(opts))
  if (opts.withMentions) {
    await writeFile(
      join(entitiesDir, `${opts.slug}.mentions.jsonl`),
      `{"ts":"${opts.lastSeen ?? NOW.toISOString()}","capture":"x"}\n`
    )
  }
}

let testDir: string
let entitiesDir: string

beforeEach(async () => {
  testDir = join(tmpdir(), `gc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  entitiesDir = join(testDir, 'entities')
  await mkdir(entitiesDir, { recursive: true })
})

afterEach(async () => {
  if (existsSync(testDir)) {
    await rm(testDir, { recursive: true, force: true })
  }
})

describe('runGarbageCollector', () => {
  it('keeps entities with mention_count >= keepMin', async () => {
    await makeEntity(entitiesDir, { slug: 'busy', mentionCount: 5 })
    await makeEntity(entitiesDir, {
      slug: 'lonely',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
    })
    const r = await runGarbageCollector({
      wikiDir: testDir,
      now: () => NOW,
      keepMinMentions: 2,
    })
    expect(r.scanned).toBe(2)
    expect(r.kept).toBe(1)
    expect(r.archived).toBe(1)
    expect(existsSync(join(entitiesDir, 'busy.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, 'lonely.md'))).toBe(false)
    expect(existsSync(join(entitiesDir, '.archive', 'lonely.md'))).toBe(true)
  })

  it('protects type=person regardless of mention_count', async () => {
    await makeEntity(entitiesDir, {
      slug: 'amir',
      type: 'person',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
    })
    const r = await runGarbageCollector({ wikiDir: testDir, now: () => NOW })
    expect(r.protected).toBe(1)
    expect(r.kept).toBe(1)
    expect(r.archived).toBe(0)
    expect(existsSync(join(entitiesDir, 'amir.md'))).toBe(true)
  })

  it('keeps recently-seen entities even with low count', async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
    await makeEntity(entitiesDir, {
      slug: 'fresh',
      mentionCount: 1,
      lastSeen: recent,
    })
    const r = await runGarbageCollector({
      wikiDir: testDir,
      now: () => NOW,
      staleAfterMs: 24 * 60 * 60 * 1000,
    })
    expect(r.kept).toBe(1)
    expect(r.archived).toBe(0)
    expect(existsSync(join(entitiesDir, 'fresh.md'))).toBe(true)
  })

  it('archives stale low-mention entities', async () => {
    await makeEntity(entitiesDir, {
      slug: 'old-noise',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
      withMentions: true,
    })
    const r = await runGarbageCollector({ wikiDir: testDir, now: () => NOW })
    expect(r.archived).toBe(1)
    expect(existsSync(join(entitiesDir, 'old-noise.md'))).toBe(false)
    expect(existsSync(join(entitiesDir, 'old-noise.mentions.jsonl'))).toBe(false)
    expect(existsSync(join(entitiesDir, '.archive', 'old-noise.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, '.archive', 'old-noise.mentions.jsonl'))).toBe(true)
  })

  it('dryRun does not move files and emits decisions', async () => {
    await makeEntity(entitiesDir, {
      slug: 'old-noise',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
    })
    await makeEntity(entitiesDir, { slug: 'busy', mentionCount: 10 })
    const r = await runGarbageCollector({
      wikiDir: testDir,
      now: () => NOW,
      dryRun: true,
    })
    expect(r.archived).toBe(1)
    expect(r.kept).toBe(1)
    expect(existsSync(join(entitiesDir, 'old-noise.md'))).toBe(true)
    expect(existsSync(join(entitiesDir, '.archive'))).toBe(false)
    expect(r.decisions).toBeDefined()
    expect(r.decisions!.length).toBe(2)
    const oldDec = r.decisions!.find((d) => d.slug === 'old-noise')
    expect(oldDec?.reason).toBe('archived')
  })

  it('is idempotent — second run is a no-op', async () => {
    await makeEntity(entitiesDir, {
      slug: 'old-noise',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
    })
    const first = await runGarbageCollector({ wikiDir: testDir, now: () => NOW })
    expect(first.archived).toBe(1)
    const second = await runGarbageCollector({ wikiDir: testDir, now: () => NOW })
    expect(second.scanned).toBe(0)
    expect(second.archived).toBe(0)
  })

  it('returns gracefully when entities dir does not exist', async () => {
    const emptyDir = join(testDir, 'no-entities-here')
    const r = await runGarbageCollector({ wikiDir: emptyDir, now: () => NOW })
    expect(r.scanned).toBe(0)
    expect(r.archived).toBe(0)
  })

  it('counts unparsable files without crashing', async () => {
    await writeFile(join(entitiesDir, 'broken.md'), '# no frontmatter')
    await makeEntity(entitiesDir, { slug: 'busy', mentionCount: 10 })
    const r = await runGarbageCollector({ wikiDir: testDir, now: () => NOW })
    expect(r.unparsable).toBe(1)
    expect(r.kept).toBe(1)
    expect(existsSync(join(entitiesDir, 'broken.md'))).toBe(true)
  })

  it('respects custom protectedTypes', async () => {
    await makeEntity(entitiesDir, {
      slug: 'project-x',
      type: 'project',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
    })
    const r = await runGarbageCollector({
      wikiDir: testDir,
      now: () => NOW,
      protectedTypes: ['project'],
    })
    expect(r.protected).toBe(1)
    expect(r.archived).toBe(0)
  })

  it('skips files already inside .archive subdirectory', async () => {
    // .archive lives inside entitiesDir, but readdir returns it as a name —
    // make sure we don't try to parse the directory itself.
    await mkdir(join(entitiesDir, '.archive'), { recursive: true })
    await writeFile(join(entitiesDir, '.archive', 'previously-archived.md'), entityMd({
      slug: 'previously-archived',
      mentionCount: 1,
      lastSeen: '2026-01-01T00:00:00.000Z',
    }))
    await makeEntity(entitiesDir, { slug: 'busy', mentionCount: 10 })
    const r = await runGarbageCollector({ wikiDir: testDir, now: () => NOW })
    expect(r.scanned).toBe(1)
    expect(r.kept).toBe(1)
    expect(existsSync(join(entitiesDir, '.archive', 'previously-archived.md'))).toBe(true)
  })
})
