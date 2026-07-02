import { describe, expect, it } from 'vitest';
import { M3Typography } from './m3-typography';

describe('M3Typography', () => {
  it('matches the M3 type scale for representative roles', () => {
    expect(M3Typography.displayLarge).toEqual({ fontSize: 57, lineHeight: 64, fontWeight: '400', letterSpacing: -0.25 });
    expect(M3Typography.titleMedium).toEqual({ fontSize: 16, lineHeight: 24, fontWeight: '500', letterSpacing: 0.15 });
    expect(M3Typography.bodyLarge).toEqual({ fontSize: 16, lineHeight: 24, fontWeight: '400', letterSpacing: 0.5 });
    expect(M3Typography.labelSmall).toEqual({ fontSize: 11, lineHeight: 16, fontWeight: '500', letterSpacing: 0.5 });
  });
  it('defines all 15 roles', () => {
    expect(Object.keys(M3Typography)).toHaveLength(15);
  });
});
