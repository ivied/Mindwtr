# Performance Guide

This page documents practical performance patterns for Mindwtr (desktop, mobile, and core).

## High-Impact Areas

- Large list filtering and sorting
- Project/task ordering updates
- Sync merge and attachment reconciliation
- Re-render churn from broad store subscriptions
- SQLite query patterns (search, date filters, project/status views)

## UI Rendering Guidance

1. Prefer narrow store selectors and avoid selecting whole store objects.
2. Group related selectors and memoize derived collections.
3. Keep item components pure; push expensive transforms up to list-level memoization.
4. Use virtualization for large lists and avoid dynamic height recalculation in hot paths.
5. Avoid creating new inline callbacks/objects in large mapped lists.

Current desktop list rows rely on memoized `TaskItem` rendering, so keep task row props stable when changing list, project, agenda, calendar, or review views. If a view needs extra per-row metadata, derive it once at the list level instead of building new objects inside every row render.

### Rendering Optimization Playbook

When a screen feels slow, use this order:

1. Verify list item render count first (React DevTools profiler).
2. Hoist static constants/styles out of render functions.
3. Memoize heavy child components (`React.memo`) with explicit prop equality where needed.
4. Split large components by concern (header/form/list/modals) so state updates stay localized.
5. Replace broad dependency arrays with smaller memoized selectors/helpers.

### Desktop Project List Virtualization
- Use `@tanstack/react-virtual` for large desktop task lists that share the main workspace scroll container.
- Keep row keys task-ID based; never use indexes for task rows that can be edited, selected, moved, or reordered.
- Measure virtual rows when task card height can change, and keep a conservative row estimate so scrolling does not jump.
- Preserve drag/reorder semantics by virtualizing the existing sortable row component rather than swapping in a separate row UI.
- Avoid nested scroll containers inside project sections. If a virtual list is below project metadata or a section header, account for the list offset with scroll margin.
- Add bounded render-count tests for large-list regressions. A test should prove the mounted row count stays near the visible window plus overscan, not the full task count.

### FlatList / Virtualization Tuning (Mobile)

- Set `initialNumToRender`, `maxToRenderPerBatch`, `windowSize` intentionally by screen.
- Provide `getItemLayout` where practical (fixed or measured fallback).
- Enable `removeClippedSubviews` for larger lists.
- Keep `keyExtractor` stable and avoid index keys.
- Avoid inline anonymous renderers in deeply nested item trees.

Keep normal task screens on `FlatList`. For task lists embedded inside an existing `ScrollView`, use a manual visible-window slice with spacer rows rather than nesting another vertical virtualized list, so swipe, pull, keyboard, and drag gestures keep a single scroll owner.
Calendar-specific rule: virtualize unbounded result sets, not fixed calendar scaffolding. The mobile Schedule view can grow with every visible task/event and should stay on `FlatList`; day and week timelines are bounded by the visible hour grid, and month cells are bounded by calendar weeks, so `ScrollView` is acceptable there as long as task/event rows are pre-filtered outside the render loop.

## Sync Performance Guidance

1. Validate payload shape before merge to fail fast.
2. Keep merge deterministic and O(n) over entity count (map by ID, avoid nested scans).
3. Reconcile attachment metadata first; defer file IO/network to separate sync phase.
4. Bound retries with backoff and classify retryable vs terminal errors.
5. Cache backend config reads during a sync cycle to reduce repeated storage access.

The sync engine maintains indexed conflict/revision lookups during merge. When adding new synced entity types or conflict reporting, preserve that indexed shape rather than reintroducing per-entity scans across full collections.

### Sync Tuning Tips

1. Keep attachment upload/download concurrency conservative on mobile networks.
2. Tune timeout and retry windows separately for metadata vs attachments.
3. Abort quickly on offline transitions; avoid long retry chains after connectivity loss.
4. Use progress instrumentation for long-running attachment phases.
5. Track conflict count, max clock skew, and timestamp adjustments per sync run.
6. Treat sync-conflict samples as bounded diagnostics. Keep sample count and diff-key limits small so conflict reporting does not dominate large merges.

### Sync Debug Checklist

If sync latency regresses:

1. Compare local read, merge, remote write, and attachment phases separately.
2. Verify rate-limit responses (`429`) are not causing cascaded retries.
3. Check attachment hash validation/retries for repeated failures.
4. Confirm remote payload size and collection counts are within configured limits.
5. Capture log samples with timestamps and request IDs around slow windows.

## Release-Mode Critical Journey Profiling

Profile real release/profile builds before broad performance changes. Development builds and test runners are useful for guards, but they can hide the actual dominant layer: data derivation, React render/commit, virtualization, persistence, or native/UI-thread work.

