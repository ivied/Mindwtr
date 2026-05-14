# Sync Algorithm

Mindwtr uses local-first synchronization with deterministic conflict handling.

This page is the technical merge reference for maintainers and debugging. For user-facing backend setup, recovery steps, and operational guidance, see [[Data and Sync]].

## Inputs and Outputs

- Input A: local snapshot (`tasks`, `projects`, `sections`, `areas`, `settings`)
- Input B: remote snapshot (same shape)
- Output: merged snapshot + merge stats (`conflicts`, `clockSkew`, `timestampAdjustments`, `futureTimestampClamps`, `conflictIds`, `conflictReasonCounts`, `conflictSamples`, `timestampAdjustmentIds`, `futureTimestampClampIds`) plus bounded sync diagnostics logs.

## Snapshot-Based Transport

Mindwtr currently syncs by merging full snapshots. That is the intended design, not an unbuilt delta layer.

- ADR 0003 and ADR 0007 define the revision-aware merge behavior that runs on top of the snapshot payload.
- ADR 0008 records the transport decision to keep snapshot sync and defer any append-only delta log.
- ADR 0009 records the SQLite-to-JSON bridge contract: SQLite is the primary local store, while `data.json` is the sync/backup snapshot.
- For current scale, this keeps sync atomic and easier to reason about than replaying and compacting per-device operation logs.

Revisit ADR 0008 only if snapshot files regularly exceed 5 MB, sync round-trips exceed 5 seconds on typical networks, or Mindwtr needs real-time multi-device streaming. If that happens, the delta design should extend existing `rev` and `revBy` metadata instead of introducing a parallel sequence scheme.

## Merge Rules

1. Entities are matched by `id`.
2. If entity exists on one side only, it is kept.
3. If both exist, merge uses revision-aware LWW:
   - Compare `rev` first (higher wins).
   - If revisions tie, compare `updatedAt` (newer wins).
   - If timestamps tie, apply deterministic tie-break by normalized content signature.
4. Soft-deletes use operation time:
   - Operation time = `max(updatedAt, deletedAt)` for tombstones.
   - Live-vs-deleted conflicts choose newer operation time.
   - If the delete-vs-live operation times are within 30 seconds of each other and the revision numbers tie, Mindwtr preserves the live item instead of immediately letting the tombstone win. This is the deliberate ambiguous-window rule that can make a just-deleted task reappear after a concurrent edit on another device.
   - If revisions differ inside that 30-second window, the higher revision still wins.
   - Legacy records without revision metadata prefer the tombstone inside that same window.
   - When a delete wins over a live edit, Mindwtr emits a bounded `syncConflictDiscarded` diagnostic entry with entity type, ID, operation timing, and revision metadata.
   - When the ambiguous-window live item is preserved, Mindwtr emits a bounded `Preserved live item during ambiguous delete-vs-live merge` diagnostic entry and stores conflict metadata in sync history/settings.
5. Invalid `deletedAt` falls back to `updatedAt` for conservative operation timing.
6. Attachments are merged per attachment `id` with the same LWW rules.
7. Project archive restore metadata is opaque sync metadata:
   - Archiving a project records temporary restore metadata on tasks and sections that the archive action changed.
   - This metadata is ignored by comparable and deterministic sync signatures, so archive bookkeeping alone does not create a content conflict or deterministic winner.
   - Unarchive restores only records that still match the archive-generated change. Tasks that were deleted, manually changed, or moved to a different project are preserved as-is and may retain the opaque metadata until the record is next rewritten by a real user or sync change.
8. Areas use tombstones:
   - Deleting an area cascades soft-delete timestamps to projects, sections, and tasks that belong to that area.
   - Restoring an area restores the children from the same cascade. Children deleted independently at a different timestamp stay deleted.
   - If an incoming snapshot references a missing or deleted area, sync repair clears the stale `areaId` reference and stamps a repair revision.
   - Sync repair also runs on tombstones, so deleted projects/tasks do not keep stale area links if they are later restored.
   - Missing area order values are synthesized during merge and stamped with `revBy: "sync-repair"` so the repair is not repeatedly overwritten by peers.
9. Settings merge by sync preferences:
   - Appearance/language/GTD scheduling/external calendars/AI/saved filters can be merged independently.
   - Conflict resolution uses group-level timestamps (`appearance`, `language`, `gtd`, `externalCalendars`, `ai`, `savedFilters`).
   - Concurrent edits to different fields inside the same group can still collapse to the newer group update.
   - A local `syncPreferences` opt-out is bidirectional for that group: Mindwtr does not send that group to remote and does not accept incoming remote changes for it.
   - Secrets (API keys, local model paths) are never synced.
10. Remote-write recovery is explicit:
   - Local data is first written with `pendingRemoteWriteAt`.
   - Remote write clears the flag on success.
   - Failed remote writes schedule retries with exponential backoff from 5 seconds up to 5 minutes.
   - After 12 failed remote-write retries, Mindwtr marks sync as `error` and surfaces the backend failure instead of retrying forever.
   - Device-local sync diagnostics stay local and are stripped before remote writes.
11. Clock skew telemetry:
   - Merge stats record the largest observed skew.
   - Warnings surface when skew exceeds 5 minutes.
   - Future `updatedAt` values are clamped to the merge-time clock for comparison and counted in `futureTimestampClamps`.
   - If both sides of the same record are future-clamped, Mindwtr emits a bounded `Both merge candidates had future updatedAt timestamps clamped` diagnostic with the record ID and clamp time.
12. Local edits during sync do not take a hard lock:
   - Desktop and mobile detect when local state changed during the sync write phase.
   - When that happens, the current cycle aborts and a fresh sync is queued rather than overwriting the newer local snapshot.

