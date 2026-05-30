import { describe, it, expect } from 'bun:test'
import { parseActivity } from './activity-extractor'

describe('parseActivity', () => {
  it('parses a full activity record', () => {
    const raw = JSON.stringify({
      activity: 'Messaging the team about the API deadline',
      project: 'upwork-api',
      surface: 'Telegram · Dev chat',
      participants: ['user', 'Valeria', 'Bob'],
      statements: [
        { who: 'Valeria', what: 'will ship the design Friday', kind: 'committed' },
        { who: 'Bob', what: 'blocked on the auth endpoint', kind: 'blocked' },
        { who: 'user', what: 'asked when the PR lands', kind: 'asked' },
      ],
      entities: [{ entity: 'upwork-api', kind: 'project', role: 'project under discussion' }],
      commitments: [{ who_owes: 'Valeria', to_whom: 'user', what: 'ship design', by_when: 'Friday' }],
      state: 'focused',
      evidence: 'Telegram thread with three participants',
    })
    const a = parseActivity(raw)
    expect(a.activity).toContain('Messaging')
    expect(a.statements).toHaveLength(3)
    expect(a.statements[1]).toEqual({ who: 'Bob', what: 'blocked on the auth endpoint', kind: 'blocked' })
    expect(a.commitments[0]?.by_when).toBe('Friday')
    expect(a.state).toBe('focused')
  })

  it('tolerates fences and surrounding prose', () => {
    const raw = 'Here you go:\n```json\n{"activity":"coding","state":"focused"}\n```'
    const a = parseActivity(raw)
    expect(a.activity).toBe('coding')
    expect(a.state).toBe('focused')
    expect(a.statements).toEqual([])
  })

  it('drops malformed statements/entities and defaults state', () => {
    const raw = JSON.stringify({
      activity: 'x',
      statements: [{ who: 'A' }, { who: 'B', what: 'hi', kind: 'weird' }],
      entities: [{ role: 'no entity' }, { entity: 'proj', kind: 'project', role: 'r' }],
      state: 'nonsense',
    })
    const a = parseActivity(raw)
    expect(a.statements).toEqual([{ who: 'B', what: 'hi', kind: 'other' }])
    expect(a.entities).toEqual([{ entity: 'proj', kind: 'project', role: 'r' }])
    expect(a.state).toBe('unclear')
  })

  it('returns empty record on junk', () => {
    const a = parseActivity('not json at all')
    expect(a).toEqual({
      activity: '',
      project: '',
      surface: '',
      participants: [],
      statements: [],
      entities: [],
      commitments: [],
      state: 'unclear',
      evidence: '',
    })
  })
})
