import { describe, it, expect } from 'bun:test'
import { parseEntitiesJson } from './entity-extractor'

describe('parseEntitiesJson', () => {
  it('parses a clean JSON array', () => {
    const raw = `[
      {"slug":"gtd-automation","name":"GTD Automation","type":"project","excerpt":"working on GTD"},
      {"slug":"claude-opus","name":"Claude Opus","type":"technology","excerpt":"using cc/claude-opus-4-6"}
    ]`
    const ents = parseEntitiesJson(raw)
    expect(ents).toHaveLength(2)
    expect(ents[0]!.slug).toBe('gtd-automation')
    expect(ents[1]!.type).toBe('technology')
  })

  it('strips markdown code fences', () => {
    const raw = '```json\n[{"slug":"x","name":"X","type":"project","excerpt":"y"}]\n```'
    expect(parseEntitiesJson(raw)).toHaveLength(1)
  })

  it('normalizes slug to kebab-case', () => {
    const raw = '[{"slug":"GTD Automation!!","name":"x","type":"project","excerpt":"y"}]'
    expect(parseEntitiesJson(raw)[0]!.slug).toBe('gtd-automation')
  })

  it('skips entries missing required fields', () => {
    const raw = '[{"slug":"ok","name":"OK","type":"project","excerpt":"y"},{"name":"missing slug"}]'
    expect(parseEntitiesJson(raw)).toHaveLength(1)
  })

  it('returns [] on garbage', () => {
    expect(parseEntitiesJson('not json')).toEqual([])
    expect(parseEntitiesJson('')).toEqual([])
    expect(parseEntitiesJson('{"not":"array"}')).toEqual([])
  })
})
