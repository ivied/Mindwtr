#!/usr/bin/env bash
# sync-wiki.sh — rsync wiki/entities/ from Mac → VPS.
# Runs on the Mac via cron / launchd / manual invocation.
# capture-agent + rollup-runner stay local; only the derived entity .md
# files (which feed the persons registry + slug canonicalizer in ai-service)
# need to be on the VPS.

set -euo pipefail

# ─── Config ────────────────────────────────────────────────────────────
WIKI_SRC="${WIKI_SRC:-$HOME/Projects/GTD_automation/wiki}"
VPS_HOST="${VPS_HOST:-hetzner-mfp}"        # SSH alias in ~/.ssh/config
VPS_PATH="${VPS_PATH:-/opt/gtd/wiki}"
DRY_RUN="${DRY_RUN:-0}"

# ─── Sanity ────────────────────────────────────────────────────────────
if [[ ! -d "$WIKI_SRC/entities" ]]; then
  echo "ERROR: $WIKI_SRC/entities does not exist." >&2
  exit 1
fi

# ─── Sync ──────────────────────────────────────────────────────────────
# --delete   : remove files on VPS that no longer exist locally (after
#              merger/curator GC). Safe because VPS treats this as a
#              derived view, source of truth is the Mac.
# --exclude  : skip .archive/ (recovery copies) and .jsonl (heavy logs).
# Two trailing slashes matter — copy CONTENTS of entities/, not the dir.
RSYNC_ARGS=(
  -avz
  --delete
  --exclude '.archive/'
  --exclude '*.mentions.jsonl'
  --exclude '.DS_Store'
)
[[ "$DRY_RUN" == "1" ]] && RSYNC_ARGS+=(--dry-run)

echo "Syncing $WIKI_SRC/entities → $VPS_HOST:$VPS_PATH/entities"
ssh "$VPS_HOST" "mkdir -p $VPS_PATH/entities"
rsync "${RSYNC_ARGS[@]}" \
  "$WIKI_SRC/entities/" \
  "$VPS_HOST:$VPS_PATH/entities/"

echo "Done."
