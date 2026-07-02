# ADR 0020: Sync Document Lifecycle and Growth

Date: 2026-07-02
Status: Accepted

## Context

The same scalability question keeps coming back in community discussions (#629 split archives into `archive.json`, #793 why `data.json` grows and shrinks, #802 append-only time entries): what grows in the synced dataset, what shrinks it, and what is the long-term plan when it gets big?

The answers exist, but only as scattered discussion replies. Design constraints from earlier ADRs and incidents:

- ADR 0008 keeps full-snapshot merge without a delta log.
- File backends (WebDAV, folder, Dropbox) upload files independently. Splitting the dataset across files turns archive/unarchive into a cross-file transaction and invites split-brain (#629).
- Legacy fields live in remote payloads for years; removing one without a strip step caused the #698 perpetual-conflict incident.

## Decision

1. **One synced document.** The dataset stays a single merge unit. No `archive.json`, no per-entity files, unless a future change brings an atomic multi-file commit protocol with it. Features prefer fields on existing entities over new top-level documents.
2. **SQLite is the store; `data.json` is a snapshot.** The local source of truth is SQLite. `data.json` is rewritten from the store as a sync/backup snapshot — it is not an append log and needs no manual compaction.
3. **Growth is bounded by lifecycle rules, declared at design time.** Deleted entities become tombstones and are pruned after the retention window (90 days by default). Trash purge removes entities immediately (keeping a tombstone until retention expires). Attachment metadata and pending remote deletes have bounded retries and ages. Any new synced data must state its growth curve up front; append-forever data is only acceptable with a rollup or retention rule defined at birth, not "later".
4. **Payload-size optimization direction is record-level incremental sync**, building on `rev`/`revBy` (ADR 0008), not more files. Until then, snapshot size is the accepted trade-off.
5. **Legacy field trims are migration-gated.** For example, tasks serialize both `order` and its legacy alias `orderNum`. Dropping an alias from payloads requires a strip/normalization step that tolerates old clients (the #698 lesson); it is scheduled work, not a quick cleanup.

## Consequences

- Community questions about file growth can be answered with one docs page instead of per-thread explanations.
- Proposals that add unbounded synced data (for example per-session time logs) are evaluated against rule 3 before implementation.
- Sync transport work, when it happens, is scoped to incremental record exchange rather than file layout changes.
