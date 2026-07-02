import { describe, expect, it } from 'vitest';
import { buildElevationStyle } from './m3-elevation';
import { M3Colors } from './m3-color';

describe('buildElevationStyle', () => {
  it('returns {} for non-Material themes (no shadow, no surface shift)', () => {
    expect(buildElevationStyle(3, { isMaterial: false, roles: null })).toEqual({});
    expect(buildElevationStyle(3, { isMaterial: false, roles: M3Colors.light })).toEqual({});
    expect(buildElevationStyle(3, { isMaterial: true, roles: null })).toEqual({});
  });
  it('level 0 has no shadow but uses the base surface under Material', () => {
    const s = buildElevationStyle(0, { isMaterial: true, roles: M3Colors.light });
    expect(s.backgroundColor).toBe(M3Colors.light.surface);
    expect(s.elevation ?? 0).toBe(0);
  });
  it('higher levels map to higher tonal surfaces under Material', () => {
    const l1 = buildElevationStyle(1, { isMaterial: true, roles: M3Colors.light });
    const l3 = buildElevationStyle(3, { isMaterial: true, roles: M3Colors.light });
    expect(l1.backgroundColor).toBe(M3Colors.light.surfaceContainerLow);
    expect(l3.backgroundColor).toBe(M3Colors.light.surfaceContainerHigh);
    expect((l3.elevation ?? 0)).toBeGreaterThan(l1.elevation ?? 0);
  });
});
