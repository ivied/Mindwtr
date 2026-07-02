# ADR 0017: Defer CRDT Sync Adoption

Date: 2026-05-30
Status: Accepted

## Context

Mindwtr currently uses SQLite as the primary local store and JSON snapshots as the sync and backup bridge. The shared core sync path validates and normalizes local and remote snapshots, merges entity arrays with `rev`/`revBy`, preserves tombstones, repairs references, records conflict diagnostics, and writes the merged result back through backend-specific ports.

Loro is a strong CRDT candidate for local-first software:

- it is implemented in Rust and exposes JavaScript/TypeScript and Swift bindings
- it supports byte-oriented update import/export that can be moved through arbitrary transports
- it includes movable tree, movable list, text, map, version vector, snapshot, and time-travel primitives
- its movable tree model is relevant if Mindwtr grows into deeper recursive task/project hierarchies

However, adopting CRDT is not a drop-in replacement for the current sync algorithm. Mindwtr's product and data model are still mostly personal GTD snapshots:

- hierarchy is represented by flat records with `areaId`, `projectId`, and `sectionId`, not an arbitrary recursive tree
- checklist items are task-local arrays, not independent cross-device entities
- sync backends are BYOS snapshot transports: file sync, WebDAV, Dropbox, CloudKit, and self-hosted cloud
- JSON backup/export and cloud API compatibility are part of the public contract
- attachments and device-local sync diagnostics need app-specific handling outside any CRDT document
- current conflict diagnostics are user-visible and tied to the existing merge statistics shape

Switching the production source of sync truth to a CRDT document would require a data-model migration, dual-read/write compatibility, mobile packaging validation, backup/export compatibility, cloud API changes, and a new diagnostics story.

## Decision

Mindwtr will not replace the current production sync engine with a CRDT document at this time.

The current architecture remains:

1. SQLite is the primary local store.
2. JSON `AppData` snapshots remain the sync, backup, import/export, and cloud API bridge.
3. Core sync keeps the existing revision-aware snapshot merge, tombstone retention, validation, reference repair, and serialized merge/write window.
4. CRDT libraries, including Loro, may be evaluated in prototypes, but they must not become production sync dependencies until the migration and compatibility questions are answered.

A CRDT prototype must prove at least:

1. deterministic round-trip between current `AppData` JSON and the CRDT document model
2. React Native Android and iOS packaging viability, not only Tauri or desktop web viability
3. compatibility with existing sync tests for delete-vs-live conflicts, tombstones, settings sync preferences, reference repair, and attachment metadata
4. preservation of JSON backup/export and self-hosted cloud API compatibility
5. a diagnostics model that can replace or map back to current `MergeStats` and sync history entries
6. a migration path for existing user data and older app versions

CRDT adoption should be reconsidered only if one or more product requirements materially change:

- real-time multi-user collaboration becomes a first-class feature
- Mindwtr introduces recursive outliner-style tasks or project trees where concurrent moves are common
- peer-to-peer sync becomes a supported backend
- edit-history/time-travel recovery becomes a core user feature
- snapshot size or sync latency crosses the thresholds described in ADR 0008

## Consequences

- The production sync model stays simple, debuggable, and compatible with current BYOS backends.
- Loro remains a plausible future direction, especially for collaborative notes, nested task trees, or P2P sync, but not a near-term replacement for `mergeAppData`.
- Future CRDT work should start behind an isolated adapter or experiment, not by rewriting core store actions or replacing the JSON bridge.
- Any future CRDT-backed model must still expose `AppData` JSON as a stable compatibility boundary unless a separate ADR intentionally deprecates that contract.
- This decision extends ADR 0008 and ADR 0009 rather than superseding them.
