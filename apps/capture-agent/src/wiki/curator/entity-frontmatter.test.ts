import { describe, it, expect } from 'bun:test'
import { parseEntityMd, serializeEntityMd } from './entity-frontmatter'

const sample = [
  '---',
  'slug: amir',
  'name: "Amir"',
  'type: person',
  'aliases: ["Amir", "Амир"]',
  'first_seen: 2026-05-10T00:00:00.000Z',
  'last_seen: 2026-05-11T00:00:00.000Z',
  'mention_count: 5',
  'related: ["polina":3, "gtd-automation":2]',
  '---',
  '',
  '# Amir',
  '',
  '## Related',
  '- [[polina]] — co-occurs in 3 captures',
].join('\n')

describe('parseEntityMd', () => {
  it('parses the strict format produced by md-writer', () => {
    const p = parseEntityMd(sample)
    expect(p).not.toBeNull()
    expect(p!.frontmatter.slug).toBe('amir')
    expect(p!.frontmatter.name).toBe('Amir')
    expect(p!.frontmatter.type).toBe('person')
    expect(p!.frontmatter.aliases).toEqual(['Amir', 'Амир'])
    expect(p!.frontmatter.firstSeen).toBe('2026-05-10T00:00:00.000Z')
    expect(p!.frontmatter.lastSeen).toBe('2026-05-11T00:00:00.000Z')
    expect(p!.frontmatter.mentionCount).toBe(5)
    expect(p!.frontmatter.related).toEqual([
      { slug: 'polina', count: 3 },
      { slug: 'gtd-automation', count: 2 },
    ])
    expect(p!.body).toContain('# Amir')
    expect(p!.body).toContain('[[polina]]')
  })

  it('returns null for non-frontmatter content', () => {
    expect(parseEntityMd('# Plain markdown\n\nNo frontmatter')).toBeNull()
  })

  it('returns null when required fields missing', () => {
    expect(parseEntityMd('---\nname: "X"\n---\n')).toBeNull()
  })

  it('handles empty aliases/related lists', () => {
    const md = [
      '---',
      'slug: x',
      'name: "X"',
      'type: app',
      'aliases: []',
      'first_seen: 2026-01-01T00:00:00.000Z',
      'last_seen: 2026-01-01T00:00:00.000Z',
      'mention_count: 1',
      'related: []',
      '---',
    ].join('\n')
    const p = parseEntityMd(md)!
    expect(p.frontmatter.aliases).toEqual([])
    expect(p.frontmatter.related).toEqual([])
  })

  it('handles aliases with escaped quotes', () => {
    const md = [
      '---',
      'slug: x',
      'name: "Some \\"Person\\""',
      'type: person',
      'aliases: ["Some \\"Person\\""]',
      'first_seen: 2026-01-01T00:00:00.000Z',
      'last_seen: 2026-01-01T00:00:00.000Z',
      'mention_count: 1',
      'related: []',
      '---',
    ].join('\n')
    const p = parseEntityMd(md)!
    expect(p.frontmatter.name).toBe('Some "Person"')
    expect(p.frontmatter.aliases).toEqual(['Some "Person"'])
  })
})

describe('serializeEntityMd', () => {
  it('round-trips parseEntityMd output', () => {
    const p = parseEntityMd(sample)!
    const out = serializeEntityMd(p)
    const reparsed = parseEntityMd(out)!
    expect(reparsed.frontmatter).toEqual(p.frontmatter)
  })

  it('preserves body content', () => {
    const p = parseEntityMd(sample)!
    const out = serializeEntityMd(p)
    expect(out).toContain('# Amir')
    expect(out).toContain('[[polina]]')
  })

  it('escapes quotes in name/aliases', () => {
    const p = parseEntityMd(sample)!
    p.frontmatter.name = 'A "tricky" name'
    p.frontmatter.aliases = ['Plain', 'Has "Quotes"']
    const out = serializeEntityMd(p)
    expect(out).toContain('name: "A \\"tricky\\" name"')
    expect(out).toContain('"Has \\"Quotes\\""')
    const reparsed = parseEntityMd(out)!
    expect(reparsed.frontmatter.name).toBe('A "tricky" name')
    expect(reparsed.frontmatter.aliases).toEqual(['Plain', 'Has "Quotes"'])
  })
})
