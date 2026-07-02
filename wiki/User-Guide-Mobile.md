# User Guide: Mobile

The Mindwtr mobile app is built with React Native and Expo. Android is fully supported; iOS is available on the App Store and via TestFlight beta.

## Overview

The mobile app uses bottom tabs for core flows and a Menu page for additional views.

---

## Interaction Patterns

- **Tap** to open and edit tasks.
- **Swipe** for quick actions (see Swipe Actions section below).
- **Share sheet** adds items directly to your Inbox.

## Navigation

### Bottom Tabs

| Tab            | Description                          |
| -------------- | ------------------------------------ |
| 📥 **Inbox**    | Capture and process incoming items   |
| 🎯 **Focus**    | Daily dashboard and next actions     |
| ➕ **Quick Capture** | Add a task or audio note quickly |
| 📝 **Review**  | Daily + weekly review                |
| ☰ **Menu**     | Access Projects, Board, Calendar, etc. |

### Menu Tab
 
Tap the **Menu** tab to access additional views:
 
 - 📋 **Board** — Kanban board view with manual drag ordering inside each status column
 - 🗓️ **Calendar** — Time-based view
 - 📁 **Projects** — Multi-step outcomes
 - 🏷️ **Contexts** — Filter by context
 - ⏳ **Waiting For** — Delegated items
 - 💭 **Someday/Maybe** — Future ideas
 - 📚 **Reference** — Reference material
 - ✅ **Done** — Recently completed tasks
 - 📦 **Archived** — Completed tasks filed away from normal lists
 - 🗑️ **Trash** — Deleted tasks and projects
 - ⚙️ **Settings** — App preferences

---

## Global Search

Tap the **search icon** in the header to open Global Search.

### Search Operators

Use operators for powerful filtering:

| Operator    | Example            | Description             |
| ----------- | ------------------ | ----------------------- |
| `status:`   | `status:next`      | Filter by task status   |
| `-status:`  | `-status:done`     | Exclude a status        |
| `context:`  | `context:@home`    | Filter by context       |
| `tag:`      | `tag:#focused`     | Filter by tag           |
| `assigned:` | `assigned:Tom`     | Filter by assignee      |
| `project:`  | `project:HomeReno` | Filter by project       |
| `location:` | `location:office`  | Filter by task location |
| `where:`    | `where:office`     | Alias for task location |
| `id:`       | `id:abc123`        | Find an exact task ID   |
| `-id:`      | `-id:abc123`       | Exclude an exact task ID |
| `due:`      | `due:today`        | Tasks due on date       |
| `due:<=`    | `due:<=7d`         | Tasks due within 7 days |
| `start:`    | `start:>=tomorrow` | Tasks starting from date |
| `created:`  | `created:>=30d`    | Tasks created in last 30 days |
| `OR`        | `@home OR @work`   | Match either condition  |

### Saved Searches

Saved Searches are shortcuts for reusable search queries.

1. Enter your search query
2. Tap **"Save Search"**
3. Name your search
4. Access from **Menu → Saved Searches**

**To delete:** Open the saved search, tap the trash icon in the header.

Saved Searches are separate from **Saved Filters** in Focus. Focus filters save criteria such as projects, contexts, tags, priority, energy, and time estimates for the Focus view.

---


## Quick Capture

Mindwtr offers multiple ways to capture tasks quickly on mobile.

The capture screen is input-first. The syntax help is tucked behind a small “?” toggle to keep the interface clean.

### Share Sheet

Capture tasks from any app using the share sheet:

1. In any app (browser, email, notes), find something you want to capture
2. Tap the **Share** button
3. Select **Mindwtr** from the share options
4. Mindwtr opens the capture screen with the shared content attached as notes
5. Add a title, adjust any fields, and save it to your Inbox

Great for:
- Saving articles to read later
- Capturing emails as tasks
- Adding links from web browsing

### Home Widget

