# Apple Shortcuts

Mindwtr supports Apple Shortcuts through native App Intents on iPhone and iPad. The first version focuses on the GTD capture loop: get open loops into Mindwtr quickly, then review and process them inside the app.

This is intentionally smaller than Things' mature Shortcuts system. Things exposes create, find, edit, show, and custom item/list actions. Mindwtr v1 starts with capture and navigation so it stays reliable and does not bypass Mindwtr's normal task creation, revision, and sync paths.

## Availability

Apple Shortcuts support is available in iOS builds that include the Mindwtr App Intents integration.

Supported surfaces:

| Surface | Supported |
| --- | --- |
| Shortcuts app | Yes |
| Siri | Yes |
| Spotlight / suggested shortcuts | Yes |
| Action Button running a shortcut | Yes |
| Apple Watch direct actions | No, not in v1 |
| CarPlay | No, not in v1 |

## Actions

### Capture to Mindwtr

Use **Capture to Mindwtr** to send a task into Mindwtr's Inbox capture confirmation flow.

Parameters:

| Parameter | Required | Notes |
| --- | --- | --- |
| Task | Yes | The task title. Empty titles are rejected. |
| Note | No | Added as the task description. |
| Tags | No | Comma-separated tags. Mindwtr normalizes them to `#tag` when saving. |
| Project | No | Matches an active project by title, or creates the project when the capture is saved. |

What happens when it runs:

1. Shortcuts opens Mindwtr.
2. Mindwtr shows the capture screen with the title and optional metadata filled in.
3. You review the capture and save it through the normal Mindwtr flow.

The task is not written directly from Swift. This keeps task creation inside Mindwtr's existing store, SQLite, revision, and sync logic.

### Open Mindwtr List

Use **Open Mindwtr List** to jump to a GTD view.

Supported destinations:

| List | Opens |
| --- | --- |
| Inbox | Inbox |
| Focus | Focus / Next Actions |
| Waiting | Waiting For |
| Someday | Someday/Maybe |
| Projects | Projects |
| Review | Review |
| Calendar | Calendar |

The shortcut defaults to Inbox if no list is configured.

## Example shortcuts

### Capture from voice

1. Open Apple's **Shortcuts** app.
2. Create a new shortcut.
3. Add **Dictate Text** or **Ask for Input**.
4. Add Mindwtr's **Capture to Mindwtr** action.
5. Pass the dictated text into **Task**.
6. Optionally set **Tags** to something like `phone,errands`.

This is useful for quick capture while walking, commuting, or moving between apps. Siri voice recognition can still miss words in some environments, so review the capture before saving.

### Open Focus from the Action Button

1. Create a shortcut using **Open Mindwtr List**.
2. Set **List** to **Focus**.
3. In iOS Settings, assign that shortcut to the Action Button.

## URL scheme fallback

Mindwtr also supports URL-scheme automation. Use this when another automation tool cannot see native App Intents.

| URL | Action |
| --- | --- |
| `mindwtr://capture?title=Buy%20groceries` | Open capture with a title |
| `mindwtr://capture?title=Buy%20groceries&note=From%20store` | Open capture with title and note |
| `mindwtr://capture?title=Buy%20groceries&project=Shopping&tags=errands,home` | Open capture with project and tags |
| `mindwtr://open-feature?feature=focus` | Open Focus |
| `mindwtr://open-feature?feature=review` | Open Review |

Supported capture aliases:

| Field | Aliases |
| --- | --- |
| Title | `title`, `text`, `name`, `thingName`, `itemListElementName`, `itemListName` |
| Note | `note`, `description`, `body`, `thingDescription`, `itemListDescription` |

## v1 limits

Mindwtr v1 does not include:

- Background task creation without opening Mindwtr.
- Custom AppEntity task or list types.
- Find, edit, duplicate, delete, or batch actions.
- Direct recurring-task, reminder, or date scheduling from Shortcuts.
- Apple Watch or CarPlay support.

These are good future candidates, but they need careful design because edits and background writes must preserve Mindwtr's local-first sync and GTD workflow rules.

## Related links

- [[User Guide Mobile]]
- [[GTD Workflow in Mindwtr]]
- [[Data and Sync]]
- [Things: Using Apple Shortcuts](https://culturedcode.com/things/support/articles/2955145/)
- [Things: Shortcuts Actions](https://culturedcode.com/things/support/articles/9596775/)
- [Apple: App Intents overview](https://developer.apple.com/videos/play/wwdc2024/10210/)
