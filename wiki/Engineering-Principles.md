# Engineering Principles

Design principles, constraints, and guardrails derived from the full issue/discussion history of this repo (569 issues, 89 discussions, through v0.9.10). Each principle cites the incidents that produced it. New features and fixes should be checked against this page before implementation.

The single biggest lesson across the history: **almost every critical (P0/P1) bug was a data-integrity bug in a multi-writer path** — sync vs. UI, sync vs. itself, app vs. MCP/CLI, snapshot vs. incremental save. UI bugs were plentiful but cheap; write-path bugs cost user data and trust.

---

## 1. Writes and persistence

### P1 — Every write is revision-guarded; arrival order is never trusted
A lower-`rev` payload must not be able to overwrite a higher-`rev` row, enforced at the lowest layer (the SQL upsert), not in callers.

- **#693 (P1, critical):** `updateTask` persisted via fire-and-forget `saveTask` while a debounced full-snapshot `saveData` could land later and clobber the newer row — the task upsert had no rev guard. In short-lived MCP processes the write was lost entirely. Fix: `WHERE tasks.rev IS NULL OR tasks.rev <= excluded.rev` on the upsert + tracking the in-flight save in `flushPendingSave()`.
- **#316:** edits made *during* a sync (complete a task, switch area) were reverted when the in-flight sync's refresh landed. Took three fixes: skip stale fetch results, advance the local change marker even for same-millisecond edits, then diagnostics to find the rest.

**Guardrail:** any new persistence path (new entity, new save call, new process) must answer: *what stops an older payload from overwriting a newer one?* If the answer is "timing", it's a bug.

### P2 — Deletes detach, never cascade; restores outrank tombstones
- **#609 (P0, critical):** deleting an Area deleted every task and project in it. Worse, after the user restored from backup, sync's tombstones kept re-deleting the restored data on every cycle. Fix: area delete now clears `areaId` only; backup restore stamps recovered records as fresh local data so stale remote tombstones lose.

**Guardrail:** deleting a container (area/project/section/tag) detaches children. Any restore/import path must re-author the data (fresh rev/updatedAt) so it cannot lose to tombstones created by the very bug the user is recovering from.

### P3 — Fire-and-forget success is a lie; reply only after durable persistence
- **#694:** MCP write tools returned the mutated task from the in-memory store, but `saveData` had silently failed — reads (different DB connection) and the desktop app showed old data. The tool "succeeded" while persisting nothing.
- **#693:** same root: process exited before the untracked save promise resolved.

**Guardrail:** an API/tool/IPC response claiming a write succeeded must be sent only after the storage layer confirms it. Track every save promise; `flushPendingSave()` must cover *all* pending work.

---

## 2. Sync convergence

### P4 — Merge must be a fixed point: re-merging already-synced data is a no-op
- **#698:** a *removed* legacy field (`showFutureRecurrence`) survived in stored payloads on one side. Content signatures were built via `{...task}` spread, so the unknown key produced **325 perpetual conflicts** on every sync, with identical revs and timestamps.
- **#418:** `null` vs. *omitted* optional fields hashed differently → endless false conflicts plus bogus "3-hour clock skew" warnings driven by stale entity timestamps, not clocks.
- **#142:** legacy invalid `revBy` aborted merge validation entirely until sanitized.

**Guardrails:**
- Content signatures are computed from an **explicit field allowlist**, never object spread. Unknown/legacy keys never enter comparison.
- Normalization is idempotent and convergent: `normalize(normalize(x)) === normalize(x)`, and `null` ≡ missing for optional fields.
- When a field is removed from the schema, ship a migration/strip step — old payloads live in remotes for years.
- A "fresh sync against aligned data yields zero conflicts" test belongs in the suite for every signature change.

### P5 — Sync's own writes must be invisible to sync's triggers
The #718/#725 "keeps syncing forever" saga needed **six fixes**, each a different self-feedback loop:
1. sync persistence not marking the SQLite-watcher ignore window → own write seen as external change;
2. sync status/history writes re-dirtying data state;
3. status writes saving a **stale in-memory snapshot** that undid just-merged entities (requeueing the same merge);
4. load-time dedupe of a duplicate area name rewriting data on *every load*;
5. people list not persisted in SQLite → backfilled and marked dirty on every load;
6. `mindwtr.db-shm` file noise treated as an external write.

