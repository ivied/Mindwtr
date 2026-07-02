# FAQ

Frequently asked questions about Mindwtr.

---

## General

### What is Mindwtr?

Mindwtr is a cross-platform Getting Things Done (GTD) productivity app that helps you capture, clarify, organize, and engage with your tasks. Available for desktop (Windows, macOS, Linux) and mobile (Android, iOS).

### Is Mindwtr free?

Yes! Mindwtr is open source and free to use under the AGPL-3.0 license.

### Is Mindwtr AI-generated? What is the project's stance on AI?

Mindwtr is AI-assisted, not AI-generated. That distinction matters.

The architecture, product direction, feature design, and GTD philosophy behind Mindwtr are designed and owned by the maintainer. AI tools help with execution: drafting implementations faster, reducing boilerplate, improving wording, and speeding up bug investigation. Every shipped change is still specified, reviewed, tested, and the maintainer takes responsibility for the result.

AI-assisted development is normal software engineering practice today, including at major technology companies and across open source. AI is a tool, like IDEs, autocomplete, documentation, and Stack Overflow. Using it does not remove the developer's work; it shifts more of the work toward direction, judgment, review, integration, and validation.

Mindwtr is maintained by a solo developer with 10+ years of software engineering experience. That experience is what makes AI useful rather than dangerous: knowing what to build, what not to build, when output is wrong, and how to keep the system coherent. AI helps a project this broad stay maintainable by one person, but it does not decide the design or own the result.

Issue and discussion replies are written by the maintainer. AI may be used to polish English wording, but no agent auto-triages or auto-answers issues.

