import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WikiGlossaryProvider,
  MemoryExpansionSource,
  parseGlossaryFrontmatter,
  type ActiveFactsReader,
} from './glossary-reader'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gtd-glossary-'))
  mkdirSync(join(root, 'entities'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function entityFile(slug: string, content: string): void {
  writeFileSync(join(root, 'entities', `${slug}.md`), content, 'utf-8')
}

describe('parseGlossaryFrontmatter', () => {
  it('extracts slug / term / aliases / kind / mention_count for project', () => {
    const md = [
      '---',
      'slug: phoenix',
      'name: "Phoenix"',
      'type: project',
      'aliases: ["Phoenix", "PHX"]',
      'mention_count: 7',
      '---',
      '',
      '# Phoenix',
    ].join('\n')
    const g = parseGlossaryFrontmatter(md)
    expect(g).not.toBeNull()
    expect(g!.slug).toBe('phoenix')
    expect(g!.term).toBe('Phoenix')
    expect(g!.aliases).toEqual(['Phoenix', 'PHX'])
    expect(g!.kind).toBe('project')
    expect(g!.mentionCount).toBe(7)
  })

  it('accepts term / technology / organization kinds', () => {
    for (const kind of ['term', 'technology', 'organization']) {
      const md = `---\nslug: x\nname: "X"\ntype: ${kind}\n---`
      expect(parseGlossaryFrontmatter(md)?.kind).toBe(kind as never)
    }
  })

  it('rejects person (those are KNOWN_PERSONS) and unknown types', () => {
    expect(
      parseGlossaryFrontmatter('---\nslug: amir\nname: "Amir"\ntype: person\n---')
    ).toBeNull()
    expect(
      parseGlossaryFrontmatter('---\nslug: x\nname: "X"\ntype: place\n---')
    ).toBeNull()
  })

  it('returns null on missing frontmatter or required fields', () => {
    expect(parseGlossaryFrontmatter('# plain')).toBeNull()
    expect(parseGlossaryFrontmatter('---\nname: "X"\ntype: project\n---')).toBeNull()
    expect(parseGlossaryFrontmatter('---\nslug: x\ntype: project\n---')).toBeNull()
  })

  it('handles missing optional fields gracefully', () => {
    const g = parseGlossaryFrontmatter('---\nslug: sbp\nname: "СБП"\ntype: term\n---')
    expect(g).not.toBeNull()
    expect(g!.aliases).toEqual([])
    expect(g!.mentionCount).toBe(0)
  })
})

describe('MemoryExpansionSource', () => {
  function fakeFacts(
    map: Record<string, Array<{ statement: string; factType: string | null }>>
  ): ActiveFactsReader {
    return { activeFactsFor: (slug) => map[slug] ?? [] }
  }

  it('returns null when no active facts', () => {
    const src = new MemoryExpansionSource(fakeFacts({}))
    expect(src.expansionFor('phoenix')).toBeNull()
  })

  it('prefers the most descriptive fact type', () => {
    const src = new MemoryExpansionSource(
      fakeFacts({
        phoenix: [
          { statement: 'mentioned in standup', factType: 'other' },
          { statement: 'DB migration to PostgreSQL', factType: 'status' },
          { statement: 'Sergey works on it', factType: 'working_on' },
        ],
      })
    )
    expect(src.expansionFor('phoenix')).toBe('DB migration to PostgreSQL')
  })

  it('falls back to first fact when none are ranked', () => {
    const src = new MemoryExpansionSource(
      fakeFacts({ x: [{ statement: 'some note', factType: 'other' }] })
    )
    expect(src.expansionFor('x')).toBe('some note')
  })
})

describe('WikiGlossaryProvider', () => {
  it('reads non-person entities sorted by mention_count, excludes persons', async () => {
    entityFile('phoenix', '---\nslug: phoenix\nname: "Phoenix"\ntype: project\nmention_count: 3\n---')
    entityFile('sbp', '---\nslug: sbp\nname: "СБП"\ntype: term\nmention_count: 9\n---')
    entityFile('amir', '---\nslug: amir\nname: "Amir"\ntype: person\nmention_count: 100\n---')

    const provider = new WikiGlossaryProvider({ wikiDir: root })
    const g = await provider.recentGlossary(10)
    expect(g.map((e) => e.slug)).toEqual(['sbp', 'phoenix'])
    expect(g.find((e) => e.slug === 'amir')).toBeUndefined()
  })

  it('attaches expansion from the expansion source', async () => {
    entityFile('phoenix', '---\nslug: phoenix\nname: "Phoenix"\ntype: project\nmention_count: 3\n---')
    const expansions = new MemoryExpansionSource({
      activeFactsFor: (slug) =>
        slug === 'phoenix' ? [{ statement: 'миграция БД на PostgreSQL', factType: 'status' }] : [],
    })
    const provider = new WikiGlossaryProvider({ wikiDir: root, expansions })
    const g = await provider.recentGlossary(10)
    expect(g[0]!.expansion).toBe('миграция БД на PostgreSQL')
  })

  it('emits empty expansion when no fact known', async () => {
    entityFile('phoenix', '---\nslug: phoenix\nname: "Phoenix"\ntype: project\n---')
    const provider = new WikiGlossaryProvider({ wikiDir: root })
    const g = await provider.recentGlossary(10)
    expect(g[0]!.expansion).toBe('')
  })

  it('returns empty list when wiki dir is missing', async () => {
    rmSync(root, { recursive: true, force: true })
    const provider = new WikiGlossaryProvider({ wikiDir: root })
    expect(await provider.recentGlossary(10)).toEqual([])
  })

  it('caches within TTL and re-reads after invalidate', async () => {
    entityFile('phoenix', '---\nslug: phoenix\nname: "Phoenix"\ntype: project\nmention_count: 1\n---')
    const provider = new WikiGlossaryProvider({ wikiDir: root, ttlMs: 60_000 })
    const a = await provider.recentGlossary(10)
    entityFile('sbp', '---\nslug: sbp\nname: "СБП"\ntype: term\nmention_count: 9\n---')
    const b = await provider.recentGlossary(10)
    expect(a.map((e) => e.slug)).toEqual(['phoenix'])
    expect(b.map((e) => e.slug)).toEqual(['phoenix'])
    provider.invalidate()
    const c = await provider.recentGlossary(10)
    expect(c.map((e) => e.slug)).toEqual(['sbp', 'phoenix'])
  })

  it('skips malformed entity files without crashing', async () => {
    entityFile('good', '---\nslug: good\nname: "Good"\ntype: term\nmention_count: 1\n---')
    entityFile('half', '---\nslug:')
    entityFile('plain', '# no frontmatter')
    const provider = new WikiGlossaryProvider({ wikiDir: root })
    const g = await provider.recentGlossary(10)
    expect(g.map((e) => e.slug)).toEqual(['good'])
  })
})

describe('WikiGlossaryProvider with confirmed source (3rd source)', () => {
  it('confirmed entries override wiki entries for the same slug', async () => {
    entityFile('phoenix', '---\nslug: phoenix\nname: "Phoenix"\ntype: project\nmention_count: 1\n---')
    const confirmed = {
      confirmedEntries: () => [
        { slug: 'phoenix', term: 'Phoenix', aliases: ['PHX'], kind: 'project' as const, expansion: 'миграция БД', mentionCount: 9 },
      ],
      rejectedSlugs: () => new Set<string>(),
    }
    const provider = new WikiGlossaryProvider({ wikiDir: root, confirmed })
    const g = await provider.recentGlossary(10)
    // single phoenix entry, with the confirmed expansion + mention_count
    expect(g.filter((e) => e.slug === 'phoenix')).toHaveLength(1)
    expect(g[0]!.expansion).toBe('миграция БД')
    expect(g[0]!.mentionCount).toBe(9)
  })

  it('rejected slugs are excluded from wiki-derived entries', async () => {
    entityFile('phoenix', '---\nslug: phoenix\nname: "Phoenix"\ntype: project\nmention_count: 5\n---')
    entityFile('sbp', '---\nslug: sbp\nname: "СБП"\ntype: term\nmention_count: 3\n---')
    const confirmed = {
      confirmedEntries: () => [],
      rejectedSlugs: () => new Set<string>(['sbp']),
    }
    const provider = new WikiGlossaryProvider({ wikiDir: root, confirmed })
    const g = await provider.recentGlossary(10)
    expect(g.map((e) => e.slug)).toEqual(['phoenix'])
  })

  it('confirmed entries appear even with no wiki dir', async () => {
    rmSync(root, { recursive: true, force: true })
    const confirmed = {
      confirmedEntries: () => [
        { slug: 'mr', term: 'MR', aliases: [], kind: 'term' as const, expansion: 'Merge Request', mentionCount: 1 },
      ],
      rejectedSlugs: () => new Set<string>(),
    }
    const provider = new WikiGlossaryProvider({ wikiDir: root, confirmed })
    const g = await provider.recentGlossary(10)
    expect(g.map((e) => e.slug)).toEqual(['mr'])
  })
})
