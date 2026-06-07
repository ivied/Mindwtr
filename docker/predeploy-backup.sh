#!/usr/bin/env bash
# predeploy-backup.sh — safe online backup of ai-service context.db.
#
# Run BEFORE every `docker compose ... up -d --force-recreate ai-service`.
#
# Why this exists: context.db has been corrupted twice during deploys. Root
# cause is SQLite WAL (mmap + file locks) being unreliable when the DB is
# touched concurrently across the Colima virtiofs VM↔host boundary. The DB now
# lives in a Docker named volume (ext4 in the VM), so the ONLY safe way to read
# it is from inside the container. This script does exactly that:
#   1. `.backup` via the running container (same SQLite lib that owns the file,
#      no host-side reader, consistent snapshot even while writes continue).
#   2. integrity_check the snapshot — abort if not "ok".
#   3. `docker cp` the verified snapshot out to a host backup dir.
#   4. rotate: keep the newest N backups.
#
# Never open the DB file from macOS while the container is running.

set -euo pipefail

CONTAINER="${CONTAINER:-ai-service}"
DB_PATH="${DB_PATH:-/app/data/context.db}"
BACKUP_DIR="${BACKUP_DIR:-$(cd "$(dirname "$0")" && pwd)/ai-service-backups}"
KEEP="${KEEP:-10}"

ts=$(date +%Y%m%d-%H%M%S)
snap_in_container="/app/data/context.db.predeploy-$ts"
host_out="$BACKUP_DIR/context.db.predeploy-$ts"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running — nothing to back up." >&2
  echo "       (If it's down because the DB is broken, restore from $BACKUP_DIR.)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

echo "Step 1/4: online .backup inside container ($CONTAINER:$DB_PATH)"
# bun:sqlite ships an sqlite3-compatible API; use the bundled bun to run a tiny
# script so we don't depend on a sqlite3 CLI being present in the image.
docker exec "$CONTAINER" bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('$DB_PATH', { readonly: true });
  db.exec(\"VACUUM INTO '$snap_in_container'\");
  db.close();
  console.log('snapshot written');
"

echo "Step 2/4: integrity_check the snapshot"
result=$(docker exec "$CONTAINER" bun -e "
  const { Database } = require('bun:sqlite');
  const db = new Database('$snap_in_container', { readonly: true });
  const r = db.query('PRAGMA integrity_check').get();
  db.close();
  process.stdout.write(Object.values(r)[0]);
")
if [[ "$result" != "ok" ]]; then
  echo "ERROR: snapshot integrity_check failed: $result" >&2
  docker exec "$CONTAINER" rm -f "$snap_in_container" || true
  exit 1
fi
echo "  integrity: ok"

echo "Step 3/4: copy snapshot to host ($host_out)"
docker cp "$CONTAINER:$snap_in_container" "$host_out"
# Remove the in-container snapshot so the volume doesn't accumulate copies.
docker exec "$CONTAINER" rm -f "$snap_in_container" || true

echo "Step 4/4: rotate (keep newest $KEEP)"
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/context.db.predeploy-* 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "  removing old backup: $(basename "$old")"
  rm -f "$old"
done

echo
echo "✅ Backup ready: $host_out"
echo "   Restore (container stopped) with:"
echo "     docker run --rm -v ai-service-data:/data -v \"$BACKUP_DIR\":/bak alpine \\"
echo "       sh -c 'cp /bak/$(basename "$host_out") /data/context.db && rm -f /data/context.db-wal /data/context.db-shm'"
