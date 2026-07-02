# MCP Server

Mindwtr provides an optional **MCP (Model Context Protocol)** server. This allows you to connect AI agents (like **Claude Desktop**, **Claude Code**, **OpenAI Codex**, or **Gemini CLI**) to your local Mindwtr database, or to a self-hosted Mindwtr Cloud endpoint in read-only mode.

This is a **stdio** server (no hosted HTTP endpoint). MCP clients launch it as a subprocess and talk over JSON-RPC on stdin/stdout.

> Canonical reference: [apps/mcp-server/README.md](https://github.com/dongdongbh/Mindwtr/blob/main/apps/mcp-server/README.md). Keep this page aligned with that file when MCP tools or schemas change.

---

## App Binaries vs. MCP Helper

The desktop and mobile app binaries include the Mindwtr app, but they do **not** currently include a desktop start/stop toggle. The standalone MCP helper is published as [`mindwtr-mcp`](https://www.npmjs.com/package/mindwtr-mcp) and listed in the public [MCP Registry](https://registry.modelcontextprotocol.io/).

You do **not** need to run the whole app from source to use MCP. Use the normal desktop app binary for your tasks, then let your MCP client launch `mindwtr-mcp` with `npx`, or install it globally with npm. Point the helper at the desktop app's local `mindwtr.db`.

On desktop, the app shows the exact local data path in **Settings -> Sync -> Local Data**. Mobile binaries do not expose a local MCP server surface.

---

## Requirements

- **Node.js 18+** (for the MCP client that spawns the server)
- **npm** or another Node package runner for the published `mindwtr-mcp` package
- A local Mindwtr database (`mindwtr.db`) for local mode, or a self-hosted Mindwtr Cloud URL and bearer token for read-only Cloud mode
- **Bun** only if you are running the helper from the source tree

### Default Database Locations

- **Linux:** `~/.local/share/mindwtr/mindwtr.db`
- **macOS:** `~/Library/Application Support/mindwtr/mindwtr.db`
- **Windows:** `%APPDATA%\mindwtr\mindwtr.db`

Additional macOS path for sandboxed builds:

- `~/Library/Containers/tech.dongdongbh.mindwtr/Data/Library/Application Support/mindwtr/mindwtr.db`

You can override the local database location with:

- `--db /path/to/mindwtr.db`
- Environment variable: `MINDWTR_DB_PATH` or `MINDWTR_DB`

For self-hosted Cloud mode, use:

- `--cloud-url https://mindwtr.example.com` or `MINDWTR_MCP_CLOUD_URL`
- `--cloud-token <token>` or `MINDWTR_MCP_CLOUD_TOKEN`
- optional `--cloud-allow-insecure-http=true` for trusted private HTTP deployments

---

## Setup & Configuration

MCP clients run the server as a subprocess. You point them to **the command** and pass arguments.

Recommended install-free command for MCP clients:

```json
{
  "command": "npx",
  "args": [
    "-y",
    "mindwtr-mcp",
    "--db",
    "/path/to/mindwtr.db"
  ]
}
```

The package is read-only by default. Add `--write` only when you explicitly want an AI client to add, update, complete, or delete local Mindwtr data.

### Read-only Self-hosted Cloud Mode

Use Cloud mode when you run your own Mindwtr Cloud server and want MCP read tools without exposing a local SQLite file:

```bash
npx -y mindwtr-mcp \
  --cloud-url "https://mindwtr.example.com" \
  --cloud-token "$MINDWTR_TOKEN"
```

Or use environment variables in an MCP client configuration:

```json
{
  "command": "npx",
  "args": ["-y", "mindwtr-mcp"],
  "env": {
    "MINDWTR_MCP_CLOUD_URL": "https://mindwtr.example.com",
    "MINDWTR_MCP_CLOUD_TOKEN": "your-token"
  }
}
```

Cloud mode reads the current `/v1/data` snapshot from your self-hosted Cloud server and exposes read tools for tasks, projects, sections, areas, and people. It is always read-only; `--write` is rejected in Cloud mode and write tools return `read_only`.

This is not the blocked hosted multi-tenant connector. You still run the Cloud server and the MCP helper yourself; Mindwtr is not operating a service that stores everyone's task data.

For a global install instead:

```bash
npm install -g mindwtr-mcp
mindwtr-mcp --db "/path/to/mindwtr.db"
```

### Key Arguments

- `--db "/path/to/mindwtr.db"`: Path to your SQLite database for local mode.
- `--write`: Enable local SQLite write operations (add, update, complete, delete). **Without this flag, the server is read-only.**
- `--cloud-url "https://mindwtr.example.com"`: Use a self-hosted Mindwtr Cloud endpoint instead of a local database.
- `--cloud-token "<token>"`: Bearer token for the self-hosted Cloud endpoint.
- `--cloud-allow-insecure-http=true`: Allow trusted private HTTP Cloud URLs when you intentionally run without HTTPS.

### 1. Claude Desktop

Add a server entry to your Claude Desktop configuration file.

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "npx",
      "args": [
        "-y",
        "mindwtr-mcp",
        "--db",
        "~/.local/share/mindwtr/mindwtr.db",
        "--write"
      ]
    }
  }
}
```

_Note: Replace the DB path with your actual local Mindwtr database path._

### 2. Claude Code (CLI)

You can add the server via the CLI:

```bash
claude mcp add mindwtr -- \
  npx -y mindwtr-mcp --db "/path/to/mindwtr.db" --write
