import { describe, expect, it } from 'vitest';
import { M3Shape } from './m3-shape';

describe('M3Shape', () => {
  it('matches M3 corner-radius values', () => {
    expect(M3Shape).toEqual({ none: 0, extraSmall: 4, small: 8, medium: 12, large: 16, extraLarge: 28, full: 9999 });
  });
});