Earlier same-class bugs: **#309** (watcher merging the app's own `data.json` back as external change — needed a *window* of recent self-write hashes, not just the latest), **#502** (constant sync-activity UI).

**Guardrails:**
- Every byte written by sync (data, status, history, snapshots) is marked self-written for every watcher that could observe it.
- Sync metadata (status/history) is written on top of the persisted snapshot, never from possibly-stale UI state — better, keep it out-of-band from user data.
- **Loading data never mutates it.** Migrations/dedupes are explicit one-time passes, not load-time normalization that dirties state.
- Every automatic trigger needs a termination argument: no-work → no run (#725), failure → cooldown (#718 fix 5, #133 airplane mode), success → idle.

### P6 — User edits during sync are sacred
- **#323:** clicking the Status dropdown triggered a focus/blur sync that reverted all unsaved edits in the open editor. Fix: auto-sync ignores focus/blur triggers while an editor is open.
- **#316 / #128:** "every action reverted after a few seconds" — top trust-destroying symptom in the history.

**Guardrail:** any new sync trigger must be checked against "what if the user is mid-edit?" The local-edit side requeues; it is never clobbered. (This is what the `lastDataChangeAt` snapshot + `LocalSyncAbort` + requeue machinery exists for — new sync work must go through it.)

### P7 — The sync document is one merge unit; don't split it without a transaction story
- **#629 (discussion):** `archive.json` split rejected — archive/unarchive becomes a cross-file transaction; file backends upload files independently → split-brain. Documented direction: record-level incremental sync, not more files.
- **#113 (discussion):** Syncthing conflicts are file-level by design; app-controlled backends (WebDAV/cloud) are the recommended answer, not smarter file naming.

**Constraint:** features must not add a second synced document (or per-entity files) unless they bring an atomic multi-file commit protocol. Prefer fields-on-entities over new top-level documents.

---

## 3. Attachments (binary + metadata two-phase rule)

### P8 — Upload bytes first; publish metadata second; 404 is terminal
- **#176:** sync sanitized attachment `uri` to `""` and published metadata *before* upload completed → attachments with no `cloudKey`, no file anywhere, unrecoverable. Then the "block until uploaded" fix exposed uploads that never ran (`content://` URIs with missing size metadata) → sync blocked forever. Four fixes total.
- **#213 / #128:** stale `pendingRemoteDeletes` and missing-remote metadata caused infinite retry loops; deleting the data by hand didn't help because sync restored it.
- **#399:** SAF trailing-slash document URIs made the existing attachments dir invisible → a *new full copy of all attachments every sync*.
- **#655:** remote 404 retried/poll-looped indefinitely; `EISDIR` from a tmp-file collision followed.

**Guardrails:**
- Order is invariant: bytes uploaded → `cloudKey` recorded → metadata published. Never the reverse.
- Every remote-file failure classifies as retryable (bounded, with backoff) or terminal (404 → mark unrecoverable, stop). No unbounded retries anywhere in attachment code.
- Identity checks use canonical IDs/keys, never provider URI string forms (SAF trailing slashes, `content://` quirks).
- Attachment phases skip when metadata shows no pending work (perf *and* loop safety).
- Known open hazard (2026-06 review): `duplicateTask` shares `cloudKey` between copies with no refcount — deleting one deletes the other's bytes. Don't add new shared-key paths.

---

## 4. Multi-process access (MCP, CLI, local API)

### P9 — One canonical store, one serialized write path; every writer is a full citizen or read-only
- **#179 / #285:** the CLI wrote tasks into `data.json` — which is an **export mirror**, read once at startup and overwritten thereafter — with `rev`/`revBy`/`taskMode` missing, so even when imported, merge silently dropped them.
- **#722:** desktop app + local MCP writing the same SQLite concurrently → lock conflicts; the dangerous workaround (two writers via shared storage) had to be documented as unsupported. Fix: fail fast on a held writer lock, **reload current data, retry the whole operation** — never resume from a pre-lock snapshot.
- **#650:** long-lived desktop WAL read snapshot didn't see MCP writes until restart.
- **#367:** Mac App Store sandbox relocated the DB; MCP's path resolver knew only unsandboxed paths.

**Guardrails:**
- All entity creation goes through core factories that stamp every sync-required field (`rev`, `revBy`, `createdAt`, `updatedAt`, defaults). A writer that hand-rolls JSON is a future data-loss bug. (The cloud server's `POST /v1/tasks` missing rev-stamping is this same class — fix pending.)
- External writers either embed core's store + storage adapter, or stay read-only.
- Cross-process write protocol: acquire lock → (on conflict) reload → reapply → write. Stale-snapshot continuation is forbidden.
- Path resolution must enumerate sandboxed install channels (App Store containers, Flatpak, etc.).

---

## 5. Dates, recurrence, status semantics

### P10 — One shared "next instance" function; all fields advance together; regeneration is idempotent
The recurrence cluster is the most re-broken feature area in the history:
- **#140:** custom recurrence advanced `dueDate` but not `startTime` → completed task instantly reappeared in Focus.
- **#241:** regenerated instance lost `sectionId`/`areaId`.
- **#187 → #717:** repeat-after-completion follow-ups landed in Next immediately (no deferred `startTime`); the same symptom returned a version-cycle later for date-only start dates and mode switches.
- **#662:** completing created a duplicate when an equivalent open follow-up already existed.
- **#557:** one small projection feature took **7+ follow-up fixes**: nth-weekday vs. day-of-month, no-start-date anchoring, monthly metadata lost on load/save/edit round-trips, mislabeled projections.
- **#17:** COUNT-limited RRULEs expanded "from the current month", resurrecting 10-year-old series.

**Guardrails:**
- Exactly one core function computes the next instance. It must: advance start/due/review coherently; preserve *all* context fields (project, section, area, contexts, tags, checklist-reset rules); keep date-only values date-only; anchor RRULE expansion at series start, not "now"; and be idempotent (skip if an equivalent open follow-up exists).
- Recurrence metadata must survive load → save → edit round-trips; add a round-trip test for any new recurrence field.
- The regression matrix for any recurrence change: `{strict, after-completion} × {start-only, due-only, both, neither} × {daily, weekly, monthly-day, monthly-nth-weekday, yearly, COUNT-limited} × {date-only, datetime}`.

### P11 — Status outranks dates; visibility predicates live in core, once
- **#341:** WAITING task surfaced in NEXT because a start-date rule ignored status.
- **#237:** desktop and mobile computed "Today" differently; tasks visible on one platform were invisible on the other. The fix ended with both platforms consuming one shared rule.
- **#144:** auto-promote scheduled→next was implemented in core fetch maintenance precisely so both apps inherit it.
- **#591:** the repo's own derived rule: date-coherence (e.g., `startTime` after `dueDate`) is detected centrally as **derived state**, in core normalization, applied to *all* write paths — and synced input is treated as untrusted and re-checked.

**Guardrails:**
- Any predicate that decides where a task appears (`isToday`, `isAvailable`, deferred, review-due) is defined in `packages/core` and imported by both apps. A view reimplementing one is a bug even if it currently agrees.
- Status is the primary axis; dates modulate within a status, never across it.
- Don't auto-mutate user dates to enforce coherence — surface derived warnings instead (#591's resolution: a user may deliberately keep a task overdue-but-deferred).

### P12 — One active instance per recurring task is a product invariant
- **#552 → #557:** pre-creating future real instances was rejected deliberately ("makes completion, deletion, sync, and duplicate behavior harder to reason about"); the accepted design was a **read-only projection**.

**Constraint:** features wanting future visibility produce derived/projected, non-editable data — never real records ahead of time.

### P13 — Date-only values never gain an implicit time
- **#298 (critical):** date-only dates were scheduled as *midnight alarms*, waking users at night; revoking notification permission didn't clear already-scheduled alarms, so they kept firing with no visible UI.
- **#205:** typed years coerced into 19xx; partial date segments jumped eras.

**Guardrails:** a date-only field schedules nothing unless the user sets a time. Permission revocation cancels everything already scheduled. Alarm/notification scheduling is idempotent and silent on re-registration (#418's "already set this alarm" toast storm).

---

## 6. Settings and non-task state

### P14 — Classify every setting: synced / device-local / UI-session — and defaults never win merges
- **#120:** sync reset settings to defaults (remote default clobbered local explicit value).
- **#62:** settings lost across an app upgrade.
- **#316:** the *UI area filter* lived where a sync refresh could overwrite it.
- **#488:** changing density reset text size (one setting's writer clobbering siblings).

**Guardrails:** new settings declare their class at birth. UI-session state (current filter, selected view) never lives in the synced settings document. Settings merge field-by-field; an explicit value always beats a default. Settings writes go through one updater that can't drop sibling keys.

---

## 7. Release engineering and platform sandboxes

### P15 — Every distribution channel is a different runtime; validate the channel artifact, not the codebase
- **#715/#674/#723:** v0.9.9 FOSS APK crashed on launch for every F-Droid/Obtainium user (module-interop failure only in the FOSS dependency set). The regular APK was fine — testing one channel proved nothing about the other.
- **#583 (P0):** Flatpak failed to launch — appindicator shared library missing only in the Flatpak runtime.
- **#234:** AUR broke repeatedly (CI-injected tauri config, bun `overrides` quirks, then flaky tests in `check()`); resolution was a **release-pipeline gate building the AUR package in a clean Arch container** — the model for channel gates.
- **#539:** F-Droid JVM-target patcher missed local Android modules.
- **#209:** Windows Store crash: tray/global-shortcut init was fatal in the MSIX sandbox; a registered-shortcut *conflict* could also kill startup.
- **#198:** Hermes crash — `setTimeout` referenced at module scope before timer globals existed.

**Guardrails:**
- Startup never hard-depends on optional capabilities (tray, global shortcuts, keyring, notifications, timers-at-module-scope). Detect → degrade → log; never exit.
- Each channel (FOSS APK, Play, F-Droid, Flatpak, AUR, MSIX/Store, winget, homebrew, App Store, TestFlight) gets a smoke launch of *its* artifact before publishing, in as channel-faithful an environment as CI allows.
- Channel-specific dependency sets (FOSS vs. non-FOSS, Flatpak lockfiles) are treated as separate build targets with their own CI.

### P16 — A tagged release is immutable
- **#682/#674:** after fixing the FOSS crash, the patched APK — built from a *later commit* — was uploaded onto the existing v0.9.9 release. IzzyOnDroid's reproducible-build check failed; the asset had to be withdrawn and the release marked superseded.

**Guardrails:** fix → new tag → new release (e.g., v0.9.9.1), never artifact replacement. Keep build steps in versioned repo scripts (not inline workflow YAML) so downstream reproducible builders track changes automatically.

### P17 — Sandboxes deny what you assume exists; never persist a config that hasn't succeeded once
- **#335:** Flatpak had no keyring/DBus → secure storage failed; fix added local-secrets fallback. A Tauri plugin ACL/lockfile drift broke HTTP in the same report.
- **#343:** iOS folder permission evaporated on restart → security-scoped bookmarks required.
- **#617:** Homebrew builds lacked CloudKit entitlements; the release workflow now *verifies entitlements in the signed artifact*.
- **#338:** CloudKit schema deployed to Development but not Production — all App Store users broken. Plus: the chosen backend was persisted to config *before* the first successful sync, leaving a crash loop. Fix: stage the backend until first success.
- **#727:** adding the People entity missed a CloudKit queryable index → sync broken after an iCloud data reset.

**Guardrails:**
- Capability matrix per platform/channel: keyring, filesystem persistence, network transport, push, CloudKit — each with detection and a fallback.
- Sync-backend configuration commits only after one successful round-trip.
- Server-side schema (CloudKit record types, indexes, production deployment; cloud-server validation) is part of the entity checklist and the release checklist.

### P18 — "Add an entity type" is a checklist, not a type definition
Derived from #727 (missing CloudKit index for People), #718-fix-6 (People not persisted in desktop SQLite → permanent dirty-loop), #322 (SQLite save order violating FK ordering erased data on FOSS Android restart), and the cloud `POST /v1/tasks` rev-stamping gap.

New entity (or new field) must touch: core type + factory stamping; normalization/signature allowlist; SQLite schema **and FK-safe save order**; data.json export; sync merge + tombstones; CloudKit record type + indexes + production deploy; cloud server validation/stamping; both apps' stores; i18n labels; tests for round-trip and merge convergence.

---

## 8. Performance at scale

### P19 — Interaction cost is O(visible), not O(store); enforced by synthetic large-store budgets
- **#594 (discussion) + #643–#649, #195, #224:** a normal-sized user DB (186 kB JSON!) made every tap freeze for up to a second. Causes found: every project row scanning the full task list; editor open rescanning all tasks repeatedly; full-snapshot persistence on each mutation; broad store subscriptions waking whole screens on unrelated changes; SAF directory re-listed per attachment; attachment sync phases entered with zero pending work; non-idempotent tap handlers piling up (15 blank checklist items from queued taps).

**Guardrails:**
- New list views ship virtualized with narrow selectors; no full-array `useTaskStore()` subscriptions in screens.
- Mutation persistence is incremental; full-snapshot saves are for lifecycle/sync boundaries only.
- Every periodic/sync phase has a no-work early exit.
- Tap handlers are idempotent (queued duplicate taps are harmless).
- The large-store perf suite (`bun run test:perf`, budgets in `docs/performance-budgets.md`) gains a case whenever a new hot path ships.

---

## 9. UI, i18n, parity

### P20 — No hard-coded user-facing strings; keys land in all locales with the feature
Eleven separate issues (#244, #245, #246, #256, #257, #261, #287, #292, #215, #23, #593) were "hard-coded English string" or "missing key" — each trivially preventable at review time. Date/weekday formatting goes through locale-aware APIs (#375, #287).

### P21 — Desktop/mobile parity is part of the feature, not a follow-up
- **#237** (same task visible on mobile, invisible on desktop), **#99**, **#149**, **#559**, **#314**: parity gaps surfaced as bugs, repeatedly.

**Guardrail:** any change to task semantics/visibility lands in core and is consumed by both apps in the same release, or the divergence is explicitly documented as intended (like #725's deliberate mobile-keeps-lifecycle-sync decision).

---

## 10. Recovery, diagnostics, and the fix workflow

### P22 — Recovery must defeat the failure it exists for
- **#236:** "max 5 snapshots" all came from the same 4 minutes — useless for any real incident. Fix: spread retention across the window + skip snapshots when data unchanged.
- **#609:** restored backups were re-deleted by the same sync bug that destroyed the data, until restore learned to re-author records.

**Guardrail:** test restore paths against the actual loss scenarios (cascade delete + tombstone, corrupted remote, bad merge), not just "file exists".

### P23 — Make invisible decisions diagnosable before patching plausible causes
- **#698** was solvable in one pass *because* diagnostics exposed `diffKeys` per conflict.
- **#718** burned three speculative fixes before added diagnostics revealed the real two causes (people backfill + `-shm` noise).
- **#316**'s final action was adding merge-resolution diagnostics (winner side, revs, timestamps) rather than another guess.

**Guardrails:** merge/conflict paths log reason + sample field keys (redacted); loop-class bugs get trigger-source diagnostics *first*, then a fix. For semantic bugs (recurrence, date logic), enumerate the input matrix as tests before fixing — the #187/#717 and #557 sagas were repeated single-case patches against a multi-dimensional input space.

### P24 — Reproduce-confirm loop
What demonstrably worked in this history and should stay: severity/priority labels with `status:needs-confirmation`; fixes posted with full commit hashes; asking reporters for structured environment + logs (install channel matters — #322 was FOSS-build-only, #617 homebrew-only); withdrawing bad artifacts fast and saying so plainly (#674/#682).

---

## Quick checklist for new features

Before implementing, answer:

1. **Writers:** who else writes this data (sync, MCP, CLI, other device, older app version)? What guards ordering? (P1, P9)
2. **Convergence:** after my change syncs once, does a second sync produce zero diffs — including against a device running the previous version? (P4)
3. **Triggers:** does my code write anything that a watcher/trigger can see? Is it marked self-written? Does every loop terminate? (P5)
4. **Mid-edit:** what happens if the user is editing while this runs? (P6)
5. **Entities/fields:** did I walk the entity checklist (SQLite + FK order, signatures, CloudKit + indexes + prod deploy, cloud validation, factories)? (P18)
6. **Dates:** status-first? date-only stays date-only? core predicate shared by both apps? recurrence matrix covered? (P10–P13)
7. **Settings:** synced, device-local, or session? Can a default ever beat an explicit value? (P14)
8. **Channels:** does this touch startup, native capabilities, or dependencies? Which channels need a smoke test? (P15–P17)
9. **Scale:** what's the cost at 5k tasks? Is there a no-work early exit? (P19)
10. **Failure:** is every retry bounded, every 404 terminal, every restore re-authored? (P8, P22)
