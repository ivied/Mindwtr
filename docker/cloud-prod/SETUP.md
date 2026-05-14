# Cloud deployment — Hetzner VPS + Cloudflare Tunnel

Target: 204.168.252.77 (existing Hetzner box, shared with swarm-platform).
Domain: gtd.kurdy.uk (Cloudflare-hosted).

## Architecture

```
[Mac]                                  [Hetzner VPS 204.168.252.77]
capture-agent  ── HTTPS ──┐
                          │
[phone PWA]    ── HTTPS ──┼──→ Cloudflare edge ──→ cloudflared (container)
                          │                          ↓ docker bridge
[other browser]── HTTPS ──┘                       mindwtr-app:5173
                                                  mindwtr-cloud:8787
                                                  ai-service:3030

DNS:  gtd.kurdy.uk      → CNAME *.cfargotunnel.com → mindwtr-app:5173
      api.gtd.kurdy.uk  → "                      "  → mindwtr-cloud:8787
      ai.gtd.kurdy.uk   → "                      "  → ai-service:3030
```

No inbound ports open on the VPS firewall. Cloudflared maintains an
outbound persistent connection to Cloudflare's edge.

---

## Step 0 — Prerequisites on your Mac

You should already have:
- SSH access to `hetzner-mfp` (`ssh hetzner-mfp 'uname -a'` works)
- Cloudflare account that owns kurdy.uk
- GitHub account that can push images to `ghcr.io/<your-handle>/*`
  (optional but recommended for clean deploys; alternatively build on
  VPS)

---

## Step 1 — Prep VPS

```bash
ssh hetzner-mfp

# Make sure docker + compose are available (they should be — swarm uses them)
docker --version
docker compose version

# Create the data root (this is where all persistent state lives)
sudo mkdir -p /opt/gtd/{mindwtr-cloud-data,ai-service-data,wiki/entities}
sudo chown -R "$USER:$USER" /opt/gtd
```

---

## Step 2 — Cloudflare Tunnel

