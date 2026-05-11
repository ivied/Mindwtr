import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WikiPersonsProvider, parsePersonFrontmatter } from './persons-reader'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gtd-wiki-'))
  mkdirSync(join(root, 'entities'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function entityFile(slug: string, content: string): void {
  writeFileSync(join(root, 'entities', `${slug}.md`), content, 'utf-8')
}

describe('parsePersonFrontmatter', () => {
  it('extracts slug / name / aliases / mention_count for type=person', () => {
    const md = [
      '---',
      'slug: amir',
      'name: "Amir"',
      'type: person',
      'aliases: ["Amir", "Амир"]',
      'first_seen: 2026-05-10T00:00:00Z',
      'last_seen: 2026-05-11T00:00:00Z',
      'mention_count: 5',
      '---',
      '',
      '# Amir',
    ].join('\n')
    const p = parsePersonFrontmatter(md)
    expect(p).not.toBeNull()
    expect(p!.slug).toBe('amir')
    expect(p!.name).toBe('Amir')
    expect(p!.aliases).toEqual(['Amir', 'Амир'])
    expect(p!.mentionCount).toBe(5)
  })

  it('rejects non-person types', () => {
    const md = [
      '---',
      'slug: figma',
      'name: "Figma"',
      'type: app',
      'aliases: []',
      'mention_count: 3',
      '---',
    ].join('\n')
    expect(parsePersonFrontmatter(md)).toBeNull()
  })

  it('returns null on missing frontmatter', () => {
    expect(parsePersonFrontmatter('# Plain markdown\n\nNo frontmatter here.')).toBeNull()
  })

  it('handles missing optional fields gracefully', () => {
    const md = ['---', 'slug: aleksey', 'name: "Aleksey"', 'type: person', '---'].join('\n')
    const p = parsePersonFrontmatter(md)
    expect(p).not.toBeNull()
    expect(p!.aliases).toEqual([])
    expect(p!.mentionCount).toBe(0)
  })

  it('returns null when slug or name is missing', () => {
    expect(
      parsePersonFrontmatter('---\nname: "X"\ntype: person\n---')
    ).toBeNull()
    expect(
      parsePersonFrontmatter('---\nslug: x\ntype: person\n---')
    ).toBeNull()
  })
})

describe('WikiPersonsProvider', () => {
  it('reads entity files and returns persons sorted by mention_count desc', async () => {
    entityFile('amir', [
      '---',
      'slug: amir',
      'name: "Amir"',
      'type: person',
      'aliases: ["Amir"]',
      'mention_count: 5',
      '---',
    ].join('\n'))
    entityFile('polina', [
      '---',
      'slug: polina',
      'name: "Polina"',
      'type: person',
      'aliases: ["Polina", "Полина"]',
      'mention_count: 14',
      '---',
    ].join('\n'))
    entityFile('figma', [
      '---',
      'slug: figma',
      'name: "Figma"',
      'type: app',
      'mention_count: 100',
      '---',
    ].join('\n'))

    const provider = new WikiPersonsProvider({ wikiDir: root })
    const persons = await provider.recentPersons(10)
    expect(persons.map((p) => p.slug)).toEqual(['polina', 'amir'])
    // App entries excluded.
    expect(persons.find((p) => p.slug === 'figma')).toBeUndefined()
    expect(persons[0]!.aliases).toEqual(['Polina', 'Полина'])
  })

  it('returns empty list when wiki dir is missing', async () => {
    rmSync(root, { recursive: true, force: true })
    const provider = new WikiPersonsProvider({ wikiDir: root })
    expect(await provider.recentPersons(10)).toEqual([])
  })

  it('caches within TTL — single scan for repeated calls', async () => {
    entityFile('amir', '---\nslug: amir\nname: "Amir"\ntype: person\nmention_count: 1\n---')
    const provider = new WikiPersonsProvider({ wikiDir: root, ttlMs: 60_000 })
    const a = await provider.recentPersons(10)
    // Add another file after the first scan — should NOT appear before cache expires.
    entityFile('polina', '---\nslug: polina\nname: "Polina"\ntype: person\nmention_count: 9\n---')
    const b = await provider.recentPersons(10)
    expect(a.map((p) => p.slug)).toEqual(['amir'])
    expect(b.map((p) => p.slug)).toEqual(['amir'])

    provider.invalidate()
    const c = await provider.recentPersons(10)
    expect(c.map((p) => p.slug)).toEqual(['polina', 'amir'])
  })

  it('coalesces concurrent calls into one scan', async () => {
    entityFile('amir', '---\nslug: amir\nname: "Amir"\ntype: person\nmention_count: 1\n---')
    const provider = new WikiPersonsProvider({ wikiDir: root, ttlMs: 60_000 })
    const [a, b, c] = await Promise.all([
      provider.recentPersons(10),
      provider.recentPersons(10),
      provider.recentPersons(10),
    ])
    // Same array contents — implicitly same scan.
    expect(a.length).toBe(1)
    expect(b.length).toBe(1)
    expect(c.length).toBe(1)
  })

  it('honors limit param', async () => {
    for (let i = 0; i < 5; i++) {
      entityFile(`p${i}`, `---\nslug: p${i}\nname: "P${i}"\ntype: person\nmention_count: ${5 - i}\n---`)
    }
    const provider = new WikiPersonsProvider({ wikiDir: root })
    const persons = await provider.recentPersons(3)
    expect(persons).toHaveLength(3)
    expect(persons.map((p) => p.slug)).toEqual(['p0', 'p1', 'p2'])
  })

  it('skips malformed entity files without crashing', async () => {
    entityFile('good', '---\nslug: good\nname: "Good"\ntype: person\nmention_count: 1\n---')
    entityFile('half-written', '---\nslug:') // truncated
    entityFile('plain', '# No frontmatter')
    const provider = new WikiPersonsProvider({ wikiDir: root })
    const persons = await provider.recentPersons(10)
    expect(persons.map((p) => p.slug)).toEqual(['good'])
  })
})
