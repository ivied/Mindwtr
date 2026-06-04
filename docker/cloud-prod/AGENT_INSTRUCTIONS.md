# Agent instructions — deploy GTD on makurdi (current topology, 2026-06-03+)

You are a coding agent deploying changes to the production GTD stack. Production lives on **makurdi**, an always-on macOS host on Tailscale. The laptop is no longer the prod host — it only runs `capture-agent` + IDE.

If you see references to Hetzner VPS / `ssh hetzner-mfp` anywhere in this repo, treat them as **historical** — see `AGENT_INSTRUCTIONS_HETZNER_LEGACY.md`. The Hetzner deployment was planned but never went live; makurdi replaced it on 2026-06-03 (see `_bmad-output/planning-artifacts/sprint-change-proposal-2026-06-03.md` in the GTD_automation repo).

This runbook is your authoritative source. Follow it strictly.

---

## 0. Production topology snapshot

| | Where |
|---|---|
| `mindwtr-cloud`, `ai-service`, `mindwtr-app`, `cloudflared-gtd` | docker compose on makurdi, Colima VM (6 GB / 3 CPU / 20 GB) |
| OpenClaw runtime | native node on makurdi (NOT in docker) |
| `neo4j` container | makurdi, used by OpenClaw, `restart=unless-stopped` |
| Public URLs `gtd/api/ai.kurdy.uk` | CF Tunnel → cloudflared on makurdi |
| `capture-agent` | macOS launchd on the laptop, posts to `http://100.108.142.59:3030` (Tailscale magic IP) |
| `wiki/`, `shared-memory/`, DB volumes | makurdi |
| Sync OpenClaw MEMORY.md → ai-service | `crontab */5 * * * * sync-shared-memory.sh` on makurdi (reads local sqlite, no SSH) |
| Source-of-truth secrets | `/Users/makurdi/Projects/GTD_mindwtr/docker/.env` on makurdi (chmod 600) |

SSH from anywhere with the user's `~/.ssh/config` alias: `ssh openclaw`. User: `makurdi`. IP: `100.108.142.59` (Tailscale).

## 1. Inputs you can rely on

- Repository: `~/Projects/GTD_mindwtr/` on both the laptop and makurdi. Source of truth is **GitHub `ivied/Mindwtr`**.
- Production deploy = build images on makurdi from its checkout. **No CI publishes ai-service images.** Cloud + app images do have CI (`docker-image-cloud.yml`, `docker-image-app.yml`) but the makurdi deploy currently builds everything locally anyway.
- Homebrew is installed under `/opt/homebrew`. Login shells over SSH **do not** pick it up automatically — always prefix non-interactive ssh commands with `eval "$(/opt/homebrew/bin/brew shellenv)"`.
- Docker compose plugin lives at `~/.docker/cli-plugins/docker-compose` (symlinked to brew's docker-compose because Colima provides docker without the plugin).
- 1Password CLI on the laptop has the CF tunnel token (item id `op://Private/22s4c7xumwgqmdszde7jkfigkq/password` — don't use the human-readable name with `(sergey)`, `op read` chokes on the paren).

## 2. Deploy flow — three modes

### Mode A — code change to ai-service / mindwtr-cloud / mindwtr-app

Push to GitHub from wherever you edit. Then:

```bash
ssh openclaw 'eval "$(/opt/homebrew/bin/brew shellenv)"; cd ~/Projects/GTD_mindwtr && \
  git pull --ff-only origin main && \
  docker compose -f docker/compose.yaml --env-file docker/.env build <service> && \
  docker compose -f docker/compose.yaml --env-file docker/.env up -d --force-recreate <service>'
```

Replace `<service>` with one of: `ai-service`, `mindwtr-cloud`, `mindwtr-app`. For multiple, repeat or use the `--profile cf` variant below.

**Smoke check** after restart (wait ~5 s):

```bash
ssh openclaw 'eval "$(/opt/homebrew/bin/brew shellenv)"; docker logs ai-service --tail 6 2>&1 | grep -iE "listening|connected|bot|error"'
```

Expect `📡 HTTP endpoint listening on :3030` + `🚀 Bot is running` + no `GrammyError 409` (409 means a parallel ai-service is running somewhere, e.g. Docker Desktop revived on the laptop — see §4).

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
ssh openclaw 'eval "$(/opt/homebrew/bin/brew shellenv)"; cd ~/Projects/GTD_mindwtr && \
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
docker compose -f ~/Projects/GTD_mindwtr/docker/compose.yaml --profile cf down
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
ssh openclaw 'cd ~/Projects/GTD_mindwtr/docker && grep -v "^CLOUDFLARE_TUNNEL_TOKEN" .env > .env.tmp && cat >> .env.tmp && mv .env.tmp .env' <<EOF
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
- `docker compose build` fails with a TypeScript error → don't ship a broken build; ask user. (CI doesn't catch all of these because ai-service has no docker CI workflow.)
- `git pull` reports diverged branches on makurdi → ask user before resetting; the other agent (a Cursor Composer session) sometimes commits directly on makurdi without pushing.

## 8. Hand-off checklist

- [ ] Code change committed and pushed to `ivied/Mindwtr` `main`
- [ ] `ssh openclaw` from your host works without prompt
- [ ] `docker compose build <service>` succeeded
- [ ] `docker compose up -d --force-recreate <service>` succeeded
- [ ] Smoke logs show no GrammyError 409 (no laptop revival), no `Unable to connect` from extractors
- [ ] If capture-agent change: `launchctl kickstart -k gui/$UID/uk.kurdy.gtd-capture` ran and PID rotated
- [ ] If CF Tunnel touched: `https://gtd.kurdy.uk` returns 2xx within 30 s
