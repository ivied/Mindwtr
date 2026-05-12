import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SlugCanonicalizer } from './slug-canonicalizer'

function writeEntity(
  entitiesDir: string,
  opts: { slug: string; name: string; aliases?: string[] }
): void {
  const aliases = opts.aliases ?? []
  const fm = [
    '---',
    `slug: ${opts.slug}`,
    `name: "${opts.name}"`,
    'type: person',
    `aliases: [${aliases.map((a) => `"${a}"`).join(', ')}]`,
    'first_seen: 2026-05-01T00:00:00.000Z',
    'last_seen: 2026-05-10T00:00:00.000Z',
    'mention_count: 5',
    'related: []',
    '---',
    '',
    `# ${opts.name}`,
  ].join('\n')
  writeFileSync(join(entitiesDir, `${opts.slug}.md`), fm)
}

let wikiDir: string
let entitiesDir: string

beforeEach(() => {
  wikiDir = join(tmpdir(), `canon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  entitiesDir = join(wikiDir, 'entities')
  mkdirSync(entitiesDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(wikiDir)) {
    try {
      rmSync(wikiDir, { recursive: true, force: true })
    } catch {}
  }
})

describe('SlugCanonicalizer', () => {
  it('returns the canonical slug for itself (identity)', async () => {
    writeEntity(entitiesDir, { slug: 'sergey-kurdyuk', name: 'Sergey Kurdyuk' })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    expect(c.canonicalOf('sergey-kurdyuk')).toBe('sergey-kurdyuk')
  })

  it('maps a normalized-slug duplicate to canonical', async () => {
    writeEntity(entitiesDir, { slug: 'sergey-kurdyuk', name: 'Sergey Kurdyuk' })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    // Same normalized form (strip hyphens, lowercase)
    expect(c.canonicalOf('sergeykurdyuk')).toBe('sergey-kurdyuk')
    expect(c.canonicalOf('Sergey_Kurdyuk')).toBe('sergey-kurdyuk')
    expect(c.canonicalOf('SERGEY-KURDYUK')).toBe('sergey-kurdyuk')
  })

  it('maps via an alias', async () => {
    writeEntity(entitiesDir, {
      slug: 'sergey-kurdyuk',
      name: 'Sergey Kurdyuk',
      aliases: ['Sergey', 'Сергей', 'Sergey KTR'],
    })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    expect(c.canonicalOf('sergey')).toBe('sergey-kurdyuk')
    expect(c.canonicalOf('Серге́й')).toBe('sergey-kurdyuk') // diacritic-normalized
    expect(c.canonicalOf('sergey-ktr')).toBe('sergey-kurdyuk')
  })

  it('returns null for unknown slugs', async () => {
    writeEntity(entitiesDir, { slug: 'amir', name: 'Amir' })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    expect(c.canonicalOf('completely-unknown')).toBeNull()
  })

  it('canonicalizeOrPassthrough returns input for unknown slugs', async () => {
    writeEntity(entitiesDir, { slug: 'amir', name: 'Amir' })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    expect(c.canonicalizeOrPassthrough('unknown-thing')).toBe('unknown-thing')
    expect(c.canonicalizeOrPassthrough('amir')).toBe('amir')
  })

  it('does not collide aliases across two entities (first-wins is safe — wiki merger collapses upstream)', async () => {
    writeEntity(entitiesDir, {
      slug: 'sergey-kurdyuk',
      name: 'Sergey Kurdyuk',
      aliases: ['Sergey'],
    })
    writeEntity(entitiesDir, {
      slug: 'sergey-petrov',
      name: 'Sergey Petrov',
      aliases: ['Sergey'], // collision — wiki merger should have caught this
    })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    // Alias 'Sergey' goes to whichever was loaded first; both canonical slugs still exist
    const r = c.canonicalOf('sergey')
    expect(r === 'sergey-kurdyuk' || r === 'sergey-petrov').toBe(true)
    expect(c.has('sergey-kurdyuk')).toBe(true)
    expect(c.has('sergey-petrov')).toBe(true)
  })

  it('handles empty entities dir gracefully', async () => {
    const c = new SlugCanonicalizer({ wikiDir })
    const r = await c.rebuild()
    expect(r.canonicalSlugs).toBe(0)
    expect(c.canonicalOf('anything')).toBeNull()
  })

  it('handles missing wiki dir gracefully', async () => {
    const c = new SlugCanonicalizer({ wikiDir: join(wikiDir, 'nope') })
    const r = await c.rebuild()
    expect(r.canonicalSlugs).toBe(0)
  })

  it('rebuild() is idempotent — second call gives the same map', async () => {
    writeEntity(entitiesDir, { slug: 'x', name: 'X', aliases: ['Xerxes'] })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    const first = c.canonicalOf('xerxes')
    await c.rebuild()
    expect(c.canonicalOf('xerxes')).toBe(first)
  })

  it('picks up new entities after rebuild()', async () => {
    writeEntity(entitiesDir, { slug: 'a', name: 'A' })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    expect(c.canonicalOf('b')).toBeNull()
    writeEntity(entitiesDir, { slug: 'b', name: 'B' })
    await c.rebuild()
    expect(c.canonicalOf('b')).toBe('b')
  })

  it('strips diacritics in normalization', async () => {
    writeEntity(entitiesDir, { slug: 'amir', name: 'Amir', aliases: ['Amír'] })
    const c = new SlugCanonicalizer({ wikiDir })
    await c.rebuild()
    expect(c.canonicalOf('amir')).toBe('amir')
    expect(c.canonicalOf('amír')).toBe('amir')
  })
})
