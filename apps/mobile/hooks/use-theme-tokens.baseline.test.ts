import { describe, expect, it } from 'vitest';
import { resolveThemeTokens } from './use-theme-tokens';
import { NON_MATERIAL_CASES } from './non-material-color-baseline.fixture';

describe('useThemeTokens colors match the frozen non-Material baseline', () => {
  it.each(NON_MATERIAL_CASES)('$name colors are byte-identical', ({ theme, expected }) => {
    expect(resolveThemeTokens(theme).colors).toEqual(expected);
  });
});
