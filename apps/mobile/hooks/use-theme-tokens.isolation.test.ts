import { describe, expect, it } from 'vitest';
import { resolveThemeTokens } from './use-theme-tokens';
import { NON_MATERIAL_CASES } from './non-material-color-baseline.fixture';

describe('non-Material themes are behaviorally untouched', () => {
  it.each(NON_MATERIAL_CASES)('$name: no ripple, no state layer, no elevation', ({ theme }) => {
    const t = resolveThemeTokens(theme);
    expect(t.isMaterial).toBe(false);
    expect(t.roles).toBeNull();
    expect(t.state.rippleColor).toBeUndefined();
    expect(t.state.stateLayerColor('pressed')).toBe('transparent');
    expect(t.elevation(0)).toEqual({});
    expect(t.elevation(3)).toEqual({});
    expect(t.elevation(5)).toEqual({});
  });
});