For contributions, see the [LLM-assisted coding section in CONTRIBUTING.md](https://github.com/dongdongbh/Mindwtr/blob/main/docs/CONTRIBUTING.md#llm-assisted-coding-vibe-coding).

### Why are there so many commits and issue reports?

Mindwtr is a cross-platform end-user app, not a small CLI or library with one narrow command surface. It includes desktop and mobile clients, local-first persistence, sync backends, imports, notifications, quick capture, widgets, translations, installation channels, and GTD workflow decisions. That kind of product creates many small follow-up commits because UI polish, platform differences, packaging fixes, and edge-case reports are part of normal maintenance.

The public issue count is also intentionally broad. GitHub issues include feature requests, UX improvements, platform-specific corner cases, release packaging reports, documentation gaps, and confirmed bugs. Many reports are not blockers for the main capture/organize/review workflow, but they are still tracked publicly so users can see what is known and what changed. Fast follow-up fixes are part of the maintenance model, not a sign that issues are ignored or hidden.

### Is there a roadmap or upcoming features page?

We don’t maintain a fixed roadmap page. The living roadmap is the GitHub Issues list:
https://github.com/dongdongbh/Mindwtr/issues

If you have a feature request, please open an issue and describe the workflow you’re trying to support.

### Where should I report bugs or request features?

Use **Send feedback** from **Settings → About** when it is available in your build. It can send a bug report, feature request, or other note without needing a GitHub account, and the reply email field is optional.

For public tracking, longer discussions, or reports with files/logs, please use GitHub Issues instead of email so reports stay trackable and searchable:
https://github.com/dongdongbh/Mindwtr/issues

If Mindwtr is useful to you, support options are listed here:
https://github.com/dongdongbh/Mindwtr?tab=readme-ov-file#hearts-contributing--support

### Can I open multiple windows?

Not currently. The desktop app is single-window to keep the local-first SQLite data model safe and consistent. Multi-window support is a common request, but not available yet.

### Is there a donation page?

Yes — GitHub Sponsors: https://github.com/sponsors/dongdongbh

### What languages are supported?

Mindwtr currently supports:

- English
- Tiếng Việt
- 中文（简体）
- 中文（繁體）
- Español
- हिन्दी
- العربية
- Deutsch
- Русский
- 日本語
- Français
- Português
- Polski
- 한국어
- Čeština
- Italiano
- Türkçe
- Nederlands

### Where is my data stored?

All data is stored locally on your device:
- **Desktop data (Linux):** `~/.local/share/mindwtr/data.json`
- **Desktop config (Linux):** `~/.config/mindwtr/config.toml`
- **Windows/macOS:** `%APPDATA%/mindwtr/` or `~/Library/Application Support/mindwtr/`
- **Mobile:** Internal app storage

See [[Data and Sync]] for details.

### Is there cloud sync?

Mindwtr supports File Sync, WebDAV, self-hosted Cloud Sync, and Dropbox sync (supported builds). See [[Data and Sync]].

### Does Mindwtr support iCloud sync directly?

Yes, on supported Apple builds.

- **iPhone / iPad:** native **iCloud** backend is available in **Settings → Sync**
- **macOS desktop:** native **iCloud** backend is available in **Settings → Sync**
- **Android / Windows / Linux:** no native iCloud backend

See [[iCloud Sync]] and [[Data and Sync]].

### How do I sync with OneDrive (especially on Android)?

Mindwtr already works with OneDrive **via file sync**:

- **Windows/macOS:** Put your Mindwtr `data.json` inside your OneDrive folder. OneDrive handles the sync automatically.
- **Android:** The official OneDrive app does **not** provide true two‑way folder sync.  
  Use a helper “bridge” app such as **OneSync (Autosync for OneDrive)** or **FolderSync** to keep a local folder synced.  
  Then point Mindwtr to that local folder in **Settings → Sync** (Mindwtr uses `data.json` inside).

This is the same approach used by local‑first apps like Obsidian.

### Why doesn’t Mindwtr have a “Sign in with OneDrive / Google Drive” button?

Mindwtr is local‑first and offline‑first.

Mindwtr now supports native **Dropbox OAuth** sync in supported builds, but does **not** provide native OneDrive/Google Drive OAuth integration.
Expanding to every provider adds significant maintenance and compliance overhead.

For OneDrive/Google Drive, File Sync keeps your data in your control and avoids a large maintenance/security burden.

### Can Mindwtr integrate with email (Gmail/Outlook) or accept forwarded emails?

Not directly. Building a full email client requires:

- OAuth access to Gmail/Outlook (which now requires costly security audits)
- Robust MIME/HTML parsing and attachment handling
- Ongoing maintenance across providers

**Current alternatives:**
- **Desktop:** Paste `message://` or mail links in a task, or drag an email into a task note in clients that support it.
- **Mobile:** Use the share sheet to send selected email content into Mindwtr.

Mindwtr does **not** offer an `add@mindwtr.com` inbox because that would require a central server to receive and store your email.

---

## Features

### What is GTD?

Getting Things Done (GTD) is a productivity methodology created by David Allen. It consists of five steps: Capture, Clarify, Organize, Reflect, and Engage. See [[GTD Overview]].

### How do GTD Horizons map to Mindwtr?

Mindwtr natively models the lower horizons:

- **Horizon 0 (Actions):** Next Actions and task lists.
- **Horizon 1 (Projects):** Explicit Project entities.
- **Horizon 2 (Areas):** Areas group related projects.

For Horizons 3–5 (Goals, Vision, Purpose), there isn’t a dedicated entity yet. Most users track them with:

- A **Reference** list (or a “Goals” area)
- Project notes and links to those reference items
- The Weekly Review checklist

If you rely on explicit Goal/Vision objects, please open an issue with your desired workflow and review cadence.

### What is Project Section used for?

A **Project Section** is a labeled group inside one project. Use sections to keep a longer project readable, such as **Design**, **Development**, and **Content** inside a **Launch website** project.

Sections are not subtasks and not separate projects. They are just headings for tasks inside the same project outcome.

The **Project Section** field on a task assigns that task to one of the sections in its current project. It only does something when the task already belongs to a project that has sections. If the task has no project, or the project has no sections, leave it blank.

### Why can a project have multiple Next tasks?

In Mindwtr, **Next** is a task status: the task has been clarified and is actionable. It is not always the same thing as "the single next action" for a project.

Project type controls what gets surfaced:

- **Sequential:** one available Next task is surfaced at a time. Later Next tasks stay in the project and wait their turn.
- **Parallel:** multiple independent Next tasks can be surfaced because they can be done in any order.

Later steps in a sequential project are not **Reference**. Reference is for non-actionable support material, notes, and documents.

### How do I enable Priority or Estimated Time?

Mindwtr uses progressive disclosure, so optional fields are hidden by default.

Control task edit fields in:

**Settings -> GTD -> Task Editor Layout**

Turn on **Priority** and **Estimated Time** there (and reorder fields if needed). Hidden fields still appear under **More** or when a task already has content in that field.


### What is the difference between Done and Archived tasks?

Use **Done** for tasks you have completed recently. Done tasks keep their completion date, stay visible in the Done view, and are useful during daily or weekly review when you want to see what was finished.

Use **Archived** for completed tasks you want to file away. Archived tasks are hidden from normal task lists and remain available in the Archived view for search, restore, or permanent deletion. Archiving does not delete the task.

In practice, treat Done as a short-term completion log and Archived as long-term history. The **Auto-Archive** setting can move Done tasks to Archived automatically after a chosen number of days, or you can set it to **Never** if you prefer to keep all completions in Done.


### How do recurring tasks work?

Mindwtr supports two recurrence strategies:

- **Strict** (fixed schedule): next date is based on the schedule pattern itself.
  Example: every 5 days stays on that cadence even if you complete late.
- **Repeat after completion** (fluid): next date is calculated from when you actually complete the task.
  Example: complete today, then next is due in 5 days from today.

Set recurrence in the task editor (daily/weekly/monthly/yearly), then enable **Repeat after completion** if you want fluid behavior.

Mindwtr keeps one active instance of a recurring task. It does not pre-populate future Calendar entries for the series; the next task instance is created only when the current one is completed.

### How do I collect logs for a bug report?

Logging is off by default. Enable it only when you want to report a bug.

**Desktop (Tauri):**
1. Go to **Settings → Data**.
2. Enable **Debug logging**.
3. Reproduce the issue.
4. Copy the **Log file** path and attach the file to your GitHub issue.

Linux log location (default): `~/.local/share/mindwtr/logs/mindwtr.log`

**Mobile:**
1. Go to **Settings → Data**.
2. Enable **Debug logging**.
3. Reproduce the issue.
4. Tap **Share log** and attach it to your GitHub issue.

Logs are local-only and redact common credentials (passwords/tokens) before writing.

### Can I use natural language to add tasks?

Yes! Mindwtr supports quick-add syntax:
- `@context` — Add a context
- `#tag` — Add a tag
- `!Area` or `/area:<name>` — Assign to an area
- `/due:date` — Set due date (today, tomorrow, friday, next week, etc.)
- `/note:text` — Add description
- `/status` — Set status (`/next`, `/waiting`, `/someday`, `/done`, `/archived`, `/inbox`)
- `+ProjectName` — Assign to project

Example: `Call client /due:friday @phone`

### What are contexts?

Contexts are tags that indicate where or with what you can complete a task. Examples: `@home`, `@work`, `@phone`, `@computer`. Filter by context to see only tasks you can do right now. See [[Contexts and Tags]].

### How do I capture tasks quickly?

**Desktop:**
- Use the global hotkey to open quick-add from anywhere
- On Flatpak/Wayland, bind `flatpak run tech.dongdongbh.mindwtr --quick-add` as a custom system shortcut if the built-in hotkey is unavailable
- Click the tray icon for instant capture
- Type in any view's input field

**Mobile:**
- Use the share sheet to capture from any app
- Add the home widget for one-tap capture
- Use the Inbox tab input field

---

## Desktop

### What are the keyboard shortcuts?

Mindwtr supports Vim and Emacs keybinding presets. Press `?` (Vim) or `Ctrl-h` (Emacs) to see all shortcuts. See [[Desktop Keyboard Shortcuts]].

### How do I change the theme?

Go to Settings → Appearance. Choose Light, Dark, or System.

### How do I sync with my phone?

1. Configure a sync folder in Settings (point to Dropbox, Syncthing, etc.)
2. On mobile, select the sync folder in Settings → Sync
3. Both platforms auto-sync on data changes and when switching apps

See [[Data and Sync]].

### Does it support notifications?

Yes! Mindwtr sends desktop notifications for:
- Due date reminders
- Start time alerts
- Recurring task reminders

You can snooze notifications for later.

**macOS** will prompt for permission the first time you enable notifications. On **Linux**, ensure a notification daemon is running.

## Mobile

### Which platforms are supported?

- **Android:** Full support via Google Play or APK download
- **iOS:** Available on the App Store and via TestFlight beta. Maintaining the App Store release still requires an annual Apple Developer fee, so sponsorship support helps keep iOS available.

### Why does editing feel different on desktop and mobile?

Mindwtr follows platform conventions:
- **Desktop:** single click toggles details, double click opens edit mode, and right click opens context menus.
- **Mobile:** single tap opens edit mode and swipe actions handle quick changes.

These patterns keep the app fast and familiar on each platform.

### How do I install on Android?

Install from Google Play or download the APK from [GitHub Releases](https://github.com/dongdongbh/Mindwtr/releases). Enable "Install from unknown sources" if prompted. See [[Mobile Installation]].

### How do I capture from other apps?

Use the **share sheet**! When viewing content in any app (browser, email, notes), tap Share and select Mindwtr. Mindwtr opens the capture screen with the shared content in the note so you can add a title, adjust fields, and save it to your Inbox.

### Is there a widget?

Yes! Add the Mindwtr widget to your home screen for quick capture and focus items.

### Is the AI assistant required?

No. The AI assistant is optional and off by default. Mindwtr works fully without it.
When enabled, it uses your own API key (BYOK). See [[AI Assistant]].

### How do swipe actions work?

In the Inbox, swipe right on a task to mark it as Done. Other views may have different swipe actions.

### How do I sync with desktop?

1. Export backup to your sync folder (Google Drive, Syncthing, etc.)
2. Select that folder in Settings → Sync
3. The app auto-syncs on data changes and when going to background

See [[Data and Sync]].

### Does the mobile app send notifications?

Yes! Mindwtr sends push notifications for:
- Due date reminders
- Start time alerts
- Daily digest prompts
- Weekly review reminders

You can snooze notifications directly from the notification.  
Tapping the notification body opens the **Review** screen.

---

## Sync & Data

### Will I lose data if I sync?

No. Mindwtr uses Last-Write-Wins merge, keeping the most recent version of each item. Soft-deleted items sync properly across devices.

### Can I use multiple sync services?

We recommend using one sync folder to avoid conflicts. Pick one service (Dropbox, Google Drive, Syncthing) and use it consistently.

### How do I backup my data?

**Desktop:** Use **Settings → Data → Export Backup**, or back up `data.json` from the app data folder.
**Mobile:** Use **Settings → Data → Export Backup** to save a copy.

See [[Backup and Restore]].

### Can I restore deleted tasks?

There’s no single-task undelete UI yet, but you can restore your local data from a previous backup or recovery snapshot.

See [[Backup and Restore]].

### Can I import from Todoist?

Yes. Mindwtr can import Todoist CSV exports and ZIP backups from **Settings → Data → Import from Todoist**.

- Todoist projects become Mindwtr projects
- Subtasks become checklist items
- Imported tasks land in **Inbox**

See [[Todoist Import]].

### Can I import from DGT GTD?

Yes. Mindwtr can import DGT GTD JSON exports and ZIP archives from **Settings → Data → Import from DGT GTD**.

- DGT folders become Mindwtr areas
- DGT projects become Mindwtr projects
- DGT checklists become checklist tasks
- DGT contexts and tags are preserved

Unsupported DGT repeat patterns are imported once and the original repeat text is preserved in the description.

See [[DGT GTD Import]].

### Can I import from OmniFocus?

Yes. Mindwtr can import OmniFocus CSV exports and Omni Automation JSON / ZIP exports from **Settings → Data → Import from OmniFocus**.

- OmniFocus folders can become Mindwtr areas when metadata is available
- OmniFocus projects become Mindwtr projects when needed
- Standalone OmniFocus actions stay outside projects
- Supported notes, tags, defer dates, due dates, completion state, and recurrence from the JSON path are preserved
- Simple nested tasks can become checklist items, while deeper hierarchy is flattened with the original path preserved

If recurrence matters, use the Omni Automation JSON / ZIP export instead of CSV. Planned dates and duration text are kept in the description when Mindwtr does not have a direct field for them.

See [[OmniFocus Import]].

---

## Troubleshooting

### App won't start (Desktop Linux)

Ensure WebKitGTK is installed:
```bash
# Arch
sudo pacman -S webkit2gtk-4.1

# Debian/Ubuntu  
sudo apt install libwebkit2gtk-4.1-0
```

### Why is the AUR install or build directory so large?

Use `mindwtr-bin` on Arch-based distributions unless you specifically want to build from source:

```bash
yay -S mindwtr-bin
```

`mindwtr-bin` installs the prebuilt GitHub release package and should be the small, fast AUR path. The source package, `mindwtr`, builds the desktop app locally and must download build dependencies for a Tauri, Rust, Bun, and React app. That can use substantially more disk space during the build.

The source package is intended to fetch the release tag archive rather than the full Git history. If an AUR helper appears to download a very large Git checkout, check that you installed `mindwtr-bin` for the binary package path, or report the source-package behavior so the AUR recipe can be corrected.

### App crashes on startup (Mobile)

Try clearing app data:
1. Go to Settings → Apps → Mindwtr
2. Tap Storage → Clear Data
3. Reopen the app

Note: This deletes local data.

### Tasks aren't syncing

1. Check that sync folder is accessible
2. Verify sync service is running
3. Check file permissions
4. Try manual sync in Settings

### Notifications not working

**Desktop:**
- Check system notification settings
- Ensure app has notification permission

**Mobile:**
- Grant notification permission in device settings
- Check app notification settings

---

## Contributing

### How can I contribute?

- Report bugs and suggest features with **Send feedback** in **Settings → About** or on [GitHub Issues](https://github.com/dongdongbh/Mindwtr/issues)
- Submit pull requests
- Help with translations
- Spread the word!

See the [Contributing guide](https://github.com/dongdongbh/Mindwtr/blob/main/docs/CONTRIBUTING.md).

---

## See Also

- [[Getting Started]]
- [[GTD Overview]]
- [[Data and Sync]]
- [Contributing (Repository Guide)](https://github.com/dongdongbh/Mindwtr/blob/main/docs/CONTRIBUTING.md)
