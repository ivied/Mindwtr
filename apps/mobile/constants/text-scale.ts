/**
 * Shared font-scale caps for compact controls (issue #632).
 *
 * At large Android display/font sizes, labels inside fixed-width or single-row
 * controls (chips, buttons, segmented toggles, section headers, badges) grow
 * past their box and clip — sometimes with an ellipsis, sometimes hard-clipping
 * the trailing glyph. Capping the font multiplier on these control labels keeps
 * them inside their boxes while still letting body/content text scale freely for
 * accessibility.
 *
 * Apply via `CompactText` / `CompactTextInput` for the relevant controls. Do
 * NOT apply to task titles, descriptions, notes, or other reading content —
 * those should keep scaling.
 */
export const COMPACT_TEXT_MAX_SCALE = 1.2;

/**
 * Tighter cap for the bottom tab bar, whose cells are narrower than most
 * compact controls.
 */
export const COMPACT_NAV_TEXT_MAX_SCALE = 1.15;
