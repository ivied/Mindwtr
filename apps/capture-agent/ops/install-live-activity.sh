#!/usr/bin/env bash
# Install the live-activity launchd agent — keeps the macOS widget's
# "Doing now" fresh (vision-extracts the newest screen capture every minute).
#
# Separate from install-launchd.sh on purpose: the capture/rollup/curator
# agents have hand-tuned env (sonnet model, rollup concurrency) that the
# shared installer doesn't carry, so re-running this won't disturb them.
#
#   ./ops/install-live-activity.sh            # install + start
#   ./ops/install-live-activity.sh uninstall  # stop + remove
#
# LLM creds come from .env.local in this dir (auto-loaded by bun).

set -euo pipefail
cd "$(dirname "$0")/.."                       # → apps/capture-agent
WORKDIR="$(pwd)"
BUN="$(command -v bun)"
BUNDIR="$(dirname "$BUN")"
LABEL="uk.kurdy.gtd-live-activity"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/Library/Logs/gtd-capture"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
TEMPLATE="$WORKDIR/ops/$LABEL.plist.template"
DOMAIN="gui/$(id -u)"
# Widget reload helper inside the installed app bundle (optional — the widget
# also self-refreshes on its timeline, but pinging makes it update instantly).
RELOAD="/Applications/GTDPipelineStatus.app/Contents/Resources/gtd-widget-reload"

if [[ "${1:-}" == "uninstall" ]]; then
  echo "⏏  bootout $LABEL"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ uninstalled"
  exit 0
fi

mkdir -p "$LAUNCH_AGENTS" "$LOGDIR"

sed -e "s|@BUN@|$BUN|g" \
    -e "s|@BUNDIR@|$BUNDIR|g" \
    -e "s|@WORKDIR@|$WORKDIR|g" \
    -e "s|@LOGDIR@|$LOGDIR|g" \
    -e "s|@RELOAD@|$RELOAD|g" \
    "$TEMPLATE" > "$PLIST"

# Replace any prior definition cleanly.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "✅ installed + started $LABEL"
echo "   log: $LOGDIR/$LABEL.out.log"
