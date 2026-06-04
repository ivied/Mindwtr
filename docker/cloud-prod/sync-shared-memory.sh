#!/usr/bin/env bash
# sync-shared-memory.sh — mirror OpenClaw's procedural memory into the
# shared-memory dir consumed by ai-service (FR85, Phase 0).
#
# Why this is not a plain cp of *.md files:
#   OpenClaw stores its memory (MEMORY.md, daily journals) as `chunks`
#   rows inside ~/.openclaw/memory/main.sqlite. There is no .md file on
#   disk — the markdown is virtual. We run a sqlite SELECT, reassemble
#   the chunks by start_line, and write the reconstructed markdown to
#   our local mirror. Lines that appear in two overlapping adjacent
#   chunks (OpenClaw's chunking has a small overlap window for retrieval
#   quality) are deduplicated on the consecutive-line level — good
#   enough since our downstream chunker re-splits on `##` anyway.
#
# Deployment topology (2026-06-03):
#   ai-service runs on makurdi alongside OpenClaw → no SSH hop, sqlite
#   is read directly from the local filesystem. If OPENCLAW_LOCAL=false
#   the script falls back to the legacy SSH path (used e.g. when running
#   sync from a different host, or for migration / disaster recovery).
#
# Schedule (on makurdi):
#   */5 * * * * bash /path/to/sync-shared-memory.sh \
#     >> /tmp/sync-shared-memory.log 2>&1
#
# Idempotent — overwrites the target file each tick. Heartbeat file at
# $SHARED_MEMORY_DEST/.last-sync lets cron-monitoring confirm aliveness.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────
# Default to local sqlite reads — ai-service + OpenClaw co-located on
# makurdi since the 2026-06-03 deployment topology change.
OPENCLAW_LOCAL="${OPENCLAW_LOCAL:-true}"
OPENCLAW_HOST="${OPENCLAW_HOST:-openclaw}"
OPENCLAW_DB_PATH="${OPENCLAW_DB_PATH:-$HOME/.openclaw/memory/main.sqlite}"
SHARED_MEMORY_DEST="${SHARED_MEMORY_DEST:-$HOME/shared-memory}"

# Phase 0 scope: top-level MEMORY.md only. Whitespace-separated list of
# `path` values to extract. Bump when Phase 0.5 widens to journals/.
SOURCE_PATHS="${SOURCE_PATHS:-MEMORY.md}"

DEST_SOURCE_DIR="$SHARED_MEMORY_DEST/openclaw"
mkdir -p "$DEST_SOURCE_DIR"

# Dump chunks for one path. Args: $1 = path inside OpenClaw db.
# Order by start_line so the reconstructed markdown preserves the
# original section order. `awk '!seen[$0]++'` deduplicates exact
# repeated lines across the overlap window without disturbing order.
dump_chunks() {
  local src_path="$1"
  if [[ "${OPENCLAW_LOCAL}" == "true" ]]; then
    sqlite3 -separator '' "${OPENCLAW_DB_PATH}" \
      "SELECT text FROM chunks WHERE path='${src_path}' ORDER BY start_line ASC;"
  else
    ssh -o BatchMode=yes -o ConnectTimeout=10 "${OPENCLAW_HOST}" \
      "sqlite3 -separator '' \"${OPENCLAW_DB_PATH#\$HOME/}\" \
         \"SELECT text FROM chunks WHERE path='${src_path}' ORDER BY start_line ASC;\""
  fi
}

# ─── Dump each path's chunks into the corresponding local file ───────
for src_path in $SOURCE_PATHS; do
  source_label=$([[ "${OPENCLAW_LOCAL}" == "true" ]] && echo "local:${OPENCLAW_DB_PATH}" || echo "${OPENCLAW_HOST}:${OPENCLAW_DB_PATH}")
  echo "[$(date -u +%FT%TZ)] Dumping ${source_label} path='${src_path}' → ${DEST_SOURCE_DIR}/${src_path}"

  dump_chunks "${src_path}" \
    | awk '!seen[$0]++' \
    > "${DEST_SOURCE_DIR}/${src_path}.new"

  # Atomic swap so the reader never sees a half-written file.
  mv "${DEST_SOURCE_DIR}/${src_path}.new" "${DEST_SOURCE_DIR}/${src_path}"
  echo "[$(date -u +%FT%TZ)] Wrote ${DEST_SOURCE_DIR}/${src_path} ($(wc -l < "${DEST_SOURCE_DIR}/${src_path}") lines)"
done

# Heartbeat for cron monitoring.
date -u +%FT%TZ > "$SHARED_MEMORY_DEST/.last-sync"
