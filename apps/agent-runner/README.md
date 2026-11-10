# agent-runner

Runs a full agent for inbox items and reports its work to ai-service, which the
Inbox view shows live.

```
Inbox UI ──▶ ai-service (/v1/agent-runs, state + event log in context.db)
                 ▲
                 │ claim · events · finish
           agent-runner (this app, on the host) ──▶ Claude Agent SDK session
```

It runs **on the host, not in Docker**: an agent needs the real Claude Code
runtime and login, `~/.claude` sessions, repos, docker, `hermes`, and anything
else the user is signed into.

## How a run goes

1. A run is queued from the Inbox ("Разобрать Inbox агентами"), or automatically
   for every new inbox task when ai-service has `INBOX_AGENT_AUTORUN=true`.
2. The runner claims it and starts a session. Every step (text, tool call, tool
   output, subagent work) is streamed to ai-service as an event.
3. The turn ends in one of:
   - **question** — the agent called `ask_user` because it was not sure;
   - **confirm** — it called `request_confirmation` before an outward or
     irreversible action;
   - **done** — it called `report_result` with a summary, evidence and proposed
     task changes (applied only when the user accepts);
   - **stopped / error**.
4. The user's reply re-queues the run and the runner **resumes the same
   session**, so nothing is held open while the user is away. Any run can also
   be opened by hand: `cd <cwd> && claude --resume <session id>` (the UI copies
   this command).

## Outward actions

The agent has full access, but sending, publishing, deploying and deleting go
through a confirmation. The rule is in the system prompt (`src/prompt.ts`), and
`src/guard.ts` is the backstop: a `PreToolUse` hook that denies the common ways
to do those things (git push, `gh pr merge`, docker up/down, `hermes send`,
recursive `rm` outside temp dirs, write requests to external hosts, MCP tools
that send or modify). The turn that follows an explicit approval runs with the
guard lifted.

In the browser (`mcp__claude-in-chrome__*`) reading, navigating and searching
are free; page scripts and uploads always need a confirmation, and clicks, key
presses and typing are judged by the `action_summary` the agent has to give for
each of them (a click that "sends", "deletes", "pays"… is held back, so is Enter
outside a search).

The guard is a heuristic over tool names, shell text and the agent's own
description of its browser actions, not a sandbox.

## Accesses

What agents can reach beyond the machine itself is granted by the user and set
up by a second kind of run.

- A task agent that needs a service it has no access to calls `request_access`
  and stops. The card in the Inbox offers "Подключить" / "Только чтение" /
  "Не давать".
- Granting (or typing a service into "Доступы агентов") starts a **provisioning
  run**: same runner, different prompt and tools. It finds out how to connect
  (MCP server, CLI, HTTP API, SSH), sets it up, tests it with a read request,
  writes a skill under `~/.claude/skills/<name>/` and reports the access. The
  task run that asked is resumed with the news.
- A key is requested with `request_secret`: the user types it into a password
  field, ai-service holds it only until the runner claims the run, the runner
  writes it to `~/.config/gtd-agents/secrets.env` (0600) and from then on every
  agent gets it as an environment variable. Secret values are masked in
  everything the runner sends back.
- The registry (`agent_accesses` in ai-service) lists what is connected with its
  scope. Write scope makes the guard let writes to that access's hosts / MCP
  server through; read scope keeps them behind a confirmation. "Отозвать"
  removes the secrets, the MCP server and the skill from the host.
- Task agents cannot change MCP servers, skills, Claude settings or the secrets
  file (`accessConfigReason` in `src/guard.ts`); that guard is never lifted.

### Telegram

The user's personal Telegram account needs no provisioning: ai-service already
keeps its client connected, so it registers the `telegram` access itself at
startup and serves it over HTTP (`apps/ai-service/src/agent-runs/telegram-routes.ts`):

