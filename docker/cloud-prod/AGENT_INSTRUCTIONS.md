# Agent instructions — deploy GTD to Hetzner VPS

You are a coding agent tasked with deploying the GTD automation stack
(mindwtr-cloud + mindwtr-app + ai-service + cloudflared tunnel) to a
Hetzner VPS at `204.168.252.77`, exposed publicly as
`{gtd,api,ai}.kurdy.uk` via Cloudflare Tunnel.

This document is your runbook. Follow it strictly. Validate after every
step. Stop and ask the user only at the explicit `ASK USER` checkpoints
or on unexpected failure.

---

## 0. Mission

End state when you are done:

- `https://gtd.kurdy.uk` returns the Mindwtr React UI (200 OK)
- `https://api.gtd.kurdy.uk/v1/tasks?status=inbox` returns JSON with the
  user's current inbox tasks (auth required)
- `https://ai.gtd.kurdy.uk/v1/memory/stats` returns JSON
  `{events:N, facts:N, …}` (auth required)
- All four containers (`gtd-mindwtr-cloud`, `gtd-mindwtr-app`,
  `gtd-ai-service`, `gtd-cloudflared`) on the VPS report `Up (healthy)`
- The user's existing dev data (tasks, captures, memory facts) is
  visible at the public URLs (i.e. migration succeeded)
- A cron job on the user's Mac rsyncs `wiki/entities/` to the VPS every
  30 min
- The user's `capture-agent` is reconfigured to POST to
  `https://ai.gtd.kurdy.uk` instead of `localhost:3030`

---

## 1. Inputs you can rely on

- Repository: `~/Projects/GTD_mindwtr/` on the user's Mac
- Compose + helpers: `~/Projects/GTD_mindwtr/docker/cloud-prod/` (you
  read these; they exist already)
- Dev env file with existing secrets:
  `~/Projects/GTD_mindwtr/docker/.env`
- SSH to VPS: `ssh hetzner-mfp` (alias in user's `~/.ssh/config`, key
  surfaced via 1Password SSH agent)
- VPS user: `dev`, with sudo (verify in step 2)
- Cloudflare zone: `kurdy.uk` (NS: maeve/vick.ns.cloudflare.com)

## 2. Inputs you MUST get from the user

Halt and `ASK USER` for these — you cannot derive them:

1. **`CLOUDFLARE_TUNNEL_TOKEN`** — long base64 string from CF dashboard.
   You will write a precise instruction for the user in step 3.
2. Confirmation that **1Password SSH agent is unlocked** (otherwise
   `ssh hetzner-mfp` fails with "communication with agent failed").

Generate these YOURSELF (do not ask user):

3. Two `MINDWTR_CLOUD_AUTH_TOKENS` (one per device): use
   `openssl rand -hex 32`.
4. One `HTTP_AUTH_TOKEN`: same command.
5. Tell the user **what values you generated** at the end so they can
   put them in 1Password / password manager.

