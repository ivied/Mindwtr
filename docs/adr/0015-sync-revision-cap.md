# ADR 0015: Cap Sync Revisions At A Safe Integer Ceiling

Date: 2026-05-06
Status: Accepted

## Context

Mindwtr uses per-entity `rev` values to break otherwise ambiguous sync conflicts. Revisions are stored in JSON snapshots and can pass through JavaScript, SQLite, and platform bridges.

Normal use will not reach integer limits, but a bad migration or repair loop could inflate revision values. If revisions overflow or become non-finite, deterministic conflict resolution becomes unreliable.

## Decision

Cap sync revisions at `2_147_483_647`, the signed 32-bit integer ceiling.

When a revision is above the ceiling, normalize it down to the cap and log a sync warning. When incrementing a revision at or above the cap, preserve the capped value and log a warning instead of overflowing. When a revision crosses 90% of the cap, log a warning so a faulty migration can be detected before the value plateaus.

## Consequences

- Conflict ordering remains deterministic even for corrupted or oversized revision values.
- A device at the cap can no longer express newer changes through `rev`; timestamp and delete/live rules still apply.
- The warning is intentionally noisy because reaching this range should only happen after a bug or data repair problem.