Add the Mindwtr widget to your home screen for quick access:

1. Long-press on your home screen
2. Select **Widgets**
3. Find and add the **Mindwtr** widget
4. Tap the widget to open quick capture or view focus items

### Android Quick Settings Tile

On Android, add the Mindwtr capture tile to Quick Settings for one-swipe Inbox capture:

1. Open Android Quick Settings edit mode.
2. Add the **Mindwtr** tile.
3. Tap the tile to open Quick Capture.

### Android Voice App Actions

Android builds expose a capture action to supported assistants, including Gemini/Assistant surfaces that route through Android App Actions. Voice-created captures open Mindwtr's confirmation flow so you can review the title and note before saving.

### Android Context Automation Intents

Automation apps such as Tasker, MacroDroid, or Phone Profiles can activate a Mindwtr context. Use the Android broadcast form for background-only triggers. When activated, Mindwtr checks matching `/next` actions that are available now and sends a notification only when there is work to show. Tapping that notification opens the matching Contexts view.

Android broadcast form:

| Field | Value |
| --- | --- |
| Package | `tech.dongdongbh.mindwtr` |
| Class | `tech.dongdongbh.mindwtr.ContextAutomationReceiver` |
| Target | Broadcast Receiver |
| Activate action | `tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT` |
| Deactivate action | `tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT` |
| String extra | `context=parents` or `context=@parents` |

ADB examples:

```bash
adb shell am broadcast -n tech.dongdongbh.mindwtr/.ContextAutomationReceiver -a tech.dongdongbh.mindwtr.action.ACTIVATE_CONTEXT --es context parents
adb shell am broadcast -n tech.dongdongbh.mindwtr/.ContextAutomationReceiver -a tech.dongdongbh.mindwtr.action.DEACTIVATE_CONTEXT --es context parents
```

URL form:

| URL | Action |
| --- | --- |
| `mindwtr://contexts?token=%40parents&contextAction=activate` | Activate `@parents` |
| `mindwtr://contexts?token=%40parents&contextAction=deactivate` | Deactivate `@parents` |

URL examples:

```bash
adb shell am start -a android.intent.action.VIEW -d 'mindwtr://contexts?token=%40parents&contextAction=activate' tech.dongdongbh.mindwtr
```

Notes:
- URL launches may open Mindwtr. Use the broadcast receiver form when the automation should stay in the background.
- Context names are normalized to `@context`, so `parents` and `@parents` both match `@parents`.
- Hierarchical contexts match below the selected context, so `@parents` also matches `@parents/errands`.
- If no currently available `/next` actions match the context, Mindwtr stays silent.
- Deactivation is a silent no-op for now. It acknowledges the automation exit trigger and is reserved for future active-context state; it does not delete, hide, or change tasks.
- On Android, context automation URLs and intents return Mindwtr to the background after handling. Use the notification tap when you want to open the matching Contexts view.
- Mindwtr does not detect locations or device states itself; the automation app owns the trigger.

### Apple Shortcuts

On iPhone and iPad, Mindwtr exposes native Apple Shortcuts actions for Inbox capture and opening GTD views such as Focus, Waiting, Someday, Projects, Review, and Calendar. See [[Apple Shortcuts]] for setup, examples, and v1 limitations.

### URL Scheme Quick Capture (iOS Shortcuts / Android Automations)

Mindwtr registers the URL scheme `mindwtr://`, so you can capture tasks from iOS Shortcuts, Tasker, or other automation tools.

Supported URLs:

| URL | Action |
| --- | --- |
| `mindwtr://capture?title=Buy%20groceries` | Open capture with a title |
| `mindwtr://capture?title=Buy%20groceries&note=From%20store` | Open capture with title and note |
| `mindwtr://capture?title=Buy%20groceries&project=Shopping&tags=errands,home` | Open capture with project and tags |

