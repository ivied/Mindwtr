# Agent instructions — deploy GTD on makurdi (current topology, 2026-06-03+)

You are a coding agent deploying changes to the production GTD stack. Production lives on **makurdi**, an always-on macOS host on Tailscale. The laptop is no longer the prod host — it only runs `capture-agent` + IDE.

If you see references to Hetzner VPS / `ssh hetzner-mfp` anywhere, treat them as **historical**. The Hetzner deployment was planned but never went live; makurdi replaced it on 2026-06-03 (see `_bmad-output/planning-artifacts/sprint-change-proposal-2026-06-03.md` in the GTD_automation repo). The Hetzner-era kit (compose.prod.yaml, SETUP.md, VALUES.md, migrate-data.sh, the legacy runbook) was deleted 2026-06-09 — prod deploys use `docker/compose.yaml` directly.

This runbook is your authoritative source. Follow it strictly.

---

## 0. Production topology snapshot

| | Where |
|---|---|
| `mindwtr-cloud`, `ai-worker` + `ai-service` (gateway), `mindwtr-app`, `cloudflared-gtd` | docker compose on makurdi, run from `~/gtd-prod/docker`, Colima VM (6 GB / 3 CPU / 40 GB) |
| OpenClaw runtime | native node on makurdi (NOT in docker) — **deprecated as GTD runner since 2026-06-11, see §9** |
| **Hermes runtime** (GTD AI-agent runner) | native python on makurdi (NOT in docker), launchd `ai.hermes.gateway`, gateway on `:18789`. **Replaced OpenClaw as the bot that claims `@ai-agent` tasks** (2026-06-11) |
| `neo4j` container | makurdi, used by OpenClaw, `restart=unless-stopped` |
| Public URLs `gtd/api/ai.kurdy.uk` | CF Tunnel → cloudflared on makurdi |
| `capture-agent` | macOS launchd on the laptop, posts to `http://100.108.142.59:3030` (Tailscale magic IP) |
| `wiki/`, `shared-memory/`, DB volumes | makurdi |
| Sync OpenClaw MEMORY.md → ai-service | `crontab */5 * * * * sync-shared-memory.sh` on makurdi (reads local sqlite, no SSH) |
| Source-of-truth secrets | `/Users/makurdi/gtd-prod/docker/.env` on makurdi (chmod 600) |
| Production checkout | `/Users/makurdi/gtd-prod` — a clone moved only by `scripts/prod-deploy.sh`; development happens in `~/projects/GTD_mindwtr` |

SSH from anywhere with the user's `~/.ssh/config` alias: `ssh openclaw`. User: `makurdi`. IP: `100.108.142.59` (Tailscale).

## 1. Inputs you can rely on

