# ADR 0018: Mobile Theming via Unified Token Hook with Theme-Isolation Invariant

Date: 2026-06-20
Status: Accepted

## Context

Mobile theming centralizes only **color**: every consumer reads from the single
`useThemeColors()` hook, and each theme (default light/dark, eink, nord, sepia, oled, and
a "Material 3" option) supplies color values. Type scale, corner radius, elevation, and
press feedback are inline `StyleSheet` in ~82 bespoke components.

The shipped "Material 3" theme is **Material in name only** — a single palette mapped onto
the generic color shape, with no M3 type scale, shape system, tonal elevation, or state
layers. Deepening it to a genuine Material 3 design system risks a different problem:
*leaking Material traits into the other themes*, several of which (eink, nord, sepia,
oled) are deliberately non-Material and must stay exactly as they are.

Two delivery shapes were considered and rejected:

- **A new M3 primitive component set** (`M3Button`, `M3Card`, FAB…) and swapping call
  sites — a larger rewrite that risks behavior drift and exceeds the agreed scope.
- **Inline `themeStyle === 'material3'` branches** in each component — scatters M3 logic
  with no reusable foundation (the per-view-duplication anti-pattern).

## Decision

Mobile theming uses a single **token hook** rather than ad-hoc per-component styling.

1. `useThemeTokens()` returns `{ colors, type, shape, elevation, state, isMaterial }`.
   The Material 3 theme supplies Material values for every category; **every other theme
   supplies "today's look" defaults**. Converting a component to consume tokens is a
   visual/behavioral no-op for non-Material themes and Materializes the same component
   under M3.
2. `useThemeColors()` is retained and re-implemented to delegate to `useThemeTokens()`,
   so existing call sites keep working and Materialization proceeds incrementally,
   surface by surface — no flag day, and unconverted surfaces are never broken, only
   "not yet Materialized."
3. **Behavioral tokens are gated, not just colored.** Elevation and ripple/state-layers
   are new visual/interactive effects that do not exist today; they are gated behind
   `isMaterial` (true only under the Material 3 theme). Under non-Material themes the
   helpers are no-ops: no ripple color, transparent state layer, empty elevation style.
4. **Theme isolation is a test-enforced invariant**, covering both dimensions:
   - a **byte-identical color regression** asserting every non-Material theme's resolved
     colors equal today's output, and
   - a **behavioral non-degradation** suite asserting `isMaterial === false`, no ripple,
     transparent state layer, and empty elevation style for each non-Material theme.

   Color substitution alone cannot prove the behavioral effects don't leak, so both
   assertions are required; a future token change cannot silently Materialize another
   theme without failing CI.
5. **No new `theme` enum values.** The existing `material3-light` / `material3-dark`
   modes are kept, so there are no `packages/core` types, sync, or settings changes. M3
   stays explicit two-mode; "system appearance → auto light/dark" is deferred as a
   separate, theme-agnostic feature. No `react-native-paper` and no Material You /
   dynamic color.

## Consequences

- The Material 3 theme can become a genuine M3 design system (color roles, type scale,
  shape, tonal elevation, state layers) *through* existing components, without a UI
  rewrite or a new dependency.
- "Does this degrade my other themes?" stops being a hope and becomes a CI-enforced
  property across both color and behavior.
- Partial Materialization is acceptable: a bounded set of high-traffic surfaces is
  converted first; the rest keep working and can be picked up later.
- One user-visible change for existing Material-theme users: primary action surfaces move
  from `primary` to `primaryContainer` (correct M3). This warrants a release-notes line.
- Future themes and future token categories plug into the same hook; the isolation
  invariant guards against regressions as the system grows.
- This decision is scoped to `apps/mobile` and does not affect desktop theming, the core
  data model, or sync.

## References

- Working design detail: `docs/superpowers/specs/2026-06-20-mobile-material3-theme-design.md`
  (untracked local working file; this ADR is the durable record of the decision).