Notes:
- `title` is required (alias: `text`).
- `note` is optional (alias: `description`).
- `project` matches an existing active project by title (case-insensitive), or creates it.
- `tags` is comma-separated and normalized to `#tag` format before saving.

iOS Shortcuts example:
1. Open **Shortcuts** and create a shortcut.
2. Add **Ask for Input** (prompt: task title).
3. Add **Open URLs** with: `mindwtr://capture?title=[Provided Input]`.
4. Run the shortcut; Mindwtr opens the capture screen so you can review and save the task.

### Quick-Add Syntax

Mindwtr parses natural language when adding tasks:

| Syntax       | Example           | Result             |
| ------------ | ----------------- | ------------------ |
| `@context`   | `@home`           | Adds context       |
| `#tag`       | `#focused`        | Adds tag           |
| `+Project`   | `+HomeReno`       | Assigns to project |
| `+Multi Word` | `+New Project`    | Assigns to "New Project" |
| `!Area`       | `Plan roadmap !Work` | Assigns to area       |
| `/area:<name>` | `/area:Personal` | Assigns to area (no spaces) |
| `/due:date`  | `/due:friday`     | Sets due date      |
| `/note:text` | `/note:call back` | Adds description   |
| `/status`    | `/next`, `/waiting`, `/someday`, `/done`, `/archived`, `/inbox` | Sets status |

**Date formats:** today, tomorrow, friday, next week, in 3 days

---

## Audio Capture

Capture tasks using your voice with AI-powered transcription.

### Setup

1. Go to **Menu → Settings → AI Assistant**.
2. Enable **Speech to Text**.
3. Choose a **Provider**:
   - **OpenAI / Gemini**: Cloud-based (requires API key).
   - **Offline (Whisper)**: Runs locally. You can download a model (e.g., Tiny or Base) directly in settings.
4. Set your **Default Capture Method** in **Settings → General** if you prefer audio-first.

### Using Audio Capture

- **Quick Add**: Tap the **Audio** tab in the Quick Capture screen.
- **Record**: Tap the microphone to start.
- **Transcribe**: Stop recording to process the audio.
- **Smart Parse**: If enabled, the app will extract dates and fields automatically.

---

## Inbox

Your capture zone for quick task entry.

Use **Mind Sweep** when you want guided capture prompts for work, home, people, errands, and open loops instead of starting from a blank input.

### Adding Tasks

1. Tap the input field at the bottom
2. Use the share sheet from other apps
3. Tap the home widget
4. Type your task with quick-add syntax
5. Tap the add button or press Enter

### Processing Inbox

Tap **Process Inbox** to start the clarify workflow:

1. **Is this actionable?**
   - Yes → Continue
   - No → Trash or Someday/Maybe

2. **Will it take less than 2 minutes?**
   - Yes → Do it now, mark Done
   - No → Continue

3. **Who should do it?**
   - I'll do it → Add context, move to Next Actions
   - Delegate → Move to Waiting For

4. **Where will you do this?**
   - Select contexts (@home, @work, etc.)
   - Add custom contexts

5. **Assign to a project?** (Optional)
   - Select a project or skip

---

## Focus

Your primary dashboard for doing. Focus is an Engage dashboard, not a full inventory of every task with status `next`.

### Sections

| Section      | Content                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| **Today**    | Tasks focused for today, due today/overdue, or starting today           |
| **Next**     | Available next actions that are not blocked or deferred                 |

Focus hides future-start tasks and later tasks in sequential projects so the list stays limited to what you can act on now. Use **Contexts**, **Projects**, or **Search** when you want to inspect the broader task inventory.