```

### 3. OpenAI Codex (CLI / IDE Extension)

Codex reads MCP server configuration from `~/.codex/config.toml`. You can also use a project-scoped `.codex/config.toml` in a trusted project. The Codex CLI and IDE extension share this configuration.

**Command Line:**

```bash
codex mcp add mindwtr -- \
  npx -y mindwtr-mcp \
  --db "/path/to/mindwtr.db"
```

Add `--write` only if you want Codex to mutate local Mindwtr data:

```bash
codex mcp add mindwtr -- \
  npx -y mindwtr-mcp \
  --db "/path/to/mindwtr.db" --write
```

In the Codex TUI, run `/mcp` to confirm the server is active.

**Manual Config:**

```toml
[mcp_servers.mindwtr]
command = "npx"
args = [
  "-y",
  "mindwtr-mcp",
  "--db",
  "/path/to/mindwtr.db"
]
```

With write access:

```toml
[mcp_servers.mindwtr]
command = "npx"
args = [
  "-y",
  "mindwtr-mcp",
  "--db",
  "/path/to/mindwtr.db",
  "--write"
]
```

### 4. Gemini CLI

Gemini CLI uses `settings.json` (User: `~/.gemini/settings.json` or Project: `.gemini/settings.json`).

**Command Line:**

```bash
gemini mcp add mindwtr \
  npx -y mindwtr-mcp \
  --db "/path/to/mindwtr.db" --write
```

**Manual Config:**

```json
{
  "mcpServers": {
    "mindwtr": {
      "command": "npx",
      "args": [
        "-y",
        "mindwtr-mcp",
        "--db",
        "/path/to/mindwtr.db",
        "--write"
      ]
    }
  }
}
```

---

## Running Manually

You usually don't need to run this manually (the MCP client does it), but it's useful for testing.

### From npm

```bash
# Read-only
npx -y mindwtr-mcp --db "/path/to/mindwtr.db"

# With write access
npx -y mindwtr-mcp --db "/path/to/mindwtr.db" --write
```

### From Source (Bun)

```bash
# Read-only
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db"

# With write access
bun run mindwtr:mcp -- --db "/path/to/mindwtr.db" --write
```

### Build & Run (Node)

```bash
# Build
bun run --filter mindwtr-mcp build