## Pseudocode

```text
read local
read remote
validate payload shape
normalize entities (timestamps, revision metadata)

for each entity type in [tasks, projects, sections, areas]:
  index local by id
  index remote by id
  for each id in union(localIds, remoteIds):
    if only one side exists: keep it
    else:
      winner = resolveWinner(localItem, remoteItem)
      mergedItem = mergeConflict(localItem, remoteItem, winner) // attachments/settings-specific logic
      push mergedItem

merge settings by sync preferences
validate merged payload
write local
write remote
record sync history and diagnostics
```

## Conflict Examples

### Example 1: Live vs Deleted

- Local: task `t1` updated at `10:01`, not deleted
- Remote: task `t1` deleted at `10:03`
- Result: deleted version wins (`10:03` operation time is newer)

### Example 1b: Ambiguous delete vs live

- Local: task `t1` edited at `10:00:05`, still live
- Remote: task `t1` deleted at `10:00:20`
- Both records have the same revision number
- Result: live item wins because the operations are only 15 seconds apart and the revision metadata ties inside the ambiguity window

### Example 2: Equal Revision and Timestamp

- Local and remote both have `rev=4`, `updatedAt=10:00`
- Content differs (`title`, `tags`, etc.)
- Result: deterministic signature comparison picks the same winner on all devices

### Example 3: Invalid deletedAt

- Local tombstone has `deletedAt="invalid-date"` and `updatedAt=09:30`
- Remote live item has `updatedAt=10:00`
- Result: live item wins because invalid delete uses `updatedAt` fallback (`09:30`)

## Attachments

- Metadata merge runs before file transfer reconciliation.
- Winner attachment URI/local status is preserved when usable.
- If winner has no usable local URI, merge can fall back to the other side URI/status.
- Attachment delete-vs-live races use the same merge and `syncConflictDiscarded` diagnostics as tasks/projects, so a deleted attachment winning over a concurrent metadata edit is visible in diagnostics.
- Missing local files are handled later by attachment sync/download.
- `settings.attachments.pendingRemoteDeletes` records remote files that still need deletion after a local attachment delete.
- Pending remote deletes are retained until the remote delete succeeds. They are not purged by age, because dropping them before success can leave deleted files orphaned on the backend.
- Mindwtr Cloud also exposes an authenticated orphan cleanup endpoint that deletes attachment files not referenced by the current snapshot.

## Cloud Server Merge

Mindwtr Cloud is not a dumb object store for `/v1/data`. On authenticated `PUT /v1/data`, the server reads the existing namespace snapshot, runs the same merge algorithm with the incoming snapshot, validates the merged result, and writes that result back.

Operational consequences:

- Pushing a full snapshot is not a forced overwrite. Existing remote records with higher revisions, newer operation times, or winning tombstones can survive the PUT.
- Server-side reference repair can create cascade updates, such as tombstoning sections under deleted projects.
- Server-generated repair timestamps use the server wall clock. This avoids letting a fast client clock advance server repair metadata.
- Successful `PUT /v1/data` responses include `{ ok: true, stats, clockSkewWarning }` so clients and tests can inspect the merge outcome used by the server.

## Fast Unchanged Check

Cloud clients can issue `HEAD /v1/data` before downloading a full snapshot. The server returns `ETag`, `Last-Modified`, and `Content-Length` metadata without a response body. Clients compare that metadata with the last successful sync and skip the full `GET /v1/data` path when the remote namespace is unchanged.

The server caches the SHA-256 ETag by file stat metadata so repeated unchanged `HEAD` checks do not re-hash the whole snapshot.

## Scheduled Background Sync

Mobile background sync is scheduled with a conservative minimum interval of 15 minutes. The background task lazy-loads importer/sync code only when needed, then runs the same snapshot merge and remote-write retry logic described above.

Background sync is opportunistic: the OS can delay or skip a run, so manual sync and foreground sync remain the reliable recovery paths when connectivity or credentials have changed.

## Retry Recovery

- A failed remote write does not silently discard the just-merged local state.
- `pendingRemoteWriteAt`, `pendingRemoteWriteRetryAt`, and `pendingRemoteWriteAttempts` are stored locally.
- The next sync pauses until the retry window expires, then retries using the preserved local snapshot plus any newer local edits.
- After 12 retry attempts, sync status changes to `error`. The preserved local snapshot remains local and the status UI should direct the user to check backend connectivity or credentials.

## Tombstone Purge Bound

Tombstones protect deletes only while they are retained. The current retention policy is bounded by `tombstoneRetentionDays`.

Operationally, a device that has been offline longer than the retention window can reintroduce records whose delete tombstones were already purged on other devices. Mindwtr treats this as the documented consistency bound for snapshot sync. Users should sync long-offline devices before relying on old local data, and future protocol work should reject snapshots whose last successful sync predates the purge horizon if stricter guarantees are needed.

## Diagnostics You Can Inspect

- Conflict count and IDs
- Conflict reason counts and bounded conflict samples
- Max clock skew observed
- Timestamp normalization adjustments
- IDs of records whose timestamps were normalized
- Future timestamp clamp counts and IDs
- `syncConflictDiscarded` entries for delete-vs-live conflicts where the live side was discarded
- Last sync status/history in Settings

## Related docs

- [[Data and Sync]]
- [[Cloud API]]
- [[Cloud Deployment]]
- [[Diagnostics and Logs]]
- [[Core API]]

## Troubleshooting

If you see repeated conflicts or skew warnings:

1. Verify device clocks (automatic network time enabled).
2. Check sync backend connectivity/auth.
3. Inspect sync diagnostics in app settings and logs.
