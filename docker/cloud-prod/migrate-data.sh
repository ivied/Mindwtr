#!/usr/bin/env bash
# migrate-data.sh — one-time copy of dev DB → production VPS.
# Run on the Mac AFTER cloud stack is up but BEFORE you point capture-agent
# at the production URL.
#
# What this moves:
#   • mindwtr-cloud SQLite data (tasks, projects, areas) — from
#     docker/data/ on Mac → /opt/gtd/mindwtr-cloud-data/ on VPS.
#   • ai-service context.db (Context Store + memory module + proposals) —
#     from docker/ai-service-data/ → /opt/gtd/ai-service-data/.
#   • Initial wiki/entities/ snapshot via sync-wiki.sh.
#
# Safe to re-run: it stops the VPS containers first (so no concurrent
# writes), copies, restarts. Existing VPS data is BACKED UP with a
# timestamp suffix before being overwritten.

set -euo pipefail

LOCAL_DOCKER_DIR="${LOCAL_DOCKER_DIR:-$HOME/Projects/GTD_mindwtr/docker}"
VPS_HOST="${VPS_HOST:-hetzner-mfp}"
VPS_DATA_ROOT="${VPS_DATA_ROOT:-/opt/gtd}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/gtd/compose.prod.yaml}"

if [[ ! -d "$LOCAL_DOCKER_DIR/data" || ! -d "$LOCAL_DOCKER_DIR/ai-service-data" ]]; then
  echo "ERROR: local docker data dirs missing at $LOCAL_DOCKER_DIR." >&2
  exit 1
fi

ts=$(date +%Y%m%d-%H%M%S)
echo "Step 1/4: Stopping VPS containers for safe DB copy"
ssh "$VPS_HOST" "cd /opt/gtd && docker compose -f compose.prod.yaml stop mindwtr-cloud ai-service" || true

echo "Step 2/4: Backing up existing VPS data (if any)"
ssh "$VPS_HOST" "
  set -e
  cd $VPS_DATA_ROOT
  [ -d mindwtr-cloud-data ] && cp -a mindwtr-cloud-data mindwtr-cloud-data.bak-$ts || true
  [ -d ai-service-data ]    && cp -a ai-service-data    ai-service-data.bak-$ts    || true
"

echo "Step 3/4: Copying Mac → VPS"
# mindwtr-cloud
rsync -avz --progress \
  "$LOCAL_DOCKER_DIR/data/" \
  "$VPS_HOST:$VPS_DATA_ROOT/mindwtr-cloud-data/"
# ai-service (context.db is the big one)
rsync -avz --progress \
  "$LOCAL_DOCKER_DIR/ai-service-data/" \
  "$VPS_HOST:$VPS_DATA_ROOT/ai-service-data/"

echo "Step 4/4: Initial wiki/entities/ sync"
WIKI_SRC="$HOME/Projects/GTD_automation/wiki" \
  VPS_HOST="$VPS_HOST" \
  VPS_PATH="$VPS_DATA_ROOT/wiki" \
  "$(dirname "$0")/sync-wiki.sh"

echo "Step 5/4: Restart VPS containers"
ssh "$VPS_HOST" "cd /opt/gtd && docker compose -f compose.prod.yaml up -d"

echo
echo "✅ Migration done. Verify with:"
echo "   curl -sH 'Authorization: Bearer \$HTTP_AUTH_TOKEN' https://ai.gtd.kurdy.uk/v1/memory/stats"
echo "   curl -sH 'Authorization: Bearer \$MINDWTR_AUTH_TOKEN' https://api.gtd.kurdy.uk/v1/tasks?status=inbox&limit=1"
