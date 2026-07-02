# Mindwtr Unreleased

Changes collected after `v1.0.5` and before the next version tag.

## Highlights

- Permanently delete projects from Trash while keeping sync tombstones stable across desktop, CloudKit, and other synced devices.
- Capture tasks faster with `/energy:` quick-add syntax, default schedule times, clearer creation affordances, and restored desktop quick-add focus.
- Use refreshed AI providers with stricter structured outputs, bounded retries, and updated default models.
- Work more predictably with board cross-column drops, filter visibility cleanup, mobile capture-area modes, and focused list polish.

## Full Change List

- feat(review): surface stale tasks and projects as a Weekly Review step without requiring AI, and add a "Review in 1 week" action beside "Mark reviewed".
- feat(tasks): render Markdown consistently in description displays — desktop rows show a rendered first-line preview, and mobile Trash/Archived previews no longer show raw Markdown source.
- fix(mobile): keep the task description field visible when the Android keyboard opens.
- fix(mobile): keep full task titles visible in inbox and task lists after editing.
- fix(desktop): preserve relative start offsets and repeat reminder minutes through desktop SQLite restarts and sync cycles.
- fix(cloudkit): sync project archive restore metadata for tasks and sections across Apple CloudKit clients.
- fix(mobile): apply SQLite WAL/foreign-key/busy-timeout pragmas outside legacy transactions and reject stale JSON backup fallbacks after stalled writes.
- fix(recurrence): stamp recurring follow-up tasks with revision metadata and preserve task text direction.
- fix(sync): build task content signatures from an explicit allowlist and drop unknown legacy fields during sync normalization.
- fix(cloud): accept energy level, assignee, and reminder suppression fields through task REST create/patch calls.
- fix(mcp): remove unused raw-SQL task write helpers so MCP writes stay on the core-backed service path.
- fix(mobile): narrow mounted screen store subscriptions and align inline capture with Inbox-first capture.
- ci(android): publish profileable builds to Google Play internal testing while keeping production/beta on the normal release build.
- fix(desktop): preserve purged project tombstones across SQLite save/load cycles.
- fix(cloudkit): sync purged project tombstones on Apple devices.
- fix(trash): show deleted projects in Trash and support deleting them forever.
- fix(desktop): snap board drops to the nearest card for consistent cross-column moves.
- feat(quick-add): parse `/energy:` values and apply default schedule times.
- feat(tasks): improve add controls, entity creation affordances, list grouping, and quick-add focus handling.
- fix(desktop): restore focus to quick-add after adding a task.
- fix(desktop): keep inline capture limited to Inbox.
- fix(desktop): use the Windows native certificate trust path for WebDAV sync.
- fix(filters): hide unused metadata filters and keep hidden criteria from affecting visible task lists.
- fix(mobile): expose priority in the task editor default view and show status chips on review-due focus rows.
- fix(mobile): add active-area capture mode copy, split context/tag filters, show filter-only search results, and reduce project swipe sensitivity.
- feat(donations): refine in-app donation prompts and routing.
- feat(ai): modernize OpenAI, Anthropic, and Gemini provider handling with stricter structured output parsing and bounded retries.
- fix(mobile): tolerate missing RNFS, avoid native module crashes, and improve SQLite read/write diagnostics.
- fix(release): check out requested tags in platform workflows and fail closed on untracked Android versionCode overrides.
- fix(i18n): localize new active-area and desktop search-scope strings.