Copy from existing dev `.env` (don't generate new):

6. `TELEGRAM_BOT_TOKEN`, `LLM_API_KEY`, `OPENAI_API_KEY`,
   `TG_NOTIFY_CHAT_ID`, plus the user identity fields. Use
   `grep -E '^(TELEGRAM|LLM|OPENAI|TG_NOTIFY|USER_IDENTITY)='
   ~/Projects/GTD_mindwtr/docker/.env` to read them.

---

## 3. Cloudflare Tunnel — user step

The CF dashboard is GUI-only; no API workflow is available for this
agent. **Before any deploy work**, tell the user:

> Open https://one.dash.cloudflare.com → Networks → Tunnels → Create a
> tunnel.
> - Connector type: **Cloudflared** (NOT Argo, NOT Workers)
> - Name: **`gtd-prod`**
> - After clicking Save and the connector page appears: copy the
>   **TUNNEL TOKEN** (under the install instructions, looks like a long
>   `eyJhIjoi...` blob)
> - SKIP installing connector on the host — we run cloudflared in
>   docker
> - Click **Next** → **Public Hostnames** tab
> - Add three routes (Save after each):
>
> | Subdomain | Domain   | Type | URL                  |
> |-----------|----------|------|----------------------|
> | gtd       | kurdy.uk | HTTP | mindwtr-app:5173     |
> | api       | kurdy.uk | HTTP | mindwtr-cloud:8787   |
> | ai        | kurdy.uk | HTTP | ai-service:3030      |
>
> Then paste the **TUNNEL TOKEN** in the chat.

`ASK USER` for the token. Store it as `CLOUDFLARE_TUNNEL_TOKEN` for the
rest of your run.

Sanity-check after the user pastes:
```bash
dig +short gtd.kurdy.uk    # expect a CNAME to *.cfargotunnel.com
dig +short api.kurdy.uk    # same
dig +short ai.kurdy.uk     # same
```

If `dig` returns empty even 60s after the user confirms — re-prompt:
"The routes don't seem saved. Check that all three CNAME records exist
on the kurdy.uk DNS tab."

---

## 4. VPS bootstrap

```bash
ssh hetzner-mfp <<'EOSSH'
set -e
sudo mkdir -p /opt/gtd/{mindwtr-cloud-data,ai-service-data,wiki/entities,backups,src}
sudo chown -R $USER:$USER /opt/gtd
docker --version
docker compose version
EOSSH
```

Expected: docker ≥ 20, compose ≥ 2. If missing, **stop and ASK USER** —
the existing swarm-platform on this box should already have docker
installed; absence means we're on the wrong server.

---

## 5. Push compose + env scaffold to VPS

From the Mac (paths relative to user home):

```bash
scp ~/Projects/GTD_mindwtr/docker/cloud-prod/compose.prod.yaml \
    hetzner-mfp:/opt/gtd/
scp ~/Projects/GTD_mindwtr/docker/cloud-prod/.env.prod.template \
    hetzner-mfp:/opt/gtd/.env.prod
```

Then build `.env.prod` content **locally** in a tmp file (so secrets
never touch your context output):

```bash
TMP=$(mktemp)
trap "rm -f $TMP" EXIT

# Read existing dev secrets
DEV_ENV=~/Projects/GTD_mindwtr/docker/.env
TG_BOT=$(grep '^TELEGRAM_BOT_TOKEN=' $DEV_ENV | cut -d= -f2-)
LLM_KEY=$(grep '^LLM_API_KEY=' $DEV_ENV | cut -d= -f2-)
LLM_URL=$(grep '^LLM_BASE_URL=' $DEV_ENV | cut -d= -f2-)
OPENAI_KEY=$(grep '^OPENAI_API_KEY=' $DEV_ENV | cut -d= -f2-)
TG_NOTIFY=$(grep '^TG_NOTIFY_CHAT_ID=' $DEV_ENV | cut -d= -f2-)

# Generate fresh secrets
TOK1=$(openssl rand -hex 32)
TOK2=$(openssl rand -hex 32)
HTTP_TOK=$(openssl rand -hex 32)

cat > $TMP <<EOF
GHCR_OWNER=sudorous
IMAGE_TAG=latest

MINDWTR_CLOUD_AUTH_TOKENS=$TOK1,$TOK2
MINDWTR_CLOUD_CORS_ORIGIN=https://gtd.kurdy.uk

HTTP_AUTH_TOKEN=$HTTP_TOK
HTTP_CORS_ORIGINS=https://gtd.kurdy.uk

TELEGRAM_BOT_TOKEN=$TG_BOT
TG_NOTIFY_CHAT_ID=$TG_NOTIFY
USER_IDENTITY_NAME=Sergey Kurdyuk
USER_IDENTITY_ALIASES=Sergey,Сергей,Серёга,Sergey KTR

LLM_BASE_URL=$LLM_URL
LLM_API_KEY=$LLM_KEY
LLM_MODEL=cc/claude-opus-4-6

OPENAI_API_KEY=$OPENAI_KEY
OPENAI_BASE_URL=https://api.openai.com/v1
EMBEDDINGS_MODEL=text-embedding-3-small

CLOUDFLARE_TUNNEL_TOKEN=$CLOUDFLARE_TUNNEL_TOKEN

GTD_DATA_ROOT=/opt/gtd
PROACTIVE_INTERVAL_MS=21600000
CONTEXT_STORE_TTL_DAYS=7
EOF

scp $TMP hetzner-mfp:/opt/gtd/.env.prod
ssh hetzner-mfp 'chmod 600 /opt/gtd/.env.prod'
```

**Report back** to the user (only after success):

```
Generated and stored on VPS at /opt/gtd/.env.prod:
- MINDWTR_CLOUD_AUTH_TOKENS (2 tokens) = <TOK1>, <TOK2>
- HTTP_AUTH_TOKEN                       = <HTTP_TOK>

Save these in your password manager. You'll need TOK1 (for Mac
capture-agent) and HTTP_TOK (for any /v1/* curl). Don't print them
in chat history anywhere else.
```

Then `rm $TMP` (the trap should auto-clean).

---

## 6. Build images on the VPS

Push source to VPS (first time only, or after code changes):

```bash
rsync -avz \
  --exclude node_modules --exclude .git --exclude .worktrees \
  --exclude '.claude' --exclude 'docker/ai-service-data' \
  --exclude 'docker/data' \
  ~/Projects/GTD_mindwtr/ \
  hetzner-mfp:/opt/gtd/src/
```

Build images (uses `compose.prod.yaml` `image:` references but reads
build context from `/opt/gtd/src` via an inline override):

```bash
ssh hetzner-mfp <<'EOSSH'
set -e
cd /opt/gtd
cat > compose.build-override.yaml <<'OVERRIDE'
services:
  mindwtr-cloud:
    build: { context: ./src, dockerfile: docker/cloud/Dockerfile }
  mindwtr-app:
    build: { context: ./src, dockerfile: docker/app/Dockerfile }
  ai-service:
    build: { context: ./src, dockerfile: docker/ai-service/Dockerfile }
OVERRIDE
docker compose --env-file .env.prod \
  -f compose.prod.yaml -f compose.build-override.yaml \
  build --pull
EOSSH
```

Expected output ends with: `Successfully built ...` lines for all three.
If a build fails, capture the last 50 lines of `docker compose ... build`
output and report to user — likely a Dockerfile drift between dev and
the version pulled here.

---

## 7. Start the stack

```bash
ssh hetzner-mfp 'cd /opt/gtd && docker compose --env-file .env.prod -f compose.prod.yaml -f compose.build-override.yaml up -d'
sleep 10
ssh hetzner-mfp 'cd /opt/gtd && docker compose -f compose.prod.yaml ps'
```

Expected:
```
NAME                  STATUS
gtd-mindwtr-cloud     Up (healthy)
gtd-mindwtr-app       Up
gtd-ai-service        Up
gtd-cloudflared       Up
```

If any container is `Restarting` or `Exited` — read its logs:
```bash
ssh hetzner-mfp 'docker logs gtd-<service> --tail 100'
```
Common causes:
- `MINDWTR_CLOUD_AUTH_TOKENS must be set` → env not loaded; check
  `--env-file .env.prod` is in the compose command
- cloudflared `Authorization failed` → tunnel token wrong; verify with
  user
- ai-service `Context Store opened` then exits → SQLite locked; check
  data dir permissions

---

## 8. Validate public endpoints

```bash
# Read tokens you just generated (or re-read from VPS .env.prod)
TOK=$(ssh hetzner-mfp 'grep MINDWTR_CLOUD_AUTH_TOKENS /opt/gtd/.env.prod' | cut -d= -f2 | cut -d, -f1)
HTOK=$(ssh hetzner-mfp 'grep HTTP_AUTH_TOKEN /opt/gtd/.env.prod' | cut -d= -f2)

echo "=== app ==="
curl -sI https://gtd.kurdy.uk/ | head -2
echo "=== mindwtr-cloud /health ==="
curl -s https://api.gtd.kurdy.uk/health
echo "=== mindwtr-cloud auth ==="
curl -s -H "Authorization: Bearer $TOK" \
  'https://api.gtd.kurdy.uk/v1/tasks?status=inbox&limit=1' | head -c 200
echo
echo "=== ai-service ==="
curl -s -H "Authorization: Bearer $HTOK" \
  https://ai.gtd.kurdy.uk/v1/memory/stats
```

Expected:
- `HTTP/2 200` (or 302 to login) from `gtd.kurdy.uk`
- `{"ok":true}` (or similar) from `api.../health`
- JSON with `tasks` array from authenticated `/v1/tasks` (may be empty
  at this stage — that's fine, migration happens next)
- JSON with `events: 0, facts: 0` from `ai.../v1/memory/stats`

If any 502 — tunnel routes wrong. Re-check step 3 mappings (port
numbers especially: 5173, 8787, 3030).

---

## 9. Migrate data Mac → VPS

The stack is empty right now. Bring over existing dev data:

```bash
# Sanity — dev docker stack must NOT be running (would otherwise
# write to context.db mid-rsync)
docker -H unix:///var/run/docker.sock ps --filter "name=ai-service" --format '{{.Names}}' | grep -q '^ai-service$' && {
  echo "Local dev ai-service is running — stop it first"
  echo "  cd ~/Projects/GTD_mindwtr/docker && docker compose down"
  exit 1
} || true

# Run the migration script
chmod +x ~/Projects/GTD_mindwtr/docker/cloud-prod/migrate-data.sh
bash ~/Projects/GTD_mindwtr/docker/cloud-prod/migrate-data.sh
```

The script stops the VPS containers, backs up empty data dirs, rsyncs
two SQLite DBs + wiki/entities/, restarts containers.

Re-validate step 8 — now you should see real numbers:
- `/v1/tasks` returns real inbox items
- `/v1/memory/stats` returns the user's events + facts counts
  (thousands)

---

## 10. Set up wiki/entities/ sync from Mac

```bash
chmod +x ~/Projects/GTD_mindwtr/docker/cloud-prod/sync-wiki.sh

# Test the sync once
bash ~/Projects/GTD_mindwtr/docker/cloud-prod/sync-wiki.sh

# Verify on VPS
ssh hetzner-mfp 'ls /opt/gtd/wiki/entities/ | wc -l'   # expect > 100
```

Schedule it via crontab (idempotent — re-running `crontab -e` lines
don't duplicate):

```bash
# Add this line to crontab if not present
( crontab -l 2>/dev/null | grep -v 'sync-wiki.sh'
  echo "*/30 * * * * cd \$HOME/Projects/GTD_mindwtr && bash docker/cloud-prod/sync-wiki.sh >> /tmp/sync-wiki.log 2>&1"
) | crontab -

crontab -l | grep sync-wiki
```

---

## 11. Retarget capture-agent

The capture-agent runs on the Mac (not in docker, not in compose). It
reads env vars at startup. Update its environment:

`ASK USER` how they run capture-agent:
- If from Terminal.app with `bun run src/index.ts` → tell them to set
  `AI_SERVICE_BASE_URL=https://ai.gtd.kurdy.uk` and `HTTP_AUTH_TOKEN=<HTOK>`
  in their `~/.zshrc` / `~/.bash_profile` / the launch wrapper script.
- If from a `launchctl` plist → update the EnvironmentVariables key in
  the plist + `launchctl unload && launchctl load`.

Validate that the new capture-agent target is correct by checking the
first capture lands on the VPS:

```bash
# Watch VPS logs while user triggers a screen capture
ssh hetzner-mfp 'docker logs gtd-ai-service --tail 5 -f' &
# Tell user: "Make any screen change to trigger a capture, then
# press Ctrl+C in chat"
```

Expected: a `[commitment] not-actionable` or `[commitment] proposed`
line appears within 60s.

---

## 12. Stop local dev stack (optional)

```bash
cd ~/Projects/GTD_mindwtr/docker
docker compose down
```

The Mac no longer needs to run mindwtr-cloud, mindwtr-app, ai-service —
those are now in the cloud. Capture-agent and rollup-runner (the two
processes that read/write local wiki/captures/) stay running locally.

---

## 13. Final report

Tell the user:

```
✅ Deployment complete.

Public URLs:
  UI:           https://gtd.kurdy.uk
  Cloud API:    https://api.gtd.kurdy.uk
  AI Service:   https://ai.gtd.kurdy.uk

Generated secrets (stored on VPS at /opt/gtd/.env.prod, chmod 600):
  MINDWTR token #1 (Mac):   <TOK1>
  MINDWTR token #2 (phone): <TOK2>
  HTTP_AUTH_TOKEN:          <HTOK>

Capture-agent now posts to https://ai.gtd.kurdy.uk (verified live).
wiki/entities/ syncs Mac → VPS every 30 min via cron.
Backups: /opt/gtd/backups/, retain 14 days (add cron if desired).

Local dev stack stopped. To run dev locally again:
  cd ~/Projects/GTD_mindwtr/docker && docker compose up -d
  # remember to point capture-agent back at localhost first
```

---

## 14. Rollback procedure

If after deploy the user reports broken behavior:

```bash
ssh hetzner-mfp <<'EOSSH'
cd /opt/gtd
docker compose -f compose.prod.yaml down
# Restore pre-migration backup
ls -t ai-service-data.bak-*    # find most recent
mv ai-service-data ai-service-data.broken-$(date +%s)
mv ai-service-data.bak-<TIMESTAMP> ai-service-data
# Same for mindwtr-cloud-data
docker compose -f compose.prod.yaml up -d
EOSSH

# Re-point capture-agent back to localhost
# Restart local dev stack:
cd ~/Projects/GTD_mindwtr/docker && docker compose up -d
```

If rollback is needed because **the cloud stack itself is broken** and
the user wants to revert entirely — capture-agent still talks to
`https://ai.gtd.kurdy.uk` (down) until env updated. The Mac dev
ai-service `cannot` accept those captures until the agent is
re-targeted at `localhost:3030`. Tell the user this explicitly when
proposing rollback.

---

## Failure modes — when to STOP

Stop and ask the user (do NOT improvise) when:

- SSH to hetzner-mfp fails repeatedly (after one retry) — likely
  1Password SSH agent issue, only user can fix
- CF dashboard steps require any choice you can't unambiguously make
  (e.g. organization vs personal account)
- Any container won't start after 3 sequential up attempts with same
  config
- A migration step would overwrite VPS data that wasn't backed up
- The user's dev `.env` is missing a required secret

Do NOT silently proceed past these. Quote the error and `ASK USER`.

---

## Things you should NOT do

- **Don't** open ports 80/443/8787/3030/5173 on the VPS host firewall
  — cloudflared handles all ingress. Open ports are a security
  regression.
- **Don't** disable SSL verification anywhere.
- **Don't** put any tokens or secrets in commits, PRs, or chat messages
  except the final report in step 13.
- **Don't** delete existing data on the VPS without first creating a
  timestamped backup — see migrate-data.sh for the right pattern.
- **Don't** modify swarm-platform / MFP files at `/home/dev/swarm-*`
  or similar — that's the user's other project sharing this VPS.
  Confine all work to `/opt/gtd/`.
- **Don't** install new system packages on the VPS (the user pinned
  the host config; everything you need is in docker).

---

## Hand-off checklist (for the agent's own validation before declaring done)

- [ ] All 4 containers Up (healthy where applicable)
- [ ] `curl -sI https://gtd.kurdy.uk/` returns 2xx or 3xx
- [ ] Authenticated `GET /v1/tasks` returns JSON with real inbox items
- [ ] `GET /v1/memory/stats` returns events > 0, facts > 0
- [ ] First capture from Mac shows up in VPS ai-service logs within
      90 seconds of a screen change
- [ ] `crontab -l` on Mac contains the sync-wiki.sh line
- [ ] `ls /opt/gtd/wiki/entities/ | wc -l` on VPS > 100
- [ ] Generated secrets reported to user once, then never again in chat
- [ ] Local dev stack stopped (or user confirmed they want it kept)
