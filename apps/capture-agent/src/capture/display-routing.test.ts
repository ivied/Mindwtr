import { describe, it, expect } from 'bun:test'
import { findActiveDisplayIndex } from './display-routing'

const primary = { primary: true, width: 3456, height: 2234 }
const secondary = { primary: false, width: 1920, height: 1080 }

describe('findActiveDisplayIndex', () => {
  it('returns 0 for a single display', () => {
    expect(findActiveDisplayIndex(undefined, [primary])).toBe(0)
  })

  it('returns primary when window center is inside primary pixel rect', () => {
    expect(
      findActiveDisplayIndex({ x: 100, y: 200, width: 800, height: 600 }, [primary, secondary])
    ).toBe(0)
  })

  it('returns non-primary when window center is outside primary rect', () => {
    expect(
      findActiveDisplayIndex(
        { x: 4000, y: 100, width: 800, height: 600 },
        [primary, secondary]
      )
    ).toBe(1)
  })

  it('handles secondary positioned to the left (negative x)', () => {
    expect(
      findActiveDisplayIndex(
        { x: -1500, y: 200, width: 800, height: 600 },
        [primary, secondary]
      )
    ).toBe(1)
  })

  it('falls back to primary when bounds are missing', () => {
    expect(findActiveDisplayIndex(undefined, [primary, secondary])).toBe(0)
  })

  it('returns -1 when there are no displays', () => {
    expect(findActiveDisplayIndex({ x: 0, y: 0, width: 1, height: 1 }, [])).toBe(-1)
  })
})
