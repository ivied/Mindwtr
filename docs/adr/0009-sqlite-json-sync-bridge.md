# ADR 0009: SQLite as Primary Store, JSON as Sync Snapshot Bridge

Date: 2026-04-16
Status: Accepted

## Context

Mindwtr persists structured data in SQLite on desktop and mobile, while sync backends exchange a JSON snapshot (`data.json`) plus attachments.

That dual representation is intentional, but the contract was only implied by code and wiki text:

- SQLite handles local reads, queries, and app startup.
- Sync backends read and write JSON snapshots.
- Sync services flush pending local saves before reading for sync.
- Desktop and mobile allow editing during sync, so they must avoid overwriting fresher local state.

Without an explicit ADR, the risk is accidental drift in future work: treating SQLite and JSON as equal peers, syncing device-local diagnostics remotely, or adding write paths that bypass the bridge invariants.

## Decision

Mindwtr keeps SQLite and JSON, but with an asymmetric contract:

1. SQLite is the primary local store.
   - Cold start, queries, and normal app reads come from SQLite-backed storage.
   - JSON is not a second local source of truth during ordinary runtime.
2. `data.json` is a transport and backup snapshot.
   - Outgoing sync exports the current app snapshot from local storage after pending local saves are flushed.
   - Incoming sync validates and normalizes external JSON, merges it with local data, then persists the merged result back into SQLite-backed storage.
3. Sync diagnostics remain device-local.
   - Settings like `lastSyncStats`, `lastSyncHistory`, and pending-remote-write recovery flags are useful locally, but are stripped from remote payloads.
4. Sync does not take a UI edit lock.
   - Desktop and mobile detect local snapshot changes during sync writes.
   - If local data changes mid-cycle, the current sync aborts and a fresh run is queued instead of overwriting the newer local state.

## Consequences

- The bridge is easier to reason about: SQLite is authoritative locally, JSON is the sync/backup representation.
- Future sync or storage changes must preserve the flush -> read -> merge -> persist contract or update this ADR.
- Device-local sync diagnostics stay useful without creating cross-device churn.
- Users can keep editing during sync, but may see a sync retry/requeue instead of a hard edit lock.
