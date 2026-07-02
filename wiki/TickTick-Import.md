# TickTick Import

Mindwtr can import TickTick backups so you can migrate without rebuilding your system by hand.

Supported sources:

- a TickTick **CSV** backup
- a TickTick **ZIP** backup containing the CSV export

Import is available on desktop and mobile from **Settings -> Data -> Import from TickTick**.

## Export From TickTick

TickTick creates backups from the web app:

1. Open TickTick in a browser and sign in.
2. Click your avatar in the top-left corner.
3. Open **Settings -> Account -> Backup & Import**.
4. Choose **Generate Backup**.
5. Save the CSV or ZIP file that TickTick downloads.

Then open **Import from TickTick** in Mindwtr and choose that file.

## What Gets Imported

Mindwtr maps TickTick backups into Mindwtr's model with a GTD-first bias:

- TickTick folders become **Mindwtr areas**
- TickTick lists become **Mindwtr projects**
- parent tasks and child rows can become **checklist tasks**
- checklist content is preserved as checklist items
- TickTick tags become **Mindwtr tags**
- priorities are mapped when present
- due dates, start dates, all-day dates, and time zones are preserved when they can be read safely
- supported repeat rules are imported as Mindwtr recurrence
- completed and archived status is preserved when present
- task notes/content are preserved in the description

Imported active tasks stay available for GTD processing instead of being forced into a status Mindwtr cannot infer from the backup.

## Import Flow

1. Open **Import from TickTick**
2. Choose a TickTick CSV or ZIP backup
3. Review the preview summary
4. Confirm the import

Before import, Mindwtr saves a recovery snapshot of your current local data when supported.

After import:

- new areas and projects are created as needed
- tasks, checklists, tags, dates, and recurrence are added from the backup
- warnings are shown for skipped rows, unsupported archive entries, or fields Mindwtr could not map safely

## Notes on TickTick Backups

TickTick backups include metadata rows before the actual CSV header. Mindwtr detects the real header automatically, so you should not need to edit the file first.

Mindwtr skips:

- nested ZIP files
- non-CSV files inside the archive
- malformed rows it cannot parse safely

TickTick backups do not provide every piece of app state. Attachments and some app-specific presentation details may need to be moved manually.

## Tips

- Keep the original TickTick backup until you verify the import
- Start with the full backup, but use the preview to check whether the mapping looks right
- If you import the same backup twice, you may duplicate tasks
- Use [[Importing Data From Other Apps]] if you need a fallback path for another app

See also [[Data and Sync]] and [[Backup and Restore]].
