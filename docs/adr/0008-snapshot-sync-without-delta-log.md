# ADR 0008: Snapshot Sync Without a Delta Log

Date: 2026-04-16
Status: Accepted

## Context

Mindwtr already ships file-based BYOS sync and other backends using full-snapshot merge. The current sync model is revision-aware and deterministic:

- ADR 0003 introduced `rev` and `revBy` metadata with tombstone-aware merge rules.
- ADR 0007 kept that model and changed only the ambiguous delete-vs-live winner rule.

For a personal GTD app at current scale, the snapshot approach is still the right trade-off because:

- entity counts are small
- device counts are low
- data is per-user rather than shared at team scale
- full-file writes are simple and atomic
- the existing `rev` and `revBy` fields already prevent lost updates without a separate operation log

A delta log would add compaction, watermark tracking, replay rules, and more sync state to debug. That complexity is not justified yet.

## Decision

Mindwtr keeps snapshot merge and does not add a delta log at this time.

If sync transport evolves later, it must build on the existing `rev` and `revBy` metadata and preserve the current conflict rules from ADR 0003 and ADR 0007. We are not introducing a new sequence-number scheme.

## Consequences

- Sync remains simpler to reason about: merge two snapshots, write one merged result, and keep full-file atomicity.
- Current implementation work should focus on store reactivity, targeted updates, and sync UX rather than inventing a second sync representation.
- We should revisit this decision only if one or more of these thresholds are crossed:
  - a user's snapshot file exceeds 5 MB
  - sync round-trip latency exceeds 5 seconds on a typical network
  - Mindwtr needs real-time multi-device streaming
- If that revisit happens, the first design to evaluate is an append-only `mindwtr-delta.jsonl` alongside `mindwtr-snapshot.json`, built on top of the existing `rev` and `revBy` metadata, keeping the current conflict resolution rules, compacting by the highest revision per entity id, and tracking watermarks per device.