Default Next Actions order is due-soon actions first, undated actions next, and far-future due actions last. Within the same bucket, Focus uses priority when enabled, then start time, creation date, title, and id. See [[GTD Workflow in Mindwtr#How Focus sorts available actions]] for the full logic.

### Features

- **Context filter** — Tap a context chip to filter the Next list.
- **Saved Filters** — Save reusable Focus criteria such as projects, contexts, tags, priority, energy level, and time estimates.
- **Swipe to Focus** — Swipe a task right to toggle "Focus" status (moves it to Today).
- **Quick Status** — Tap the status badge to change status.
- **Pomodoro (Optional)** — Enable in **Settings → GTD → Features → Pomodoro timer** to show a compact focus/break timer. Leave it as **Timer only**, or turn on **Link timer to task** to show the Timer task picker and **Mark task done** action.

---

## Review

Review your tasks and update their status.

- See task details (description, start time, deadline, contexts)
- Quickly mark tasks as done
- Navigate between tasks
- **Select mode**: Batch select tasks and share them
- During Weekly Review, use the **Process Inbox** step to clear captured items before continuing through calendar, waiting-for, projects, and someday review.

---

## Task Editor (Task + View)

The task editor has two modes:

- **Task** — edit fields, checklists, dates, tags, contexts
- **View** — clean read-only summary with tappable checklist

Swipe left/right to switch between **Task** and **View**.

Checklist-first tasks default to View mode for faster checking.

The editor starts minimal. Tap **More options** to reveal advanced fields; any field with existing content stays visible.

Description markdown supports unordered lists and task checkboxes (`- item`, `[ ] item`, `[x] item`).
Type `[[` in task descriptions or project notes to link another task or project from the link picker sheet.
Those links are navigational only; they do not sync completion state between tasks.
Markdown checkbox lines can populate checklist items when you save.
The **Assignee / Person** field stores delegated people for Waiting For, suggestions, and `assigned:` search. Manage saved people, notes, and reference links from **Settings → Manage**.

Recurring tasks support two strategies:
- **Strict** (fixed cadence)
- **Repeat after completion** (next date from completion time)
- **Ends: Never / On date / After N occurrences**

Mindwtr keeps one active instance of a recurring task. The Calendar shows that current instance when it has a due date or start time; future occurrences are not pre-filled until the current one is completed unless **Show next occurrence in Calendar** is enabled for a planning-only preview.

Use the recurrence field in the task editor, then toggle **Repeat after completion** or **Show next occurrence in Calendar** when needed.
The same sheet lets you stop a series on a target date or after a fixed number of total occurrences.

### Attachments

You can attach files or links to a task from the editor. Audio notes can be saved as attachments when **Save audio attachments** is enabled.

See [[Attachments]] for details on syncing and cleanup.

---

## AI Assistant (Optional)

Enable in **Settings → Advanced → AI assistant**:

- **Clarify** — turn vague tasks into concrete next actions
- **Break down** — generate checklist steps for big tasks
- **Review analysis** — highlight stale tasks during review
- **Copilot** — context/tag/time suggestions while typing

AI is optional and only runs when you request it.

---

## Reusable Lists

Use checklists as templates:

- **Duplicate task** — copy a master list (packing, travel prep)
- **Reset checklist** — uncheck everything for reuse (groceries)

---

## Calendar Integration

Mindwtr can overlay external calendars and push dated Mindwtr tasks to the device calendar. Detailed setup lives in [[Calendar Integration]].

To push tasks to Android/Google Calendar or Apple Calendar on iOS:

1. Go to **Settings -> Calendar**
2. Enable **Push tasks to calendar**
3. Grant calendar permission
4. Expand **Sync target**
5. Choose a dedicated `Mindwtr` calendar or another writable calendar target

For Android Google Calendar and iOS Apple Calendar target setup, see [[Calendar Integration]].

To overlay external calendars with ICS subscriptions:

1. Go to **Settings -> Calendar**
2. Add your **ICS URL**
3. Refresh to fetch events

External events are view-only and are not synced back to their source. Tap an external event and choose **Create task** to make a separate Mindwtr task; Mindwtr copies the event title, date/time, location, description, and calendar name where available.

---

## Calendar

Time-based view with scheduling capabilities.

### Views

- **Month View** — Overview of tasks with due dates
- **Day View** — Detailed timeline with scheduled tasks and external events

### Scheduling Tasks

1. On the Calendar day view, tap **Schedule Tasks**
2. Select from Next Actions (shown first) or search Todo tasks
3. Mindwtr finds the earliest free slot (avoids conflicts with external events)
4. Task gets a start time based on its time estimate

The scheduling panel is the mobile planning surface: use it when you are looking at a day and want to turn unscheduled Next Actions or due-but-unscheduled work into concrete time blocks. Collapse it when you want to focus on the calendar grid.

### Drag to Reschedule

- Long-press a scheduled task block
- Drag to a new time slot (snaps to 5-minute intervals)
- Release to update the start time

### External Calendars (iCal/ICS)

Subscribe to external calendars to see events alongside your tasks:

1. Go to **Settings → Advanced → Calendar**
2. Enter the calendar URL (ICS/webcal format)
3. Give it a name and tap **Add**
4. External events appear as gray blocks in Day view

---

## Projects

Manage multi-step outcomes.

Open Projects from **Menu → Projects**.

### Project List

- View all active projects
- See task count per project
- Tap to view project details

### Project Details

- View all tasks in the project
- Add new tasks
- Group tasks with **Sections** inside the project. Sections are headings inside one project, not subtasks or separate projects.
- Tap a task to assign a **Section** in the task editor
- Edit project settings (name, color, notes)
- Assign **Area of Focus** (e.g., Work, Personal)
- Add **Project tags** for filtering
- Set sequential or parallel mode
- Set review date
- Reorder project tasks with the drag handle when custom ordering is enabled
- Complete or archive the project

The **Project Section** field in the task editor assigns a task to one of the sections in its current project. It only matters after the task belongs to a project that has sections; otherwise, leave it blank.

### Sequential vs Parallel

| Mode           | Behavior                                             |
| -------------- | ---------------------------------------------------- |
| **Sequential** | Only the first available project task appears in Focus |
| **Parallel**   | All available project tasks can appear in Focus        |

Sequential projects can run project-wide or section-by-section. Section-scoped sequencing shows the first available task in each project section, so separate phases or workstreams can move forward in parallel without making every task visible.

---

## Swipe Actions

Quickly manage tasks with swipe gestures:

| View             | Swipe Right | Result             |
| ---------------- | ----------- | ------------------ |
| **Inbox**        | Done        | Marks task as done |
| **Focus**        | Focus       | Toggles focus status |

---

## Contexts

Browse and filter tasks by context.

### Location Contexts

- `@home` — Tasks to do at home
- `@work` — Tasks for the office
- `@errands` — Out and about
- `@agendas` — Discussion items
- `@computer` — Need a computer
- `@phone` — Need a phone
- `@anywhere` — Can do anywhere

### Tags

Filter tasks by energy level, mode, or topic:

- `#focused` — Deep work requiring concentration
- `#lowenergy` — Simple tasks for tired moments
- `#creative` — Brainstorming and ideation
- `#routine` — Repetitive/mechanical tasks

---

## Waiting For

Track items delegated or waiting on external events.

- View all waiting tasks
- See deadlines
- Move to Next when ready
- Mark as Done when received

---

## Someday/Maybe

Incubate ideas for the future.

- Review periodically during Weekly Review
- Activate by moving to Next status
- Archive if no longer relevant

---

## Notifications & Reminders

Mindwtr sends push notifications to keep you on track.

### Types of Notifications

- **Due date reminders** — Alerts when tasks are due
- **Start time alerts** — Reminds you when it's time to begin
- **Recurring task reminders** — Notifications for recurring items

Tap the notification body to jump directly to the **Review** screen.

### Permissions

Make sure notifications are enabled:
1. Go to device **Settings → Apps → Mindwtr**
2. Enable **Notifications**
3. Allow alerts and sounds as desired

---

## Settings

### General

- **Appearance** — System, Light, or Dark
- **Language** — English, Vietnamese, Chinese (Simplified), Chinese (Traditional), Spanish, Hindi, Arabic, German, Russian, Japanese, French, Portuguese, Polish, Korean, Czech, Italian, Turkish, Dutch

### Notifications

**Task Reminders:**
- Enable/disable notifications for due dates and start times

**Daily Digest:**
- **Morning Briefing** — Summary of due today, overdue, and focus tasks
- **Evening Review** — Prompt to review and wrap up the day
- Configure times for each

**Weekly Review:**
- **Reminders** — Get a weekly notification to start your review
- **Time/Day** — Customize when you want to review (e.g., Friday at 4 PM)

### GTD

Customize how Mindwtr works for your GTD workflow:

**Features (Optional):**
- **Priorities** — Show a priority flag on tasks
- **Time Estimates** — Add a duration field for time blocking

**Time Estimate Presets:**
- Choose which time estimates appear in the task editor
- Options: 5m, 10m, 15m, 30m, 1h, 2h, 3h, 4h, 4h+
- Default: 10m, 30m, 1h, 2h, 3h, 4h, 4h+

**Auto-Archive:**
- Automatically move Done tasks to Archived after a set number of days (default: 7 days)
- Set to "Never" to keep completions in the Done list indefinitely

**Inbox Processing:**
- Mobile keeps the card-based inbox processing flow
- The same shared settings can hide or show the 2-minute shortcut, project-first prompt, contexts/tags section, scheduling section, and reference option

**Task Editor Layout:**
- Tap a field to toggle visibility (hidden fields still show when they have values)
- Long-press the drag handle to reorder fields
- Move fields between sections like **Basic**, **Scheduling**, **Organization**, and **Details**
- Choose which collapsible sections open by default
- Hidden fields can be revealed with the **More** button in the editor

**Manage:**
- Use **Settings → Manage** to edit saved **Areas**, **People**, **Contexts**, and **Tags**
- This is the fastest place to clean up duplicates or rename reusable metadata

### Data & Sync

See [[Data and Sync]] for sync setup.

**Sync Backend:**
- **Cloud Sync** — Dropbox in supported builds, plus iCloud on iOS where available
- **Folder / File Sync** — File sync via a shared JSON file/folder (Google Drive, Syncthing, OneDrive, etc.)
- **Advanced / Custom Server** — WebDAV or Self-Hosted Mindwtr Cloud

**Other Options:**
- **Sync** — Manually trigger sync
- **Last sync status** — View when data was last synced
- **Sync history** — Collapsed by default; tap to expand recent entries
- **Export Backup** — Save data to a file
- **Apple Reminders import** — Choose a Reminders list and import incomplete reminders into Inbox. Imported reminders remain in Apple Reminders, and already imported, completed, or untitled reminders are skipped.
- **Settings sync options** — Choose which preferences sync across devices (theme, language/date format, GTD defaults, external calendar URLs, AI settings, and Saved Filters). API keys and local model paths are never synced.

**GTD Options:**
- **Focus task limit** — Choose how many tasks can be marked for Today's Focus.

### Advanced

**AI Assistant:**
- Optional BYOK assistant for clarifying and breaking down tasks

**Calendar (ICS/iCal):**
- **Add Calendar** — Enter a name and URL
- **Enable/Disable** — Toggle visibility of each calendar
- **Remove** — Delete a subscription
- **Test** — Verify the calendar loads correctly

### About

- Version number
- Check for updates
- **Send feedback** for bug reports, feature requests, or other notes when the build has feedback enabled. You can include a reply email if you want follow-up.
- Website and GitHub links

---

## See Also

- [[Mobile Installation]]
- [[Apple Shortcuts]]
- [[Data and Sync]]
- [[GTD Workflow in Mindwtr]]
