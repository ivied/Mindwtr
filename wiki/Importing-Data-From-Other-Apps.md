# Importing Data From Other Apps

This guide covers moving tasks into Mindwtr from another task manager. It is for full migrations, not for quick one-off captures.

## Before You Import

A migration is a good moment to leave old clutter behind. If your previous app has hundreds of stale tasks, consider moving only your current projects, active next actions, and trusted reference items.

Mindwtr can import full exports from supported apps, but a smaller, deliberate migration usually fits GTD better than copying every old task into a new system.

## Available Importers

Mindwtr has first-class importers for a small set of apps where the export format is structured enough to map safely:

- [[TickTick Import]] - CSV or ZIP backups from TickTick
- [[Todoist Import]] - CSV exports or ZIP backups
- [[DGT GTD Import]] - JSON exports or ZIP backups
- [[OmniFocus Import]] - CSV, JSON, or ZIP exports
- Apple Reminders import - iOS-only import for incomplete reminders from a selected Reminders list

Open **Settings -> Data** and choose the matching import action. Mindwtr shows a preview before it adds anything.

Native importers are the best path when your old app is listed. They preserve more structure than plain text, and they handle app-specific details such as folders, lists, tags, dates, checklists, and recurrence when the source export exposes them.

## Alternative Migration Methods

If your app is not listed, use one of the fallback paths below. These are intentionally simpler than native importers and are useful for the long tail of apps that export plain text, CSV, or JSON.

### Copy & Paste

The fastest fallback is to copy a list of tasks and paste it into Quick Add / Quick Capture.

Desktop:

1. Open Quick Add.
2. Paste multiple lines into the task field.
3. Confirm **Create tasks**.

Mobile:

1. Open Quick Capture.
2. Paste multiple lines into the task field.
3. Tap Save and confirm the bulk create prompt.

Each nonblank line becomes one task. Each line is parsed with Mindwtr quick-add syntax, so you can include metadata inline:

```text
Email Bob about Q3 report +Work @computer #followup /due:friday
Book dentist appointment @phone
Outline conference talk +Speaking #ideas /note:Draft the rough structure first
```

This does not reconstruct deep hierarchy or recurrence, but it is often the cleanest way to bring over the tasks that still matter.

### Plain Text

If your old app can export a `.txt` file, use Mindwtr's text import from the capture UI.

Desktop:

1. Open Quick Add.
2. Click **Import .txt**.
3. Choose a plain text file.
4. Confirm the bulk create prompt.

Mobile:

1. Open Quick Capture.
2. Tap **More**.
3. Tap **Import .txt**.
4. Choose a plain text file.
5. Confirm the bulk create prompt.

Use one task per line. Add quick-add tokens on the same line when you want Mindwtr to set metadata during import:

```text
Pay water bill +Home /due:2026-07-01
Renew passport +Personal @errands #admin
Send slides to Ana +Work /note:Use the final deck from the shared folder
```

Mindwtr uses explicit quick-add commands such as `/note:` instead of a hidden tab-note format. This makes the text file readable before import and uses the same parser as normal capture.

### CSV to Quick-Add Text Script

For apps that export CSV but do not have a native Mindwtr importer, convert the CSV into a plain text quick-add file, then import that `.txt` file.

Mindwtr includes a small dependency-free helper script:

```bash
node scripts/migration/csv-to-quickadd-text.mjs export.csv \
  --output mindwtr-import.txt \
  --title "Title" \
  --project "Project" \
  --tags "Tags" \
  --contexts "Contexts" \
  --due "Due" \
  --note "Note"
```

The script writes one quick-add line per CSV row. It can map:

- a title column into the task title
- a project/list column into `+Project`
- comma- or semicolon-separated tags into `#tag`
- comma- or semicolon-separated contexts into `@context`
- a due-date column into `/due:...`
- a note column into `/note:...`

If your CSV uses different column names, pass those names with the options above. For example:

```bash
node scripts/migration/csv-to-quickadd-text.mjs tasks.csv \
  --output mindwtr-import.txt \
  --title "Task" \
  --project "List" \
  --tags "Categories" \
  --due "Due Date" \
  --note "Notes"
```

This script is a starting point, not a supported app-specific importer. It will not preserve nested tasks, attachments, recurrence, or app-specific fields unless you adapt it.

### CLI, Local API, and MCP

Technical users can write their own importer against Mindwtr's automation surfaces:

- [[Local API]]
- [[MCP Server]]
- `bun run mindwtr:cli -- --help` from the repository checkout

Use this path when your old app exports structured JSON or CSV and you want more control than plain text gives. These tools go through Mindwtr's normal data model, but custom migration scripts are self-serve.

## If Your App Is Not Listed

Use this order:

1. Check whether your app can export to a format Mindwtr already imports.
2. Try copy/paste or plain text for the active tasks you still need.
3. Use the CSV helper script if your app exports a simple spreadsheet.
4. Use the Local API, CLI, or MCP if you need a custom structured migration.

If you want a native importer for a specific app, open a GitHub Discussion or issue with:

- the app name
- the export format it provides
- a small redacted sample export
- which fields matter most to preserve

Native importers are prioritized by demand and by how clearly the source format maps to Mindwtr's GTD model.
