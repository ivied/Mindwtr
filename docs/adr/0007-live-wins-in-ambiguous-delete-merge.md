# ADR 0007: Prefer Live Data in Ambiguous Delete-vs-Live Merges

Date: 2026-04-14
Status: Accepted

## Context

ADR 0003 established revision-aware sync with tombstones and deterministic tie-breakers. Its original delete-vs-live rule preferred the tombstone when operation times were equal.

After more real-world sync traffic, that rule proved too aggressive around close-together edits and clock-skewed devices. Mindwtr 0.8.2 changed the shipped behavior and release notes to prefer live data in ambiguous delete-vs-live merges.

## Decision

We keep revision-aware sync, tombstones, and deterministic tie-breakers from ADR 0003, but change the delete-vs-live ambiguity rule:

1. Compare delete-vs-live conflicts using operation time (`max(updatedAt, deletedAt)` for tombstones).
2. If the two operations are more than 30 seconds apart, the newer operation wins.
3. If the two operations fall within the 30-second ambiguity window and one side has a higher revision number, the higher revision wins.
4. Otherwise, preserve the live item instead of letting the tombstone win by default.

This supersedes the delete-vs-live winner rule in ADR 0003.

## Consequences

- The ADR set now matches the shipped 0.8.2 sync behavior and release notes.
- Near-simultaneous delete/live races are less likely to discard a valid live edit because of clock skew or stale delete propagation.
- Delete/live ambiguity remains a behavioral sync rule: future changes still require explicit ADR and test updates.
