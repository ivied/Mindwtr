import { describe, expect, it } from 'vitest';
import { buildStateLayer, M3StateOpacity } from './m3-state';
import { M3Colors } from './m3-color';

describe('buildStateLayer', () => {
  it('is a no-op for non-Material themes', () => {
    const s = buildStateLayer({ isMaterial: false, roles: null });
    expect(s.rippleColor).toBeUndefined();
    expect(s.stateLayerColor('pressed')).toBe('transparent');
    expect(s.stateLayerColor('hover')).toBe('transparent');
  });
  it('exposes M3 state-layer opacities', () => {
    expect(M3StateOpacity).toEqual({ hover: 0.08, focus: 0.10, pressed: 0.10, dragged: 0.16 });
  });
  it('produces an rgba overlay from onSurface under Material', () => {
    const s = buildStateLayer({ isMaterial: true, roles: M3Colors.light });
    expect(s.rippleColor).toBeDefined();
    expect(s.stateLayerColor('pressed')).toMatch(/^rgba\(/);
  });
});
