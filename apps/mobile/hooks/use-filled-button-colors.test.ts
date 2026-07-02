import { describe, expect, it } from 'vitest';

import { resolveFilledButtonColors } from './use-filled-button-colors';

describe('resolveFilledButtonColors', () => {
  it('drops filled CTA buttons to the canonical primaryContainer pair under Material', () => {
    expect(resolveFilledButtonColors(
      { isMaterial: true, roles: { primaryContainer: '#00458B', onPrimaryContainer: '#D7E2FF' } },
      { tint: '#3b82f6' },
    )).toEqual({ backgroundColor: '#00458B', textColor: '#D7E2FF' });
  });

  it('keeps the tint fill and defers the label color under non-Material themes', () => {
    expect(resolveFilledButtonColors(
      { isMaterial: false, roles: null },
      { tint: '#3b82f6' },
    )).toEqual({ backgroundColor: '#3b82f6', textColor: undefined });
  });
});