| Route | What it does |
|---|---|
| `GET /v1/telegram/chats?q=&limit=` | dialogs, newest first; `q` filters by title or username |
| `GET /v1/telegram/chats/:chat/messages?limit=&before=` | history of one chat (reading marks nothing as read) |
| `GET /v1/telegram/search?q=&chat=&limit=` | Telegram's full-text search, everywhere or in one chat |
| `POST /v1/telegram/send` `{ runId, chat, text, replyTo? }` | send plain text as the user |

`:chat` is the id from the chat list, an `@username`, or `me`.

Sending is checked on the server, not only by the guard. ai-service remembers
the confirmation the user approved for the turn in flight, and the send route
goes through only when `runId` (the agent gets it as `$AGENT_RUN_ID`) names such
a run, `text` is the approved draft and the chat is the one named in the
approved target (by id, `@username` or title). One approval sends one message;
anything else is a 403 that tells the agent to ask again.

The registry row is the switch: "Отозвать" closes every route, read scope keeps
reading and refuses sending, and asking for "Telegram" again (from a task or
from "Доступы агентов") turns it back on at once, without a provisioning run.
The skill ships with the runner (`skills/telegram/SKILL.md`) and is copied to
`~/.claude/skills/telegram/` while the access is active.

## Run

```bash
bash apps/agent-runner/install-launchd.sh   # launchd agent, reads docker/.env
# or in the foreground:
AI_SERVICE_URL=http://localhost:3030 AI_SERVICE_TOKEN=… bun run src/run.ts
```

| Variable | Default | Meaning |
|---|---|---|
| `AI_SERVICE_URL` | `http://localhost:3030` | ai-service base URL |
| `AI_SERVICE_TOKEN` | required | ai-service `HTTP_AUTH_TOKEN` |
| `MINDWTR_CLOUD_URL`, `MINDWTR_AUTH_TOKEN` | — | passed to the agent so it can look up tasks |
| `AGENT_RUNNER_CONCURRENCY` | `2` | parallel runs |
| `AGENT_RUNNER_MODEL` | Claude Code default | model for the agents |
| `AGENT_RUNNER_MAX_BUDGET_USD` | `3` | spend cap per turn, `0` = none |
| `AGENT_RUNNER_TURN_TIMEOUT_MIN` | `30` | a longer turn is parked as stopped |
| `AGENT_RUNNER_CHROME` | `true` | give agents the user's Chrome (Claude in Chrome extension; Chrome must be running) |
| `AGENT_RUNNER_TOKEN` | from `docker/.env` | runner-only token; the installer generates it |
| `AGENT_SECRETS_FILE` | `~/.config/gtd-agents/secrets.env` | where agents' long-lived secrets live |
| `AGENT_RUNNER_CWD` | `$HOME` | working directory of fresh sessions |
| `AGENT_RUNNER_NAME` | hostname | shown as the claiming runner |

ai-service side: `INBOX_AGENT_AUTORUN` (default `false`) and the daily limit.
The agents run under the Claude subscription, so the limit is a share of the
weekly quota: `AGENT_RUNS_DAILY_QUOTA_PCT` (default `10`). The runner reads the
numbers behind `/usage` before and after each turn (`src/quota.ts`, an
experimental SDK call, no tokens spent) and reports the growth; whatever the
user spends in their own sessions during a turn is counted too.
`AGENT_RUNS_DAILY_BUDGET_USD` (default `100`, the API-price estimate, not real
spend) is the backstop for when the quota cannot be read. Once either is
reached, new runs wait until tomorrow while replies to runs already started
still go through. `0` turns a limit off.

Logs: `~/Library/Logs/gtd-agent-runner/runner.log`.

## Screenshots in replies

The reply field in the Inbox zone takes images: paste from the clipboard, drop
a file, or use the image button (up to 6 per message, 8 MB each; large ones are
downscaled in the browser). ai-service keeps them in `agent_run_attachments`;
the runner downloads each one to `~/.cache/gtd-agents/attachments/<run>/`
(mode 0600) and names the paths in the message, so the agent opens them with
Read like any image file. Override the folder with `attachmentsDir` in the
runner config.