# Run
node apps/mcp-server/dist/index.js --db "/path/to/mindwtr.db"
```

---

## Migration: tool rename (`mindwtr.*` → `mindwtr_*`)

Tool names now use underscore notation, such as `mindwtr_list_tasks`; older dot-notation names are no longer documented.

---

## Available Tools

When connected, the AI agent has access to these tools. By default the server is **read-only**; pass `--write` to enable any write tool.
Only `--write` is supported for write access (no alternate aliases).

| Tool                    | Operation            | Requires `--write` |
| ----------------------- | -------------------- | ------------------ |
| `mindwtr_list_tasks`    | List tasks           | No                 |
| `mindwtr_list_projects` | List projects        | No                 |
| `mindwtr_get_project`   | Fetch one project    | No                 |
| `mindwtr_list_sections` | List sections        | No                 |
| `mindwtr_get_section`   | Fetch one section    | No                 |
| `mindwtr_list_areas`    | List areas           | No                 |
| `mindwtr_list_people`   | List people          | No                 |
| `mindwtr_get_person`    | Fetch one person     | No                 |
| `mindwtr_get_task`      | Fetch one task by ID | No                 |
| `mindwtr_add_task`      | Create task          | Yes                |
| `mindwtr_update_task`   | Update task          | Yes                |
| `mindwtr_complete_task` | Mark done            | Yes                |
| `mindwtr_delete_task`   | Soft-delete task     | Yes                |
| `mindwtr_restore_task`  | Restore task         | Yes                |
| `mindwtr_add_project`   | Create project       | Yes                |
| `mindwtr_update_project`| Update project       | Yes                |
| `mindwtr_delete_project`| Soft-delete project  | Yes                |
| `mindwtr_add_section`   | Create section       | Yes                |
| `mindwtr_update_section`| Update section       | Yes                |
| `mindwtr_delete_section`| Soft-delete section  | Yes                |
| `mindwtr_add_area`      | Create area          | Yes                |
| `mindwtr_update_area`   | Update area          | Yes                |
| `mindwtr_delete_area`   | Soft-delete area     | Yes                |
| `mindwtr_add_person`    | Create person        | Yes                |
| `mindwtr_update_person` | Update person        | Yes                |
| `mindwtr_rename_person` | Rename person        | Yes                |
| `mindwtr_delete_person` | Soft-delete person   | Yes                |

### Read Tools

- **`mindwtr_list_tasks`**: List tasks with filters (status, project, date range, search).
- **`mindwtr_list_projects`**: List all projects.
- **`mindwtr_get_project`**: Get details of a specific project by ID.
- **`mindwtr_list_sections`**: List project sections, optionally filtered by project.
- **`mindwtr_get_section`**: Get details of a specific section by ID.
- **`mindwtr_list_areas`**: List all areas.
- **`mindwtr_list_people`**: List managed people records.
- **`mindwtr_get_person`**: Get details of a specific person by ID.
- **`mindwtr_get_task`**: Get details of a specific task by ID.

### Write Tools (Requires `--write`)

- **`mindwtr_add_task`**: Create a new task. Supports natural language `quickAdd` (e.g., "Buy milk @errands /due:tomorrow").
- **`mindwtr_update_task`**: Update an existing task, including scheduling fields like `dueDate`, `startTime`, `reviewAt`, and `isFocusedToday` (supports clearing fields with `null`).
- **`mindwtr_complete_task`**: Mark a task as done.
- **`mindwtr_delete_task`**: Soft-delete a task.
- **`mindwtr_restore_task`**: Restore a soft-deleted task.
- **`mindwtr_add_project`**: Create a new project, including optional `dueDate` and `reviewAt`.
- **`mindwtr_update_project`**: Update a project, including optional `dueDate` and `reviewAt`.
- **`mindwtr_delete_project`**: Soft-delete a project.
- **`mindwtr_add_section`**: Create a section inside a project.
- **`mindwtr_update_section`**: Update a project section.
- **`mindwtr_delete_section`**: Soft-delete a project section. Tasks in that section are kept and moved to no section by core.
- **`mindwtr_add_area`**: Create a new area.
- **`mindwtr_update_area`**: Update an area.
- **`mindwtr_delete_area`**: Soft-delete an area.
- **`mindwtr_add_person`**: Create a managed person for assignees and waiting-for tasks.
- **`mindwtr_update_person`**: Update managed person metadata.
- **`mindwtr_rename_person`**: Rename a managed person and optionally update exact task assignments.
- **`mindwtr_delete_person`**: Soft-delete a managed person without clearing task assignments.

Schema note:
- Task write tools cover `dueDate`, `startTime`, and `reviewAt` (on update).
- Project write tools cover both `dueDate` and `reviewAt`.
- Person write tools cover `name`, `note`, `referenceLink`, and optional assignment updates on rename.
- For the exact canonical inputs, use [apps/mcp-server/README.md](https://github.com/dongdongbh/Mindwtr/blob/main/apps/mcp-server/README.md).

## Permission Matrix

Use this matrix when deciding whether to run the server in read-only mode or with `--write`.

| Tool                    | Data Access          | Mutation Type       | Read-only Mode | `--write` Mode |
| ----------------------- | -------------------- | ------------------- | -------------- | -------------- |
| `mindwtr_list_tasks`    | Task rows (filtered) | None                | Allowed        | Allowed        |
| `mindwtr_list_projects` | Project rows         | None                | Allowed        | Allowed        |
| `mindwtr_get_project`   | Single project by ID | None                | Allowed        | Allowed        |
| `mindwtr_list_sections` | Section rows         | None                | Allowed        | Allowed        |
| `mindwtr_get_section`   | Single section by ID | None                | Allowed        | Allowed        |
| `mindwtr_list_areas`    | Area rows            | None                | Allowed        | Allowed        |
| `mindwtr_list_people`   | Person rows          | None                | Allowed        | Allowed        |
| `mindwtr_get_person`    | Single person by ID  | None                | Allowed        | Allowed        |
| `mindwtr_get_task`      | Single task by ID    | None                | Allowed        | Allowed        |
| `mindwtr_add_task`      | Task table           | Insert              | Denied         | Allowed        |
| `mindwtr_update_task`   | Task table           | Update              | Denied         | Allowed        |
| `mindwtr_complete_task` | Task table           | Update status       | Denied         | Allowed        |
| `mindwtr_delete_task`   | Task table           | Soft-delete         | Denied         | Allowed        |
| `mindwtr_restore_task`  | Task table           | Restore soft-delete | Denied         | Allowed        |
| `mindwtr_add_project`   | Project table        | Insert              | Denied         | Allowed        |
| `mindwtr_update_project`| Project table        | Update              | Denied         | Allowed        |
| `mindwtr_delete_project`| Project table        | Soft-delete         | Denied         | Allowed        |
| `mindwtr_add_section`   | Section table        | Insert              | Denied         | Allowed        |
| `mindwtr_update_section`| Section table        | Update              | Denied         | Allowed        |
| `mindwtr_delete_section`| Section table        | Soft-delete         | Denied         | Allowed        |
| `mindwtr_add_area`      | Area table           | Insert              | Denied         | Allowed        |
| `mindwtr_update_area`   | Area table           | Update              | Denied         | Allowed        |
| `mindwtr_delete_area`   | Area table           | Soft-delete         | Denied         | Allowed        |
| `mindwtr_add_person`    | People table         | Insert              | Denied         | Allowed        |
| `mindwtr_update_person` | People table         | Update              | Denied         | Allowed        |
| `mindwtr_rename_person` | People table/tasks   | Rename/update refs  | Denied         | Allowed        |
| `mindwtr_delete_person` | People table         | Soft-delete         | Denied         | Allowed        |

Practical guidance:

- Default to read-only for exploration and reporting.
- Enable `--write` only in trusted local environments.
- For agent workflows, prefer explicit confirmation before delete/complete operations.

## Advanced Usage Examples

### 1) Guided Weekly Review

1. `mindwtr_list_tasks` with `status: "waiting"` and `status: "someday"`.
2. Summarize stalled items by project.
3. For selected items, call `mindwtr_update_task` to set `reviewAt`.

### 2) Inbox Triage Session

1. `mindwtr_list_tasks` with `status: "inbox"` and `sortBy: "createdAt"`.
2. For each task, classify with `mindwtr_update_task` (`next`, `waiting`, `reference`, etc.).
3. Add missing metadata (project, contexts, tags) in a second pass.

### 3) Safe Bulk Close Pattern

For potentially destructive automation:

1. Run read phase: list candidate IDs only.
2. Present confirmation summary (count + titles).
3. Execute writes (`complete_task` / `delete_task`) only after explicit user approval.
4. Keep IDs for rollback via `restore_task`.

### 4) Quick Capture with Natural Language

Use `mindwtr_add_task` + `quickAdd`:

```json
{
  "quickAdd": "Follow up with Alex +Hiring @work #ops /due:tomorrow 10am"
}
```

Use this for rapid capture flows where parsing commands is more efficient than setting each field manually.

---

## Tool Reference

All tools return JSON in the `content.text` field. Parse the JSON to get the actual payload.

## Operational Limits

These limits are useful when wiring Mindwtr into agent workflows:

- `mindwtr_list_tasks` defaults to `limit: 200` and caps `limit` at `500`.
- Task titles are capped at `500` characters for MCP task creation/update validation.
- Quick-add inputs are capped at `2000` characters for MCP task creation, matching the cloud task API quick-add limit.
- The SQLite layer uses a `busy_timeout` of 5 seconds, so a locked database should fail instead of hanging indefinitely.

If you need more than 500 tasks, page with `limit` + `offset` instead of expecting one unbounded response.

### `mindwtr_list_tasks`

**Input fields**

- `status`: `inbox | next | waiting | someday | reference | done | archived | all`
- `projectId`: string
- `includeDeleted`: boolean
- `limit`: number
- `offset`: number
- `search`: string
- `dueDateFrom`: ISO date or datetime string (compared by calendar date)
- `dueDateTo`: ISO date or datetime string (compared by calendar date)
- `sortBy`: `updatedAt | createdAt | dueDate | title | priority`
- `sortOrder`: `asc | desc`

**Example**

```json
{
  "status": "next",
  "limit": 20,
  "offset": 0,
  "sortBy": "updatedAt",
  "sortOrder": "desc"
}
```

**Response**

```json
{
  "tasks": [
    {
      "id": "task-uuid",
      "title": "Follow up with design",
      "status": "next",
      "updatedAt": "2026-01-25T03:45:57.246Z"
    }
  ]
}
```

### `mindwtr_list_projects`

**Input fields**

- none

**Response**

```json
{
  "projects": [
    {
      "id": "project-uuid",
      "title": "Mindwtr",
      "status": "active"
    }
  ]
}
```

### `mindwtr_get_project`

**Input fields**

- `id`: string (project UUID)
- `includeDeleted`: boolean (optional)

**Example**

```json
{ "id": "project-uuid" }
```

### `mindwtr_list_sections`

**Input fields**

- `projectId`: string (optional)
- `includeDeleted`: boolean (optional)

**Response**

```json
{
  "sections": [
    {
      "id": "section-uuid",
      "projectId": "project-uuid",
      "title": "Planning"
    }
  ]
}
```

### `mindwtr_get_section`

**Input fields**

- `id`: string (section UUID)
- `includeDeleted`: boolean (optional)

**Example**

```json
{ "id": "section-uuid" }
```

### `mindwtr_list_areas`

**Input fields**

- none

**Response**

```json
{
  "areas": [
    {
      "id": "area-uuid",
      "name": "Work"
    }
  ]
}
```

### `mindwtr_list_people`

**Input fields**

- `includeDeleted`: boolean (optional)

**Response**

```json
{
  "people": [
    {
      "id": "person-uuid",
      "name": "Alex"
    }
  ]
}
```

### `mindwtr_get_person`

**Input fields**

- `id`: string (person UUID)
- `includeDeleted`: boolean (optional)

**Example**

```json
{ "id": "person-uuid" }
```

### `mindwtr_get_task`

**Input fields**

- `id`: string (task UUID)
- `includeDeleted`: boolean (optional)

**Example**

```json
{ "id": "task-uuid" }
```

### `mindwtr_add_task` (write)

**Input fields**

- `title`: string (required if `quickAdd` omitted)
- `quickAdd`: string (required if `title` omitted)
- `status`: `inbox | next | waiting | someday | reference | done | archived`
- `projectId`: string
- `dueDate`: ISO string
- `startTime`: ISO string
- `contexts`: string[]
- `tags`: string[]
- `description`: string
- `priority`: string
- `timeEstimate`: string (e.g. `30m`, `2h`)

**Example**

```json
{
  "quickAdd": "Send invoice +Acme /due:tomorrow 9am #finance"
}
```

### `mindwtr_update_task` (write)

**Input fields**

- `id`: string (task UUID)
- `title`, `status`, `projectId`, `dueDate`, `startTime`, `contexts`, `tags`, `description`, `priority`, `timeEstimate`, `reviewAt`, `isFocusedToday`

**Notes**

- Use `null` to clear nullable fields. This applies to task fields such as `projectId`, `dueDate`, `startTime`, `contexts`, and `tags`; project fields such as `areaId`, `dueDate`, `reviewAt`, and `supportNotes`; section `description`; area `color` and `icon`; and person `note` and `referenceLink`.

**Example**

```json
{
  "id": "task-uuid",
  "status": "waiting",
  "reviewAt": "2026-01-27T09:00:00.000Z"
}
```

### `mindwtr_complete_task` (write)

**Input fields**

- `id`: string (task UUID)

### `mindwtr_delete_task` (write)

**Input fields**

- `id`: string (task UUID)

### `mindwtr_restore_task` (write)

**Input fields**

- `id`: string (task UUID)

### `mindwtr_add_project` (write)

**Input fields**

- `title`: string
- `color`: string (optional)
- `status`: `active | someday | waiting | archived` (optional)
- `areaId`: string or `null`
- `isSequential`: boolean (optional)
- `isFocused`: boolean (optional)
- `dueDate`: ISO string or `null`
- `reviewAt`: ISO string or `null`
- `supportNotes`: string or `null`

### `mindwtr_update_project` (write)

**Input fields**

- `id`: string (project UUID)
- `title`, `color`, `status`, `areaId`, `isSequential`, `isFocused`, `dueDate`, `reviewAt`, `supportNotes`

### `mindwtr_delete_project` (write)

**Input fields**

- `id`: string (project UUID)

### `mindwtr_add_section` (write)

**Input fields**

- `projectId`: string
- `title`: string
- `description`: string or `null` (optional)
- `order`: number (optional)
- `isCollapsed`: boolean (optional)

### `mindwtr_update_section` (write)

**Input fields**

- `id`: string (section UUID)
- `title`, `description`, `order`, `isCollapsed`

### `mindwtr_delete_section` (write)

**Input fields**

- `id`: string (section UUID)

### `mindwtr_add_area` (write)

**Input fields**

- `name`: string
- `color`: string (optional)
- `icon`: string (optional)

### `mindwtr_update_area` (write)

**Input fields**

- `id`: string (area UUID)
- `name`, `color`, `icon`

### `mindwtr_delete_area` (write)

**Input fields**

- `id`: string (area UUID)

### `mindwtr_add_person` (write)

**Input fields**

- `name`: string
- `note`: string or `null` (optional)
- `referenceLink`: string or `null` (optional)

### `mindwtr_update_person` (write)

**Input fields**

- `id`: string (person UUID)
- `name`, `note`, `referenceLink`

### `mindwtr_rename_person` (write)

**Input fields**

- `id`: string (person UUID)
- `name`: string
- `updateTasks`: boolean (optional)

### `mindwtr_delete_person` (write)

**Input fields**

- `id`: string (person UUID)

---

## Output Format Notes

- Tool outputs are JSON strings, not structured MCP values. Your client should parse `content[0].text`.
- Task/project IDs are UUIDs from the local SQLite database.
- Dates are ISO 8601 strings (UTC).

---

## Safety & Notes

- **Concurrency:** The server uses SQLite WAL mode. Writes may fail if the DB is locked; clients are expected to retry.
- **Shared Logic:** Write operations use the shared `@mindwtr/core` library to ensure business rules are enforced.
- **Keep-Alive:** The server stays alive as long as `stdin` is open.

## Troubleshooting

- **"Command not found"**: Use `npx -y mindwtr-mcp` in MCP client configs, or install the package globally with `npm install -g mindwtr-mcp`.
- **Client Connection Issues**: Ensure you are NOT using `bun run` as the command in your MCP client config, as it may output extra text. Prefer `npx -y mindwtr-mcp`; for source checkouts, run `bun` directly on the source file or `node` on the built file.
