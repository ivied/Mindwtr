import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runClusterer } from './clusterer'

interface Spec {
  slug: string
  name?: string
  mentionCount?: number
  body?: string
  related?: Array<{ slug: string; count: number }>
}

function entityMd(s: Spec): string {
  const name = s.name ?? s.slug
  const mentionCount = s.mentionCount ?? 5
  const related = s.related ?? []
  const body = s.body ?? `# ${name}\n`
  return [
    '---',
    `slug: ${s.slug}`,
    `name: "${name}"`,
    'type: app',
    'aliases: []',
    'first_seen: 2026-05-01T00:00:00.000Z',
    'last_seen: 2026-05-10T00:00:00.000Z',
    `mention_count: ${mentionCount}`,
    `related: [${related.map((r) => `"${r.slug}":${r.count}`).join(', ')}]`,
    '---',
    '',
    body,
  ].join('\n')
}

const NOW = new Date('2026-05-11T12:00:00.000Z')

let testDir: string
let entitiesDir: string
let topicsDir: string

async function seed(specs: Spec[]) {
  for (const s of specs) {
    await writeFile(join(entitiesDir, `${s.slug}.md`), entityMd(s))
  }
}

beforeEach(async () => {
  testDir = join(tmpdir(), `cluster-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  entitiesDir = join(testDir, 'entities')
  topicsDir = join(testDir, 'topics')
  await mkdir(entitiesDir, { recursive: true })
})

afterEach(async () => {
  if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
})

describe('runClusterer', () => {
  it('finds a 3-node component and writes a topic page', async () => {
    await seed([
      { slug: 'a', mentionCount: 10, related: [{ slug: 'b', count: 3 }, { slug: 'c', count: 2 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW })
    expect(r.clustersFound).toBe(1)
    expect(r.topicsWritten).toBe(1)
    const topic = await readFile(join(topicsDir, 'a.md'), 'utf-8')
    expect(topic).toContain('# a')
    expect(topic).toContain('[[a]]')
    expect(topic).toContain('[[b]]')
    expect(topic).toContain('[[c]]')
  })

  it('skips clusters below minClusterSize', async () => {
    await seed([
      { slug: 'a', mentionCount: 5, related: [{ slug: 'b', count: 5 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 5 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW, minClusterSize: 3 })
    expect(r.clustersFound).toBe(0)
    expect(existsSync(topicsDir)).toBe(false)
  })

  it('skips clusters with too-few total mentions', async () => {
    await seed([
      { slug: 'a', mentionCount: 1, related: [{ slug: 'b', count: 2 }] },
      { slug: 'b', mentionCount: 1, related: [{ slug: 'a', count: 2 }, { slug: 'c', count: 2 }] },
      { slug: 'c', mentionCount: 1, related: [{ slug: 'b', count: 2 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW, minClusterMentions: 10 })
    expect(r.clustersFound).toBe(0)
  })

  it('skips clusters above maxClusterSize', async () => {
    // build a long chain of 10 nodes
    const specs: Spec[] = []
    for (let i = 0; i < 10; i++) {
      const slug = `n${i}`
      const related: Array<{ slug: string; count: number }> = []
      if (i > 0) related.push({ slug: `n${i - 1}`, count: 3 })
      if (i < 9) related.push({ slug: `n${i + 1}`, count: 3 })
      specs.push({ slug, mentionCount: 3, related })
    }
    await seed(specs)
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW, maxClusterSize: 5 })
    expect(r.clustersFound).toBe(0)
  })

  it('drops edges below minEdgeWeight', async () => {
    await seed([
      { slug: 'a', mentionCount: 5, related: [{ slug: 'b', count: 1 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 1 }, { slug: 'c', count: 5 }] },
      { slug: 'c', mentionCount: 5, related: [{ slug: 'b', count: 5 }] },
    ])
    const r = await runClusterer({
      wikiDir: testDir,
      now: () => NOW,
      minEdgeWeight: 2,
      minClusterSize: 2, // allow B-C pair through
    })
    // a-b edge dropped (weight 1), so a is isolated; b-c stays. Pair size=2.
    expect(r.clustersFound).toBe(1)
    expect(r.clusters[0]?.members.map((m) => m.slug).sort()).toEqual(['b', 'c'])
  })

  it('cluster name = top member name; cluster slug = top member slug', async () => {
    await seed([
      { slug: 'main-thing', name: 'Main Thing', mentionCount: 50, related: [{ slug: 'x', count: 5 }, { slug: 'y', count: 5 }] },
      { slug: 'x', mentionCount: 5, related: [{ slug: 'main-thing', count: 5 }] },
      { slug: 'y', mentionCount: 5, related: [{ slug: 'main-thing', count: 5 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW })
    expect(r.clusters[0]?.slug).toBe('main-thing')
    expect(r.clusters[0]?.name).toBe('Main Thing')
    expect(existsSync(join(topicsDir, 'main-thing.md'))).toBe(true)
  })

  it('uses first About line as member preview', async () => {
    await seed([
      {
        slug: 'a',
        mentionCount: 10,
        body: '# A\n\n## About\n\nA is a thing.\n\n## Related\n',
        related: [{ slug: 'b', count: 3 }, { slug: 'c', count: 2 }],
      },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
    ])
    await runClusterer({ wikiDir: testDir, now: () => NOW })
    const topic = await readFile(join(topicsDir, 'a.md'), 'utf-8')
    expect(topic).toContain('A is a thing.')
  })

  it('removes stale topic files', async () => {
    await mkdir(topicsDir, { recursive: true })
    await writeFile(join(topicsDir, 'old-cluster.md'), '# old')
    await seed([
      { slug: 'a', mentionCount: 10, related: [{ slug: 'b', count: 3 }, { slug: 'c', count: 2 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW })
    expect(r.topicsRemoved).toBe(1)
    expect(existsSync(join(topicsDir, 'old-cluster.md'))).toBe(false)
    expect(existsSync(join(topicsDir, 'a.md'))).toBe(true)
  })

  it('is idempotent — second run finds the same clusters', async () => {
    await seed([
      { slug: 'a', mentionCount: 10, related: [{ slug: 'b', count: 3 }, { slug: 'c', count: 2 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
    ])
    const r1 = await runClusterer({ wikiDir: testDir, now: () => NOW })
    const r2 = await runClusterer({ wikiDir: testDir, now: () => NOW })
    expect(r1.clustersFound).toBe(r2.clustersFound)
    expect(r2.topicsRemoved).toBe(0)
  })

  it('dryRun does not create topics/ directory', async () => {
    await seed([
      { slug: 'a', mentionCount: 10, related: [{ slug: 'b', count: 3 }, { slug: 'c', count: 2 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW, dryRun: true })
    expect(r.clustersFound).toBe(1)
    expect(r.topicsWritten).toBe(0)
    expect(existsSync(topicsDir)).toBe(false)
  })

  it('ignores dangling related refs to missing entities', async () => {
    await seed([
      { slug: 'a', mentionCount: 10, related: [{ slug: 'ghost', count: 5 }, { slug: 'b', count: 3 }, { slug: 'c', count: 2 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW })
    expect(r.clusters[0]?.members.map((m) => m.slug).sort()).toEqual(['a', 'b', 'c'])
  })

  it('handles missing entities dir', async () => {
    const r = await runClusterer({ wikiDir: join(testDir, 'nope'), now: () => NOW })
    expect(r.scanned).toBe(0)
    expect(r.clustersFound).toBe(0)
  })

  it('two separate clusters → two topic files', async () => {
    await seed([
      // cluster 1
      { slug: 'a', mentionCount: 10, related: [{ slug: 'b', count: 3 }, { slug: 'c', count: 2 }] },
      { slug: 'b', mentionCount: 5, related: [{ slug: 'a', count: 3 }] },
      { slug: 'c', mentionCount: 3, related: [{ slug: 'a', count: 2 }] },
      // cluster 2 (disconnected from above)
      { slug: 'x', mentionCount: 8, related: [{ slug: 'y', count: 3 }, { slug: 'z', count: 2 }] },
      { slug: 'y', mentionCount: 4, related: [{ slug: 'x', count: 3 }] },
      { slug: 'z', mentionCount: 2, related: [{ slug: 'x', count: 2 }] },
    ])
    const r = await runClusterer({ wikiDir: testDir, now: () => NOW })
    expect(r.clustersFound).toBe(2)
    const files = await readdir(topicsDir)
    expect(files.sort()).toEqual(['a.md', 'x.md'])
  })
})