Open the Cloudflare Zero Trust dashboard
([one.dash.cloudflare.com](https://one.dash.cloudflare.com)) →
**Networks → Tunnels → Create a tunnel** → Connector type **Cloudflared**.

1. Name: `gtd-prod`
2. After creating, copy the **token** (long base64 blob). You'll paste
   it into `.env.prod` below as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Skip the "install connector" page — we run cloudflared inside our
   docker-compose, not as a host service.
4. Click **Next** → **Public Hostnames** tab. Add three routes:

| Subdomain | Domain | Service |
|---|---|---|
| `gtd` | `kurdy.uk` | `http://mindwtr-app:5173` |
| `api` | `kurdy.uk` | `http://mindwtr-cloud:8787` |
| `ai` | `kurdy.uk` | `http://ai-service:3030` |

CF will create the corresponding CNAMEs automatically. Verify on the
**DNS** tab of the kurdy.uk zone — you should see three new orange-cloud
CNAME records pointing at `<tunnel-uuid>.cfargotunnel.com`.

---

## Step 3 — Copy compose + env to VPS

From your Mac:

```bash
# Copy compose + helper scripts to /opt/gtd on the VPS
scp docker/cloud-prod/compose.prod.yaml hetzner-mfp:/opt/gtd/
scp docker/cloud-prod/.env.prod.template hetzner-mfp:/opt/gtd/

ssh hetzner-mfp
cd /opt/gtd
cp .env.prod.template .env.prod
chmod 600 .env.prod
vim .env.prod    # fill in all the CHANGEME / empty values
```

Required secrets (the compose will refuse to start without them):

- `MINDWTR_CLOUD_AUTH_TOKENS` — generate two strong tokens
  (`openssl rand -hex 32`), one for the Mac, one for the phone.
- `HTTP_AUTH_TOKEN` — one strong token for AI Service.
- `TELEGRAM_BOT_TOKEN` — copy from your existing dev `.env`.
- `LLM_API_KEY` — copy from existing dev `.env`.
- `OPENAI_API_KEY` — copy from existing dev `.env`.
- `CLOUDFLARE_TUNNEL_TOKEN` — from Step 2.

---

## Step 4 — Build/pull images

### Option A: Build on VPS (simplest for v1)

```bash
# On your Mac
rsync -avz --exclude node_modules --exclude .git --exclude .worktrees \
  ~/Projects/GTD_mindwtr/ hetzner-mfp:/opt/gtd/src/

# On VPS
ssh hetzner-mfp
cd /opt/gtd
docker compose -f compose.prod.yaml -f - <<'EOF' build
services:
  mindwtr-cloud:
    build: { context: ./src, dockerfile: docker/cloud/Dockerfile }
  mindwtr-app:
    build: { context: ./src, dockerfile: docker/app/Dockerfile }
  ai-service:
    build: { context: ./src, dockerfile: docker/ai-service/Dockerfile }
EOF
```

(Or just edit compose.prod.yaml to add `build:` blocks to each service
and remove `image: ghcr.io/...` lines.)

### Option B: GitHub Container Registry (clean, recommended later)

Set up `.github/workflows/build-cloud-images.yml` that builds + pushes
to `ghcr.io/<your-handle>/gtd-automation-{cloud,app,ai-service}:latest`
on push to main. VPS just runs `docker compose pull && up -d`.
Out of scope for this initial deploy — Option A first.

---

## Step 5 — Start the stack

```bash
ssh hetzner-mfp
cd /opt/gtd
docker compose -f compose.prod.yaml up -d
docker compose -f compose.prod.yaml logs -f
```

Watch for:

- `📚 Context Store opened` from ai-service
- `🧠 Memory module enabled` from ai-service
- `Connection registered` from cloudflared

Then verify:

```bash
# From your Mac, hit each route via the public URL
curl -sI https://gtd.kurdy.uk/                                # 200
curl -sH "Authorization: Bearer $MINDWTR_TOKEN" \
  https://api.gtd.kurdy.uk/v1/tasks?limit=1                   # JSON
curl -sH "Authorization: Bearer $HTTP_AUTH_TOKEN" \
  https://ai.gtd.kurdy.uk/v1/memory/stats                     # JSON
```

If any return 502 — check `docker compose logs -f <service>` and the
tunnel's "Health" tab in the CF dashboard.

---

## Step 6 — Migrate data from Mac → VPS (one-time)

This brings your existing dev data (tasks, captures, memory) over so the
production stack picks up where dev left off.

```bash
# On your Mac
bash docker/cloud-prod/migrate-data.sh
```

The script stops the VPS containers, backs up any existing data, rsyncs
both DBs + wiki/entities/, restarts. Idempotent (safe to re-run).

---

## Step 7 — Schedule wiki sync from Mac

`wiki/entities/*.md` is generated by the local rollup-runner on your
Mac. The cloud ai-service needs them for the persons registry + slug
canonicalizer. Set up a cron / launchd that runs every ~30 min:

```bash
# On your Mac
chmod +x docker/cloud-prod/sync-wiki.sh

# crontab -e
# Every 30 minutes:
*/30 * * * * cd $HOME/Projects/GTD_mindwtr && \
  bash docker/cloud-prod/sync-wiki.sh \
  >> /tmp/sync-wiki.log 2>&1
```

Verify on the VPS after first run:

```bash
ssh hetzner-mfp 'ls /opt/gtd/wiki/entities/ | wc -l'   # should be > 0
```

---

## Step 8 — Retarget capture-agent

Edit your capture-agent local env (wherever you run it — Terminal.app):

```bash
# Old (dev):
# AI_SERVICE_BASE_URL=http://localhost:3030

# New (prod):
AI_SERVICE_BASE_URL=https://ai.gtd.kurdy.uk
HTTP_AUTH_TOKEN=<the same token from .env.prod>
```

Restart the agent. Captures now go to the cloud ai-service.

> **NOTE:** capture-agent currently has no retry queue — if the network
> blips, the capture is dropped (the local wiki/captures/*.md still
> persists). Adding a retry queue is a separate task (see issue tracker).
> For now, the local wiki on the Mac is the source of truth; the cloud
> events table is the searchable index.

---

## Step 9 — Stop the local dev stack

```bash
# On your Mac
cd ~/Projects/GTD_mindwtr/docker
docker compose down                 # stops dev mindwtr-cloud, mindwtr-app, ai-service
```

Capture-agent stays running (it's a separate process, not in compose).

You can keep the local compose around for offline testing — just don't
run it concurrently with prod, since the LLM proxy / TG bot don't
multiplex.

---

## Operational notes

### Backups

Add to your VPS crontab:

```cron
# Daily 04:00 — backup both SQLite DBs to a tarball
0 4 * * * tar czf /opt/gtd/backups/gtd-$(date +\%F).tar.gz -C /opt/gtd mindwtr-cloud-data ai-service-data && \
          find /opt/gtd/backups -name 'gtd-*.tar.gz' -mtime +14 -delete
```

For off-server backups, add `rsync /opt/gtd/backups/ <your-mac>:~/gtd-backups/`
or push to Backblaze B2 ($0.005/GB/mo).

### Logs

```bash
# Tail live
ssh hetzner-mfp 'cd /opt/gtd && docker compose -f compose.prod.yaml logs -f --tail 100 ai-service'

# Last 1000 lines of all services
ssh hetzner-mfp 'cd /opt/gtd && docker compose -f compose.prod.yaml logs --tail 1000'
```

### Update cycle

```bash
# Edit code locally, test, commit
# Then on VPS:
ssh hetzner-mfp
cd /opt/gtd/src && git pull
cd /opt/gtd && docker compose -f compose.prod.yaml build && docker compose -f compose.prod.yaml up -d
```

~30 seconds for an incremental build.

### Rollback

```bash
ssh hetzner-mfp
cd /opt/gtd
docker compose -f compose.prod.yaml down
mv ai-service-data ai-service-data.broken
mv ai-service-data.bak-<TIMESTAMP> ai-service-data
docker compose -f compose.prod.yaml up -d
```

---

## Troubleshooting

**"502 Bad Gateway" from any subdomain:**
- Service didn't start. `docker compose logs <name>`.
- Route in CF dashboard points at wrong port. Re-check Step 2.

**capture-agent gets 401 from /v1/capture:**
- `HTTP_AUTH_TOKEN` mismatch between Mac env and VPS `.env.prod`.

**PWA can't load gtd.kurdy.uk:**
- Likely CORS. Check `MINDWTR_CLOUD_CORS_ORIGIN` matches the exact
  hostname (no trailing slash, `https://` prefix).

**Mindwtr-app shows blank page:**
- Run-time URL injection didn't happen. The image's nginx
  entrypoint may need `MINDWTR_CLOUD_URL_RUNTIME` template support.
  Check `docker exec mindwtr-app cat /usr/share/nginx/html/config.js`.
  If the URL isn't there — rebuild image with `MINDWTR_CLOUD_URL`
  baked at build time instead of runtime.

**Tunnel marked unhealthy in CF dashboard:**
- cloudflared can't reach the upstream container. Check they're on the
  same `gtd-prod` network (`docker network inspect gtd-prod_gtd-prod`).
- Token expired or rotated. Regenerate in CF, update `.env.prod`,
  `docker compose restart cloudflared`.
