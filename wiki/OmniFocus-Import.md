# OmniFocus Import

Mindwtr can import OmniFocus CSV exports so you can migrate without rebuilding your system by hand.

## Supported Source Files

- an OmniFocus **CSV** export
- an OmniFocus **CSV UTF-16** export

Import is available on desktop and mobile from **Settings → Data → Import from OmniFocus**.

## How Mindwtr Maps OmniFocus Data

Mindwtr maps OmniFocus CSV exports into Mindwtr’s model with a GTD-first bias:

- OmniFocus projects become **Mindwtr projects** when the CSV references them
- OmniFocus standalone actions stay outside projects so you can process them later
- OmniFocus tags become **Mindwtr tags**
- OmniFocus contexts become **Mindwtr contexts**
- OmniFocus notes are preserved in the imported description
- Supported start dates, due dates, and completion state are preserved

Mindwtr does not currently have a separate OmniFocus-style planned date field. When OmniFocus includes a planned date or duration text, Mindwtr keeps that information in the imported description instead of dropping it.

## Supported OmniFocus Data

- project names
- action titles
- notes
- tags
- contexts
- start dates
- due dates
- completion status and completion date when available
- flagged state as a high-priority hint

## Import Steps

1. Open **Import from OmniFocus**
2. Choose an OmniFocus CSV file
3. Review the preview summary
4. Confirm the import

Mindwtr saves a recovery snapshot before importing so you can roll back if needed.

## Current Limits

- OmniFocus native `.ofocus` databases are not imported directly
- HTML and plain-text exports are not imported
- Planned dates and duration values are preserved as description text rather than mapped to dedicated fields
- CSV structure that depends on OmniFocus-only hierarchy beyond project membership is flattened to Mindwtr tasks

## Tips

- Start with a smaller OmniFocus export if you want to validate the mapping first
- If you have both project actions and standalone inbox actions, Mindwtr preserves that split
- Review imported high-priority tasks if you used OmniFocus flags heavily
