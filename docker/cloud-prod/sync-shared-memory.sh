#!/usr/bin/env bash
# sync-shared-memory.sh — mirror OpenClaw's procedural memory into the
# shared-memory dir consumed by ai-service (FR85, Phase 0).
#
# Why this is not a plain rsync of *.md files:
#   OpenClaw stores its memory (MEMORY.md, daily journals) as `chunks`
#   rows inside ~/.openclaw/memory/main.sqlite. There is no .md file on
#   disk — the markdown is virtual. We SSH in, run a sqlite SELECT,
#   reassemble the chunks by start_line, and write the reconstructed
#   markdown to our local mirror. Lines that appear in two overlapping
#   adjacent chunks (OpenClaw's chunking has a small overlap window for
#   retrieval quality) are deduplicated on the consecutive-line level —
#   good enough since our downstream chunker re-splits on `##` anyway.
#
# Runs on whichever host the ai-service deployment lives on:
#   - Mac dev: ~/shared-memory/openclaw/
#   - Hetzner prod: /opt/gtd/shared-memory/openclaw/  (Tailscale required)
#
# Schedule:
#   */5 * * * * bash /path/to/sync-shared-memory.sh \
#     >> /tmp/sync-shared-memory.log 2>&1
#
# Idempotent — overwrites the target file each tick. Heartbeat file at
# $SHARED_MEMORY_DEST/.last-sync lets cron-monitoring confirm aliveness.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────
OPENCLAW_HOST="${OPENCLAW_HOST:-openclaw}"
OPENCLAW_DB_PATH="${OPENCLAW_DB_PATH:-.openclaw/memory/main.sqlite}"
SHARED_MEMORY_DEST="${SHARED_MEMORY_DEST:-$HOME/shared-memory}"

# Phase 0 scope: top-level MEMORY.md only. Whitespace-separated list of
# `path` values to extract. Bump when Phase 0.5 widens to journals/.
SOURCE_PATHS="${SOURCE_PATHS:-MEMORY.md}"

DEST_SOURCE_DIR="$SHARED_MEMORY_DEST/openclaw"
mkdir -p "$DEST_SOURCE_DIR"

# ─── Dump each path's chunks into the corresponding local file ───────
for src_path in $SOURCE_PATHS; do
  echo "[$(date -u +%FT%TZ)] Dumping ${OPENCLAW_HOST}:${OPENCLAW_DB_PATH} path='${src_path}' → ${DEST_SOURCE_DIR}/${src_path}"

  # Order by start_line so the reconstructed markdown preserves the
  # original section order. `awk '!seen[$0]++'` deduplicates exact
  # repeated lines across the overlap window without disturbing order.
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$OPENCLAW_HOST" \
    "sqlite3 -separator '' \"$OPENCLAW_DB_PATH\" \
       \"SELECT text FROM chunks WHERE path='${src_path}' ORDER BY start_line ASC;\"" \
    | awk '!seen[$0]++' \
    > "${DEST_SOURCE_DIR}/${src_path}.new"

  # Atomic swap so the reader never sees a half-written file.
  mv "${DEST_SOURCE_DIR}/${src_path}.new" "${DEST_SOURCE_DIR}/${src_path}"
  echo "[$(date -u +%FT%TZ)] Wrote ${DEST_SOURCE_DIR}/${src_path} ($(wc -l < "${DEST_SOURCE_DIR}/${src_path}") lines)"
done

# Heartbeat for cron monitoring.
date -u +%FT%TZ > "$SHARED_MEMORY_DEST/.last-sync"
