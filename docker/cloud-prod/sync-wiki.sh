#!/usr/bin/env bash
# sync-wiki.sh — rsync wiki/{entities,activities,topics}/ Mac → makurdi.
# Runs on the Mac (where capture-agent writes the wiki) via cron / manual.
# Excludes captures/ (huge, never read by ai-service from disk) — only
# the derived entity .md files (persons registry + slug canonicalizer)
# and activities/topics need to be on makurdi.
#
# As of 2026-06-03 the destination is makurdi (Colima), not the Hetzner
# VPS. Override DEST_HOST/DEST_PATH if migrating elsewhere.

set -euo pipefail

# ─── Config ────────────────────────────────────────────────────────────
WIKI_SRC="${WIKI_SRC:-$HOME/Projects/GTD_automation/wiki}"
DEST_HOST="${DEST_HOST:-openclaw}"               # SSH alias for makurdi
DEST_PATH="${DEST_PATH:-/Users/makurdi/wiki}"
DRY_RUN="${DRY_RUN:-0}"

# Subdirs to sync. captures/ is intentionally NOT here — it's 5+ GB of
# images/audio that ai-service never reads from disk; it lives on the
# laptop where capture-agent writes it.
SUBDIRS=("entities" "activities" "topics")

# ─── Sanity ────────────────────────────────────────────────────────────
for sub in "${SUBDIRS[@]}"; do
  if [[ ! -d "$WIKI_SRC/$sub" ]]; then
    echo "WARN: $WIKI_SRC/$sub does not exist — skipping." >&2
  fi
done

# ─── Sync ──────────────────────────────────────────────────────────────
# --delete   : remove files on dest that no longer exist locally (after
#              merger/curator GC). Safe because the dest treats this as
#              a derived view; source of truth is the Mac.
# --exclude  : skip .archive/ (recovery copies) and .jsonl (heavy logs).
# Two trailing slashes matter — copy CONTENTS of <sub>/, not the dir.
RSYNC_ARGS=(
  -av
  --partial
  --delete
  --exclude '.archive/'
  --exclude '*.mentions.jsonl'
  --exclude '.DS_Store'
)
[[ "$DRY_RUN" == "1" ]] && RSYNC_ARGS+=(--dry-run)

# Pre-create destination subdirs on dest in one ssh call.
mkdir_cmd=""
for sub in "${SUBDIRS[@]}"; do
  mkdir_cmd+="mkdir -p $DEST_PATH/$sub; "
done
ssh "$DEST_HOST" "$mkdir_cmd" >/dev/null

for sub in "${SUBDIRS[@]}"; do
  [[ -d "$WIKI_SRC/$sub" ]] || continue
  echo "[$(date -u +%FT%TZ)] Syncing $WIKI_SRC/$sub/ → $DEST_HOST:$DEST_PATH/$sub/"
  rsync "${RSYNC_ARGS[@]}" \
    "$WIKI_SRC/$sub/" \
    "$DEST_HOST:$DEST_PATH/$sub/"
done

# Heartbeat for cron monitoring.
ssh "$DEST_HOST" "date -u +%FT%TZ > $DEST_PATH/.last-sync" >/dev/null
echo "[$(date -u +%FT%TZ)] Done."