### Critical Journey Budgets

Use these as triage budgets, not hard product guarantees. Record p50 and p95 when possible, and keep the data shape next to every result.

| Journey | Android release budget | Desktop release budget | Primary signal |
| --- | ---: | ---: | --- |
| Quick capture opens and accepts first keystroke | <= 500 ms open, <= 100 ms input latency | <= 300 ms open, <= 100 ms input latency | Time from command/tap to editable input and first accepted character |
| Task complete/toggle | <= 150 ms visual response, <= 500 ms save queued | <= 100 ms visual response, <= 300 ms save queued | Input-to-visual update plus persistence phase |
| Task edit open/save/close | <= 300 ms open, <= 300 ms save/close | <= 200 ms open, <= 200 ms save/close | Modal/sheet commit time and save flush |
| Project opens with 100+ tasks | <= 2,000 ms | <= 1,000 ms | Navigation to interactive task list |
| Picker opens/dismisses while Focus/Inbox/Projects is mounted | <= 200 ms | <= 150 ms | Picker transition and parent view recomputation |
| Focus, Inbox, and Projects view switch | <= 500 ms | <= 300 ms | Route/view switch to interactive state |
| Search-as-you-type | <= 150 ms p95 per keystroke | <= 100 ms p95 per keystroke | Keystroke to updated visible results |

### Capture Matrix

Keep captures attached to the issue or follow-up issue. Each capture should name the commit, app version, install channel, device, OS, data shape, journey, and artifact link.

| Platform | Required build | Tooling | Capture artifact | Dominant layer to record |
| --- | --- | --- | --- | --- |
| Android | Release or profile APK/AAB with representative local data | Android Studio profiler, Hermes sampling, or Flipper where available | CPU trace or Hermes profile plus screen recording/timestamps | JavaScript derivation, React render/commit, list virtualization, SQLite/persistence, native/UI thread |
| Desktop | Tauri release build with representative local data | WebView DevTools Performance profiler and app diagnostics log | Performance trace plus diagnostics timestamps | Data derivation, React render/commit, web virtualization, SQLite/persistence, WebView/native shell |

### Capture Notes Template

```markdown
Commit:
Version/channel:
Platform/device/OS:
Dataset:
- tasks:
- projects:
- largest project task count:
- contexts/tags:
Journey:
Tool/artifact:
Observed p50/p95:
Dominant layer:
Notes:
Follow-up issue:
```

### Layer Classification

- Data derivation: profile shows repeated full-store scans, sorting/filtering, count aggregation, or selector churn before render starts. Prefer query-scoped selectors and derived indexes. Track in #647.
- React render/commit: profile shows large commit time, repeated row renders, unstable props, or broad subscriptions. Memoize rows and narrow subscriptions before changing data models.
- Virtualization: profile shows thousands of row components mounted for a visible list. Use platform virtualizers and bounded render-count tests. Track in #648.
- Persistence: UI stalls align with save flushes, SQLite work, import/export, sync writes, or JSON serialization. Split urgent visual updates from storage work.
- Native/UI thread: Android trace or desktop WebView trace shows animation/layout/input stalls outside JavaScript. Reduce layout churn, nested scrolling, or native bridge traffic.

For the project-open slowdown reported in #643, collect Android and desktop captures first. If derivation dominates, use #647. If mounted row count dominates, use #648. If persistence or native/UI-thread stalls dominate, open a smaller follow-up with the capture artifact and exact journey.

## Database Guidance

1. Use FTS indexes for free-text search where available.
2. Keep common status/project/date filters indexed.
3. Batch writes inside transactions for large imports/sync save paths.
4. Keep JSON columns normalized at read boundaries and avoid repeated parse/stringify loops.

## Profiling Checklist

1. Reproduce with a realistic dataset (thousands of tasks, large projects).
2. Measure before/after (render counts, query timings, sync duration).
3. Check memory growth during long sessions.
4. Verify no regressions in low-end devices/simulators.

## Performance Budget Suggestions

- List interactions should remain responsive (<16ms frame budget where feasible).
- Search requests should be sub-100ms on typical local datasets.
- Sync merge should scale linearly with entity count.
- Avoid blocking UI threads with file/network operations.

## Continuous Performance Hygiene

1. Add targeted tests when fixing regressions (render churn, merge complexity, retry behavior).
2. Keep budget checks in CI for critical views and sync paths.
3. Prefer small measurable improvements over broad speculative refactors.
4. Re-profile after each optimization to verify real impact.

## Related docs

- [[Architecture]]
- [[Core API]]
- [[Data and Sync]]
- [[Diagnostics and Logs]]
