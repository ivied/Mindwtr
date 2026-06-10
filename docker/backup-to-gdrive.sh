#!/usr/bin/env bash
# backup-to-gdrive.sh — nightly offsite backup of GTD prod data to Google Drive.
#
# Backs up two things:
#   1. ai-service context.db — snapshot taken INSIDE the running container
#      (VACUUM INTO + integrity_check), same approach as predeploy-backup.sh.
#      Never reads the live DB file from the host (corrupted it twice before).
#   2. mindwtr-cloud data blob(s) — docker/data/*.json. Written atomically by
#      the server (tmp+rename), so a host-side copy is consistent; we still
#      validate each copy parses as JSON before shipping.
#
# Ships gzipped, date-stamped files to $RCLONE_REMOTE_DIR and prunes remote
# copies older than $KEEP_DAYS. Writes $STATE_FILE with the last success
# timestamp so health checks can alert on stale backups.
#
# Intended to run from cron, e.g. daily at 04:30:
#   30 4 * * * /bin/bash <repo>/docker/backup-to-gdrive.sh >> /tmp/gtd-backup.log 2>&1

set -euo pipefail

CONTAINER="${CONTAINER:-ai-service}"
CLOUD_CONTAINER="${CLOUD_CONTAINER:-mindwtr-cloud}"
DB_PATH="${DB_PATH:-/app/data/context.db}"
# Cloud data is a bind-mount of the checkout the stack was started from —
# resolve it from the live container instead of assuming this script's
# checkout is that one (it may run from a worktree).
CLOUD_DATA_DIR="${CLOUD_DATA_DIR:-$(docker inspect "$CLOUD_CONTAINER" \
  --format '{{range .Mounts}}{{if eq .Destination "/app/cloud_data"}}{{.Source}}{{end}}{{end}}')}"
RCLONE_REMOTE_DIR="${RCLONE_REMOTE_DIR:-gdrive:GTD-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STATE_FILE="${STATE_FILE:-$HOME/.gtd-backup-last-success}"

ts=$(date +%Y%m%d-%H%M%S)
workdir=$(mktemp -d /tmp/gtd-backup-XXXXXX)
trap 'rm -rf "$workdir"' EXIT

echo "[$ts] backup starting (remote: $RCLONE_REMOTE_DIR, keep: ${KEEP_DAYS}d)"

# --- 1. context.db snapshot inside the container ---------------------------
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running" >&2
  exit 1
fi

snap_in_container="/app/data/context.db.gdrive-$ts"
docker exec "$CONTAINER" bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB_PATH', { readonly: true });
  db.exec(\"VACUUM INTO '$snap_in_container'\");
  db.close();
"
integrity=$(docker exec "$CONTAINER" bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('$snap_in_container', { readonly: true });
  process.stdout.write(Object.values(db.query('PRAGMA integrity_check').get())[0]);
")
if [[ "$integrity" != "ok" ]]; then
  docker exec "$CONTAINER" rm -f "$snap_in_container" || true
  echo "ERROR: context.db snapshot integrity_check failed: $integrity" >&2
  exit 1
fi
docker cp "$CONTAINER:$snap_in_container" "$workdir/context.db"
docker exec "$CONTAINER" rm -f "$snap_in_container" || true
gzip "$workdir/context.db"
echo "  context.db snapshot ok ($(du -h "$workdir/context.db.gz" | cut -f1 | tr -d ' '))"

# --- 2. mindwtr-cloud data blobs -------------------------------------------
cloud_count=0
for f in "$CLOUD_DATA_DIR"/*.json; do
  [[ -e "$f" ]] || continue
  name=$(basename "$f")
  cp "$f" "$workdir/cloud-$name"
  if ! jq -e . "$workdir/cloud-$name" > /dev/null 2>&1; then
    echo "ERROR: cloud data copy is not valid JSON: $name" >&2
    exit 1
  fi
  gzip "$workdir/cloud-$name"
  cloud_count=$((cloud_count + 1))
done
if [[ "$cloud_count" -eq 0 ]]; then
  echo "ERROR: no cloud data blobs found in $CLOUD_DATA_DIR" >&2
  exit 1
fi
echo "  cloud data: $cloud_count blob(s) ok"

# --- 3. ship to Google Drive ------------------------------------------------
dest="$RCLONE_REMOTE_DIR/$ts"
rclone copy "$workdir" "$dest" --transfers 2 --retries 3
echo "  uploaded to $dest"

# --- 4. prune old remote backups + verify today's upload exists -------------
rclone delete "$RCLONE_REMOTE_DIR" --min-age "${KEEP_DAYS}d" --rmdirs 2>/dev/null || \
  rclone delete "$RCLONE_REMOTE_DIR" --min-age "${KEEP_DAYS}d" || true
rclone rmdirs "$RCLONE_REMOTE_DIR" --leave-root 2>/dev/null || true

uploaded=$(rclone lsf "$dest" | wc -l | tr -d ' ')
expected=$((cloud_count + 1))
if [[ "$uploaded" -ne "$expected" ]]; then
  echo "ERROR: remote verification failed: expected $expected files, found $uploaded" >&2
  exit 1
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$STATE_FILE"
echo "✅ backup complete: $expected files in $dest"
echo
echo "Restore context.db (container stopped):"
echo "  rclone copy $dest/context.db.gz /tmp/ && gunzip /tmp/context.db.gz"
echo "  docker run --rm -v ai-service-data:/data -v /tmp:/bak alpine \\"
echo "    sh -c 'cp /bak/context.db /data/context.db && rm -f /data/context.db-wal /data/context.db-shm'"
