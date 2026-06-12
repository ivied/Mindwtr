#!/bin/bash
# Pull Claude Code threads from Sergey's Mac over Tailscale so the ai-service
# thread registry (ai-target routing) stays current.
#
# makurdi (this MacBook Air) runs ai-service in Docker; the work threads live on
# macbook-pro-de-sergey. rsync mirrors ~/.claude/projects → ~/claude-projects-sync,
# which docker-compose mounts read-only into the ai-service container.
#
# Installed as a launchd agent (com.mindwtr.claude-threads-sync) on a 5-min
# interval. Safe to run by hand for an immediate refresh.
set -euo pipefail

REMOTE_USER="sergeykurdyuk"
REMOTE_HOST="100.102.216.91"          # macbook-pro-de-sergey (Tailscale)
REMOTE_PATH=".claude/projects/"        # relative to remote $HOME
LOCAL_DIR="$HOME/claude-projects-sync/"
SSH_KEY="$HOME/.ssh/id_ed25519"

mkdir -p "$LOCAL_DIR"

exec rsync -az --delete \
  -e "ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new" \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}" \
  "$LOCAL_DIR"
