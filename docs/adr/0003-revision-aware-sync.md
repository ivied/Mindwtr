# ADR 0003: Revision-Aware Sync With Deterministic Tombstone Resolution

Date: 2026-03-06
Status: Superseded by ADR 0007

## Context

Mindwtr is local-first and syncs across multiple devices and providers. Sync conflicts must converge deterministically without central coordination, while still preserving deletes safely.

Pure timestamp-based last-write-wins is not sufficient on its own because:

- device clocks can drift
- deletes must not disappear during merges
- equal timestamps still need deterministic resolution

This ADR captures the original delete-vs-live ambiguity rule that shipped before Mindwtr 0.8.2. ADR 0007 supersedes the delete-vs-live winner rule while keeping the rest of the revision-aware merge approach in place.

## Decision

We use revision-aware merge metadata (`rev`, `revBy`) together with timestamps and tombstones.

The merge strategy is:

1. Normalize entities before merge.
2. Prefer higher revision metadata when available.
3. Use timestamps as the next ordering signal.
4. Historical rule at the time: when delete-vs-live operation times are equal, prefer the tombstone.
5. Fall back to deterministic tie-breakers so every client converges on the same winner.

This intentionally favors safe deletion propagation over keeping a live record when the operation times are indistinguishable.

## Consequences

- Sync remains deterministic across clients and providers.
- Equal-time delete/live races resolve consistently instead of depending on iteration order.
- Tombstones remain a core part of the data model and must be preserved until retention rules allow purge.
- Any future change to delete/live ambiguity rules must be treated as a behavioral sync migration, not a cosmetic tweak.
