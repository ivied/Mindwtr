#!/usr/bin/env bash
# install-launchd.sh — install the Mac worker as a launchd agent so it
# survives reboots (replaces the nohup launch from FR97).
#
# Run ON THE LAPTOP (the machine with the `claude` CLI and ~/.claude/projects):
#   bash apps/ai-service/src/mac-worker/install-launchd.sh
#
# Reads MINDWTR_CLOUD_URL / MINDWTR_AUTH_TOKEN from docker/.env in this
# checkout (same env the worker used under nohup). Re-running reinstalls.

set -euo pipefail

LABEL="uk.kurdy.gtd-mac-worker"
REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
RUN_TS="$REPO_ROOT/apps/ai-service/src/mac-worker/run.ts"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/docker/.env}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/gtd-mac-worker"

BUN_BIN="$(command -v bun || true)"
CLAUDE_BIN="$(command -v claude || true)"
[[ -n "$BUN_BIN" ]] || { echo "ERROR: bun not found in PATH" >&2; exit 1; }
[[ -n "$CLAUDE_BIN" ]] || { echo "ERROR: claude CLI not found in PATH" >&2; exit 1; }
[[ -f "$RUN_TS" ]] || { echo "ERROR: $RUN_TS not found" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file $ENV_FILE not found (set ENV_FILE=...)" >&2; exit 1; }

get_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}
CLOUD_URL="${MINDWTR_CLOUD_URL:-$(get_env MINDWTR_CLOUD_URL)}"
AUTH_TOKEN="${MINDWTR_AUTH_TOKEN:-$(get_env MINDWTR_CLOUD_AUTH_TOKENS)}"
AUTH_TOKEN="${AUTH_TOKEN%%,*}"
[[ -n "$CLOUD_URL" ]] || { echo "ERROR: MINDWTR_CLOUD_URL not set and not in $ENV_FILE" >&2; exit 1; }
[[ -n "$AUTH_TOKEN" ]] || { echo "ERROR: MINDWTR_AUTH_TOKEN not resolvable from $ENV_FILE" >&2; exit 1; }

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>run</string>
    <string>$RUN_TS</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_ROOT/apps/ai-service</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINDWTR_CLOUD_URL</key><string>$CLOUD_URL</string>
    <key>MINDWTR_AUTH_TOKEN</key><string>$AUTH_TOKEN</string>
    <key>CLAUDE_BIN</key><string>$CLAUDE_BIN</string>
    <key>PATH</key><string>$(dirname "$BUN_BIN"):$(dirname "$CLAUDE_BIN"):/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "✅ $LABEL installed and started"
echo "   logs:   tail -f $LOG_DIR/stderr.log"
echo "   status: launchctl print gui/$(id -u)/$LABEL | grep -E 'state|pid'"
echo "   remove: launchctl bootout gui/$(id -u)/$LABEL && rm $PLIST"
echo
echo "If a nohup'd mac-worker is still running, kill it: pkill -f 'mac-worker/run.ts'"