- Repository: `~/Projects/GTD_mindwtr/` on both the laptop and makurdi. Source of truth is **GitHub `ivied/Mindwtr`**.
- Production deploy = build images on makurdi from its checkout. **No CI publishes ai-service images.** Cloud + app images do have CI (`docker-image-cloud.yml`, `docker-image-app.yml`) but the makurdi deploy currently builds everything locally anyway.
- Homebrew is installed under `/opt/homebrew`. Login shells over SSH **do not** pick it up automatically — always prefix non-interactive ssh commands with `eval "$(/opt/homebrew/bin/brew shellenv)"`.
- Docker compose plugin lives at `~/.docker/cli-plugins/docker-compose` (symlinked to brew's docker-compose because Colima provides docker without the plugin).
- 1Password CLI on the laptop has the CF tunnel token (item id `op://Private/22s4c7xumwgqmdszde7jkfigkq/password` — don't use the human-readable name with `(sergey)`, `op read` chokes on the paren).

## 2. Deploy flow — three modes

### Mode A — code change to ai-service / agent-runner / mindwtr-cloud / mindwtr-app

**Production runs from its own clone, `~/gtd-prod` on makurdi (since 2026-11-14), not from the checkout you edit.** The containers mount their sources from that clone and the agent runner starts from it. Edits in `~/projects/GTD_mindwtr` — committed or not — do not reach production until you deploy a commit:

```bash
cd ~/projects/GTD_mindwtr
scripts/prod-deploy.sh            # HEAD of this checkout
scripts/prod-deploy.sh main       # or a branch / tag / commit
scripts/prod-deploy.sh --dry-run  # what would happen
scripts/prod-deploy.sh --web      # also rebuild the web bundle (7–10 min)
```

The script moves the clone to the commit and does what the diff calls for: `bun install` when dependencies changed; typecheck + tests, then a restart of `ai-worker` and `ai-service`, when `apps/ai-service` or `packages/core` changed (`up -d` when `compose.yaml` did; an image build when dependencies or `docker/ai-service/` did); a runner restart when `apps/agent-runner` changed and no run is running or queued. A failed typecheck or test puts the clone back on the previous commit and restarts nothing. Uncommitted changes are never deployed. Never edit files in `~/gtd-prod` by hand — the script refuses to deploy over local edits there.

Everything that belongs to production lives in the clone: `docker/.env` (secrets), `docker/data` (mindwtr-cloud's data), the backup folders, and the cron / launchd jobs point at it. Run `docker compose` for production from `~/gtd-prod/docker`.

**ai-service is two containers from one image, on one database** (since 2026-11-14):

| Container | What it is |
|---|---|
| `ai-worker` | the full service (`src/index.ts`): captures, LLM pipelines, Slack/Telegram, memory, every HTTP route. Not published. |
| `ai-service` | the gateway (`src/gateway.ts`): the address everyone talks to (`:3030`, `ai.kurdy.uk`). Answers `/v1/agent-runs*`, `/v1/agent-knowledge*`, `/v1/sessions*`, `/oauth/callback` itself and forwards everything else to `ai-worker`. |

The worker does heavy work on the thread that also answers HTTP; when it was the only process the agent runner's claims timed out behind it and runs were parked as "runner lost". Now a busy worker slows the proposals UI and capture intake, not the agents. `GET /healthz` is the liveness of whichever container you ask; `GET /health` on the gateway is the worker's report (503 with `components.worker` when it is silent). Logs: `docker logs ai-worker` for almost everything, `docker logs ai-service` for agent runs. Read the database with `docker exec ai-worker …`.

Both run the TypeScript straight from the clone (`apps/ai-service/src` and `packages/core/src` are bind-mounted read-only), so a code change needs a restart, not a build — the deploy script does it. By hand:

```bash
cd ~/gtd-prod/docker && docker compose restart ai-worker ai-service
```

Rebuild the image **only** when dependencies changed (`package.json` of ai-service or core, `bun.lock`) or `docker/ai-service/Dockerfile` did (`scripts/prod-deploy.sh --build`, or `docker compose build ai-worker && docker compose up -d ai-worker ai-service`). After changing `volumes` or `environment` in compose, use `up -d` (a plain `restart` does not pick those up).

**The database** (`context.db`, a Docker volume). Vector search is a brute-force scan, so the vector tables are kept small: embeddings are stored at 512 dimensions, event vectors older than 120 days are dropped (`EVENT_VECTOR_DAYS`; the events stay and remain searchable by text), and the worker rebuilds a vector table at start when most of its slots are dead. Scans run on a worker thread (`context-store/offthread.ts`). `[slow-sql]` / `[stuck-sql]` lines in the log name statements that take over a second. To compact the file after a big cleanup: stop both containers, `docker compose run --rm --no-deps ai-worker bun run apps/ai-service/src/context-store/maintenance-cli.ts`, start them again.

**mindwtr-cloud / mindwtr-app — build, then recreate:**

```bash
ssh openclaw 'eval "$(/opt/homebrew/bin/brew shellenv)"; cd ~/gtd-prod/docker && \
  docker compose build <service> && docker compose up -d --force-recreate <service>'
```

**Rules for any build on makurdi** (8 GB Mac, 6 GB Colima VM):

- One image at a time, with nothing else heavy running (no local test stand, browser automation or second build). A parallel build has crashed the VM and taken GTD down.
- Builds starve ai-service: agent runs in flight get marked "runner lost". Check that no run is `running`/`queued` first, or accept that they will need a resume.
- Builds use BuildKit (`docker buildx`, installed 2026-11-10 as a CLI plugin in `~/.docker/cli-plugins`). Measured for ai-service: nothing changed — ~10 s; source-only change — ~2 min; cold cache — ~8 min. If `docker buildx version` fails, reinstall it (`brew install docker-buildx` and symlink the plugin) rather than falling back to the legacy builder.
- If Docker stops answering: `colima stop --force && colima start`.

**Smoke check** after restart (wait ~5 s):

```bash
ssh openclaw 'eval "$(/opt/homebrew/bin/brew shellenv)"; docker logs ai-worker --tail 6 2>&1 | grep -iE "listening|connected|bot|error"; docker logs ai-service --tail 2'
```

Expect `📡 HTTP endpoint listening on :3030` + `🚀 Bot is running` from the worker, `🚪 Gateway listening on :3030` from the gateway, and no `GrammyError 409` (409 means a parallel ai-service is running somewhere, e.g. Docker Desktop revived on the laptop — see §4).

### Mode B — capture-agent change (laptop, not docker)

Capture-agent runs as launchd job `uk.kurdy.gtd-capture` on the laptop. After editing code or env:

```bash
launchctl kickstart -k gui/$(id -u)/uk.kurdy.gtd-capture
sleep 2
launchctl list | grep uk.kurdy.gtd-capture  # should show new PID
```

Audio capture is a separate launchd app entry (`application.uk.kurdy.gtd.audio-capture.*`). It picks up env from the same `apps/capture-agent/.env.local`. Kickstart with the matching label.

`apps/capture-agent/.env.local` is **not** committed and **must include** `AGENT_ENDPOINT=http://100.108.142.59:3030` post-2026-06-03. If a fresh laptop ever runs this, copy from `1Password "GTD capture-agent env"` (or reconstruct from this doc).

### Mode C — full restart of the production stack

```bash
ssh openclaw 'eval "$(/opt/homebrew/bin/brew shellenv)"; cd ~/gtd-prod && \
  docker compose -f docker/compose.yaml --env-file docker/.env --profile cf up -d'
```

The `--profile cf` flag includes the `cloudflared-gtd` container (CF Tunnel). Drop it only if you want the stack reachable solely via Tailscale (debug).

## 3. Inputs you MUST get from the user

Halt and `ASK USER` for these — you cannot derive them:

1. **Destructive operations on production data** (volume prune, DB schema migration, `docker compose down -v`). Always confirm before running.
2. **First-time SSH to makurdi from a new agent host** — verify the user has Tailscale up and the SSH key registered. Symptom: `Host key verification failed` or `Permission denied (publickey)`.
3. **CF Tunnel token rotation**. Token currently in `docker/.env` on makurdi. If you need to refresh, ask the user to re-issue via CF dashboard, then push via `ssh openclaw 'cat >> docker/.env'` heredoc-with-stdin pattern (never pass tokens on the command line — they show in `ps`).

## 4. Common failure modes

**GrammyError 409 / "Conflict: terminated by other getUpdates request"**
A second ai-service is connected to the Telegram bot. Most common cause: Docker Desktop on the laptop auto-started old `ai-service` container. Fix:
```bash
# on laptop
docker compose -f ~/gtd-prod/docker/compose.yaml --profile cf down
```
Those containers should have been removed after the 2026-06-03 cutover. If they came back, run the down once more.

**`unknown shorthand flag: 'f'` on `docker compose`**
The Docker Compose plugin symlink in `~/.docker/cli-plugins/` is missing. Recreate:
```bash
ssh openclaw 'mkdir -p ~/.docker/cli-plugins && ln -sf /opt/homebrew/lib/docker/cli-plugins/docker-compose ~/.docker/cli-plugins/docker-compose'
```

**cloudflared: `"cloudflared tunnel run" accepts only one argument`**
`CLOUDFLARE_TUNNEL_TOKEN` in `docker/.env` got contaminated (e.g. an `[ERROR]` message replaced it). Reset:
```bash
REF='op://Private/22s4c7xumwgqmdszde7jkfigkq/password'  # item-id form, not human-readable
TOKEN=$(op read "$REF" --account ivied 2>/dev/null)
ssh openclaw 'cd ~/gtd-prod/docker && grep -v "^CLOUDFLARE_TUNNEL_TOKEN" .env > .env.tmp && cat >> .env.tmp && mv .env.tmp .env' <<EOF
CLOUDFLARE_TUNNEL_TOKEN=$TOKEN
EOF
```
Then `docker compose ... --profile cf up -d --force-recreate cloudflared`.

**ProceduralReader nukes chunks**
Symptom: `procedural_chunks` row count drops to 0 after a docker compose recreate. Cause: `shared-memory/openclaw/MEMORY.md` is missing on makurdi (e.g. crontab not running, sqlite path moved). The reader's `truncateAbove` interprets "no source file" as "delete all chunks". Don't recreate ai-service if `~/shared-memory/openclaw/MEMORY.md` is empty/missing — fix the sync first.

**Tailscale node offline on the laptop**
`capture-agent` will silently fail to post — currently no offline buffer. Captures during the offline window are lost. This is a known Phase E gap. Don't try to recover them; tell the user.

## 5. Doing capture-agent dev safely

The capture-agent code lives in `apps/capture-agent/` and is the ONE part of the codebase that runs on the laptop, not makurdi. If you're editing it via Remote-SSH on makurdi, your changes won't actually run anywhere until they're pulled into the laptop's checkout and capture-agent is kickstarted. Workflow:

1. Edit on whichever clone (laptop or makurdi) is convenient.
2. Commit + push to GitHub.
3. On the **laptop**: `git pull origin main`.
4. Kickstart launchd jobs (Mode B).

Editing capture-agent on makurdi without this dance does nothing — there is no capture-agent process running on makurdi.

## 6. Things you should NOT do

- **Don't** start a second ai-service on the laptop (Docker Desktop or otherwise). It'll grab the TG bot connection from makurdi. If a TG message disappears into the void, this is almost always the cause.
- **Don't** edit `apps/capture-agent/.env.local` on makurdi — that file only matters on the laptop. The same path on makurdi is irrelevant.
- **Don't** delete `~/shared-memory/openclaw/MEMORY.md` on makurdi. The cron rebuilds it every 5 min from OpenClaw sqlite, but if ai-service ticks before the rebuild, all procedural chunks get nuked.
- **Don't** add `restart: always` to anything that doesn't already have it without considering the Docker Desktop revive scenario above.
- **Don't** scp secrets via command-line args. Use `ssh openclaw 'cat >> .env' <<EOF \n KEY=$VALUE \n EOF` — the token never shows in `ps`.

## 7. Failure modes — when to STOP

- SSH to openclaw fails 2 times in a row → check Tailscale is up, ask user.
- `docker compose build` fails with a TypeScript error → don't ship a broken build; ask user. For ai-service nothing compiles at deploy time any more (it is restarted from the checkout), so run `bunx tsc --noEmit` and `bun test` in `apps/ai-service` before restarting it.
- `git pull` reports diverged branches on makurdi → ask user before resetting; the other agent (a Cursor Composer session) sometimes commits directly on makurdi without pushing.

## 8. Hand-off checklist

- [ ] Code change committed and pushed to `ivied/Mindwtr` `main`
- [ ] `ssh openclaw` from your host works without prompt
- [ ] `docker compose build <service>` succeeded (ai-service: typecheck + tests passed, then `restart`)
- [ ] `docker compose up -d --force-recreate <service>` succeeded
- [ ] Smoke logs show no GrammyError 409 (no laptop revival), no `Unable to connect` from extractors
- [ ] If capture-agent change: `launchctl kickstart -k gui/$UID/uk.kurdy.gtd-capture` ran and PID rotated
- [ ] If CF Tunnel touched: `https://gtd.kurdy.uk` returns 2xx within 30 s

## 9. GTD AI-agent runner — now Hermes, not OpenClaw (2026-06-11)

The bot that claims delegated `@ai-agent` tasks from the Mindwtr queue is **Hermes** (native python on makurdi, launchd `ai.hermes.gateway`). It replaced the OpenClaw runner on 2026-06-11. OpenClaw is no longer the GTD executor (its gateway is currently stopped; its internal `gtd-ai-agent-runner` cron and the external `gtd-runner-gate.sh` crontab entry were both retired).

> **2026-11-09:** `hermes cron list` no longer shows the `GTD AI-agent runner` job described below (the gate script and secrets are still on disk). Until it is re-created, nothing claims `ai-target:openclaw` tasks. Inbox items are handled by agent runs instead — see §10.

**How it works (cheap pre-check, no idle LLM spend):**
- Hermes cron job `GTD AI-agent runner` (`hermes cron list`, id `5a4912273ca5`), schedule `*/5 * * * *`, `--script gtd-gate.sh` (default mode: script stdout is injected into the agent prompt).
- `~/.hermes/scripts/gtd-gate.sh` is a pure-shell gate: it lists `@ai-agent` + `ai-stage:queued` tasks (excluding `locked-by:*` and `ai-target:mac*`), and:
  - **empty queue → prints nothing → Hermes skips the LLM entirely** (zero cost on the ~95% empty ticks),
  - **claimable task → prints the runner instructions + task payload** → Hermes runs one turn: claim (`ai-stage:doing` + `locked-by:hermes`) → do the work → PATCH `ai-stage:review` (or `ai-stage:error`).
- Secrets: `~/.hermes/secrets/gtd-runner.env` (chmod 600) holds `MINDWTR_CLOUD_TOKEN` + `MINDWTR_CLOUD_URL`. Copied from `~/.openclaw/openclaw.json` `env.vars.MINDWTR_CLOUD_TOKEN`; rotate both if the cloud token changes.

**Routing tags unchanged:** tasks still carry `ai-target:openclaw` (historical name). The Hermes gate claims everything that is *not* `ai-target:mac*`, so the tag was intentionally NOT renamed — no ai-service code/deploy change was needed. `ai-target:mac*` tasks stay reserved for the separate local Mac agent.

**Don't run two bots on one queue.** If OpenClaw's gateway is ever restarted, disable its `gtd-ai-agent-runner` cron (`openclaw cron disable gtd-ai-agent-runner`) so it doesn't race Hermes for the same `ai-stage:queued` tasks.

**Debug:**
- `hermes cron list` / `hermes cron run 5a4912273ca5` then `hermes cron tick` to force a run.
- Manual gate check: `env -i HOME="$HOME" PATH="/usr/bin:/bin" bash ~/.hermes/scripts/gtd-gate.sh` (prints the prompt on stdout when work exists; diagnostics on stderr).

## 10. Inbox agent runs (2026-11-09)

A full agent per inbox item, with its work visible in the Inbox view. Separate from the `@ai-agent` tag queue of §9.

| Part | Where |
|---|---|
| State + event log, API `/v1/agent-runs/*` | `ai-service` (`src/agent-runs/`, tables `agent_runs*` in `context.db`) |
| Executor | `apps/agent-runner` — **native on makurdi**, launchd `uk.kurdy.gtd-agent-runner`, Claude Agent SDK |
| UI | `apps/desktop/src/components/agent-runs/` — zone at the top of Inbox |

- Install / reinstall the runner: `bash apps/agent-runner/install-launchd.sh` (reads `docker/.env`). Logs: `~/Library/Logs/gtd-agent-runner/runner.log`.
- `INBOX_AGENT_AUTORUN=true` in `docker/.env` → every new inbox task gets an agent run **instead of** the Enricher suggestion. Default `false`: runs start from the UI button.
- `AGENT_RUNS_DAILY_QUOTA_PCT` (default 10, percent of the weekly subscription quota, measured by the runner) holds back new runs once reached; `AGENT_RUNS_DAILY_BUDGET_USD` (default 100, API-price estimate) is the backstop; per-turn cap and model are runner settings (`apps/agent-runner/README.md`).
- The UI shows "раннер не на связи" when the runner has not polled for 30 s. A run whose runner dies is parked as `stopped` after 3 min and can be resumed from the UI.
- **Accesses** (2026-11-10): agents ask for access to external services (`request_access`); granting starts a provisioning run that connects it and registers it in `agent_accesses`. Keys go UI → ai-service (held until claimed) → runner → `~/.config/gtd-agents/secrets.env` on makurdi. List / revoke: "Доступы агентов" in the Inbox zone. Details: `apps/agent-runner/README.md`.
- `AGENT_RUNNER_TOKEN` in `docker/.env` (generated by the installer) protects the runner endpoints; ai-service and the runner must share it — after it changes, recreate `ai-service` and rerun the installer.
- **Telegram and the assistant chat** (2026-11-10): ai-service serves the user's personal Telegram to agents (`/v1/telegram/*`; sending only with an approved confirmation, checked on the server) and a group where agents ask the user's human assistant through the bot (`/v1/assistant/*`, no confirmation). Both are rows in `agent_accesses` (`telegram`, `assistant`) with skills shipped in `apps/agent-runner/skills/`. The assistant group is created or rebound with `POST /v1/assistant/setup` (needs `x-runner-token`). Details: `apps/agent-runner/README.md`.
- **Sessions on the user's other computers** (2026-11-12): a dispatcher on the user's laptop (launchd `uk.kurdy.gtd-session-dispatch` there, three files copied from `apps/agent-runner/src`) sends cards of the Claude Code sessions to ai-service (`/v1/sessions/*`, tables `agent_sessions`, `agent_delegations`) and passes goals from inbox agents into them; access row `sessions`, skill in `apps/agent-runner/skills/sessions/`. It does **not** read the checkout: after changing `session-index.ts`, `session-dispatch.ts` or `dispatch.ts`, rerun `bash apps/agent-runner/install-dispatcher.sh user@laptop` (the laptop needs Remote Login and this host's SSH key; it reaches ai-service over Tailscale). The session acts under its own permissions — the runner's guard does not apply there. Details: `apps/agent-runner/README.md`.
- Deploy order for changes here: `ai-service` (Mode A: restart) → `mindwtr-app` (Mode A: build) → `launchctl kickstart -k gui/$(id -u)/uk.kurdy.gtd-agent-runner`. Restart the runner only when no run is `running` or `queued` (check and restart in one command) — a restart kills the turns in flight.
