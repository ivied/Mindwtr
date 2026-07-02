import { describe, expect, it } from 'vitest';
import { resolveThemeColors } from './use-theme-colors';
import { NON_MATERIAL_CASES } from './non-material-color-baseline.fixture';

describe('non-Material color isolation (byte-identical to today)', () => {
  it.each(NON_MATERIAL_CASES)('$name is unchanged', ({ theme, expected }) => {
    expect(resolveThemeColors(theme)).toEqual(expected);
  });
});
