# Database Schema

Mindwtr keeps the local data model intentionally small and sync-friendly. The desktop app uses SQLite as the primary store, and mobile uses the same core schema where SQLite is available.

The source of truth for the SQLite schema lives in:

- `packages/core/src/sqlite-schema.ts`
- `packages/core/src/sqlite-adapter.ts`

This page is a practical map of that schema for contributors.

---

## Core Tables

### `tasks`

Primary task records, including GTD status, scheduling fields, checklist data, attachments, ordering, and sync metadata.

Notable columns:

- `status`: GTD lane (`inbox`, `next`, `waiting`, `someday`, `reference`, `done`, `archived`)
- `projectId`, `sectionId`, `areaId`: parent relationships
- `dueDate`, `startTime`, `reviewAt`, `completedAt`: time-based workflow fields
- `checklist`, `attachments`, `tags`, `contexts`, `recurrence`: JSON-backed fields
- `deletedAt`, `purgedAt`: tombstone fields used by sync
- `rev`, `revBy`, `updatedAt`: merge/conflict metadata

### `projects`

Project containers and their planning metadata.

Notable columns:

- `status`: `active`, `someday`, `waiting`, `archived`
- `areaId`: optional parent area
- `orderNum`: project ordering within an area
- `tagIds`, `attachments`: JSON-backed fields
- `supportNotes`, `reviewAt`: planning/review fields
- `deletedAt`, `rev`, `revBy`, `updatedAt`: sync metadata

### `sections`

Project-local grouping lanes for tasks.

Notable columns:

- `projectId`: owning project
- `orderNum`: section ordering inside the project
- `isCollapsed`: persisted UI state
- `deletedAt`, `rev`, `revBy`, `updatedAt`: sync metadata

### `areas`

Higher-level GTD areas of focus.

Notable columns:

- `name`, `color`, `icon`
- `orderNum`: manual ordering
- `deletedAt`, `rev`, `revBy`, `updatedAt`: sync metadata

### `settings`

Single-row JSON store for app settings.

- `id = 1`
- `data`: serialized settings object

### `saved_filters`

Saved Focus filter definitions used by the Focus view.

Notable columns:

- `name`, `icon`, `view`: display metadata
- `criteria`: serialized filter criteria
- `sortBy`, `sortOrder`: optional saved ordering
- `createdAt`, `updatedAt`: local metadata

### `calendar_sync`

Device-calendar push-sync mapping table.

Notable columns:

- `task_id`: Mindwtr task ID
- `calendar_event_id`, `calendar_id`: native calendar identifiers
- `platform`: platform namespace for the mapping
- `last_synced_at`: last successful push timestamp

### `schema_migrations`

Tracks applied schema versions for additive migrations.

---

## Full-Text Search Tables

SQLite FTS5 powers desktop/mobile local search.

### `tasks_fts`

Indexed task search fields:

- `title`
- `description`
- `tags`
- `contexts`

### `projects_fts`

Indexed project search fields:

- `title`
- `supportNotes`
- `tagIds`
- `areaTitle`

FTS tables are maintained by triggers in `packages/core/src/sqlite-schema.ts`.

---

## Indexes

The schema includes targeted indexes for the common UI and sync paths:

- task status and deletion filters
- task date queries (`dueDate`, `startTime`, `reviewAt`, `completedAt`)
- task grouping queries (`projectId`, `areaId`, `sectionId`)
- project status and area ordering queries

The current index definitions live in `SQLITE_INDEX_SCHEMA` inside `packages/core/src/sqlite-schema.ts`.

---

## Validation Rules

SQLite triggers reject invalid enum values and malformed JSON on write.

Current validation checks include:

- valid task/project status values
- JSON validity for task tags, contexts, checklist, attachments, recurrence
- JSON validity for project tag IDs and attachments

This keeps the on-disk database aligned with the TypeScript model and prevents partial corruption from bypassing the store layer.

---

## Sync Semantics

Mindwtr does **not** rely on cascading relational deletes for core entities. The data model uses soft-delete tombstones so deletions can sync safely across devices.

See also:

- [[Architecture]]
- [[Data and Sync]]
- [[Sync Algorithm]]
- `docs/adr/0001-sqlite-constraints.md`

---

## Contributor Notes

- Prefer additive schema changes over destructive rewrites.
- When adding a field, update both the schema and the adapter mapping logic.
- If a new field affects search, update FTS tables/triggers deliberately.
- When changing constraints or delete behavior, check sync/tombstone implications first.
