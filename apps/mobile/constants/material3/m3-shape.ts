export const M3Shape = {
  none: 0, extraSmall: 4, small: 8, medium: 12, large: 16, extraLarge: 28, full: 9999,
} as const;

export type M3ShapeToken = keyof typeof M3Shape;
