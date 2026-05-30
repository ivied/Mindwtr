import { describe, it, expect } from 'bun:test'
import { statementsForEntity, renderActivitySection, type StoredActivity } from './activity-reader'

const base = {
  project: '',
  surface: '',
  commitments: [],
  state: 'focused' as const,
  evidence: '',
}

const acts: StoredActivity[] = [
  {
    ...base,
    ts: '2026-05-29T10:00:00Z',
    capturePath: '/a.md',
    activity: 'Slack DM about the API',
    participants: ['user', 'Valentin Lieu'],
    entities: [{ entity: 'upwork-api', kind: 'project', role: 'discussed' }],
    statements: [
      { who: 'Valentin Lieu', what: 'will send PC specs when home', kind: 'committed' },
      { who: 'user', what: 'asked about the media buyer', kind: 'asked' },
    ],
  },
  {
    ...base,
    ts: '2026-05-28T09:00:00Z',
    capturePath: '/b.md',
    activity: 'Editing rollup',
    participants: ['user'],
    entities: [{ entity: 'gtd-automation', kind: 'project', role: 'edited' }],
    statements: [{ who: 'user', what: 'added dedup logic', kind: 'said' }],
  },
]

describe('statementsForEntity', () => {
  it('finds statements by person name (participant match), person-filtered', () => {
    const r = statementsForEntity(acts, { slug: 'valentin-lieu', name: 'Valentin Lieu', isPerson: true })
    expect(r).toHaveLength(1)
    expect(r[0]?.what).toContain('PC specs')
    expect(r[0]?.kind).toBe('committed')
  })

  it('finds statements by entity slug (project), all statements in the activity', () => {
    const r = statementsForEntity(acts, { slug: 'upwork-api', name: 'Upwork API' })
    expect(r.map((s) => s.who)).toEqual(['Valentin Lieu', 'user'])
  })

  it('returns nothing for an unrelated entity', () => {
    expect(statementsForEntity(acts, { slug: 'nope', name: 'Nope' })).toEqual([])
  })

  it('renders a grounded markdown section', () => {
    const r = statementsForEntity(acts, { slug: 'upwork-api', name: 'Upwork API' })
    const md = renderActivitySection(r)
    expect(md).toContain('**Valentin Lieu** [committed]: will send PC specs')
    expect(md).toContain('2026-05-29')
  })

  it('empty statements → empty section', () => {
    expect(renderActivitySection([])).toBe('')
  })

  it('dedups repeated identical statements (near-identical frames)', () => {
    const dup: StoredActivity[] = [
      { ...acts[0]!, ts: '2026-05-29T10:01:00Z' },
      acts[0]!,
    ]
    const r = statementsForEntity(dup, { slug: 'upwork-api', name: 'Upwork API' })
    expect(r).toHaveLength(2) // 2 distinct statements, not 4
  })
})
