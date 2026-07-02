import type { M3ColorRoles } from './m3-color';

export const M3StateOpacity = { hover: 0.08, focus: 0.10, pressed: 0.10, dragged: 0.16 } as const;
export type M3StateName = keyof typeof M3StateOpacity;

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function buildStateLayer(
  opts: { isMaterial: boolean; roles: M3ColorRoles | null },
): { rippleColor: string | undefined; stateLayerColor: (state: M3StateName) => string } {
  if (!opts.isMaterial || !opts.roles) {
    return { rippleColor: undefined, stateLayerColor: () => 'transparent' };
  }
  const base = opts.roles.onSurface;
  return {
    rippleColor: hexToRgba(base, M3StateOpacity.pressed),
    stateLayerColor: (state) => hexToRgba(base, M3StateOpacity[state]),
  };
}
