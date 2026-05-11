import { describe, it, expect } from 'bun:test'
import { extractCustomSections } from './rollup'

describe('extractCustomSections', () => {
  it('returns empty string for a body that only has Related + Recent mentions', () => {
    const body = [
      '# X',
      '',
      '## Related',
      '',
      '- [[a]] — co-occurs in 1 capture',
      '',
      '## Recent mentions (last 1 of 3)',
      '',
      '- 2026-05-10 12:00 · screen/App · [capture](x) — excerpt',
    ].join('\n')
    expect(extractCustomSections(body)).toBe('')
  })

  it('preserves an About section before Related', () => {
    const body = [
      '# X',
      '',
      '## About',
      '',
      'X is a thing.',
      '',
      '## Related',
      '',
      '- [[a]] — co-occurs in 1 capture',
    ].join('\n')
    const out = extractCustomSections(body)
    expect(out).toContain('## About')
    expect(out).toContain('X is a thing.')
    expect(out).not.toContain('## Related')
  })

  it('preserves multiple custom sections, drops rollup-owned ones', () => {
    const body = [
      '# X',
      '',
      '## About',
      '',
      'A short summary.',
      '',
      '## Timeline',
      '',
      '- 2026-05-01: started',
      '- 2026-05-10: shipped',
      '',
      '## Related',
      '',
      '- [[a]] — co-occurs in 1 capture',
      '',
      '## Recent mentions (last 1 of 5)',
      '',
      '- 2026-05-10 · x',
      '',
      '## Notes',
      '',
      'manual note',
    ].join('\n')
    const out = extractCustomSections(body)
    expect(out).toContain('## About')
    expect(out).toContain('A short summary.')
    expect(out).toContain('## Timeline')
    expect(out).toContain('- 2026-05-10: shipped')
    expect(out).toContain('## Notes')
    expect(out).toContain('manual note')
    expect(out).not.toContain('## Related')
    expect(out).not.toContain('## Recent mentions')
  })

  it('handles a body with no protected sections — preserves everything below title', () => {
    const body = ['# X', '', '## About', '', 'Just about.'].join('\n')
    const out = extractCustomSections(body)
    expect(out).toContain('## About')
    expect(out).toContain('Just about.')
  })

  it('handles Recent mentions with the "(last N of M)" suffix', () => {
    const body = [
      '## About',
      '',
      'A.',
      '',
      '## Recent mentions (last 30 of 446)',
      '',
      '- a',
      '- b',
    ].join('\n')
    const out = extractCustomSections(body)
    expect(out).toContain('## About')
    expect(out).toContain('A.')
    expect(out).not.toContain('## Recent mentions')
    expect(out).not.toContain('- a')
  })

  it('handles empty body', () => {
    expect(extractCustomSections('')).toBe('')
  })
})
