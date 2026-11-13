#!/usr/bin/env bash
# install-dispatcher.sh — put the session dispatcher on another computer of the
# user and start it there as a launchd agent (see src/session-dispatch.ts).
#
# Run ON THE SERVER HOST, from this checkout; the other computer is reached
# over SSH and needs `bun` and a logged-in Claude Code:
#   bash apps/agent-runner/install-dispatcher.sh user@computer
#
# The dispatcher is three files with no dependencies; they are copied to
# ~/.local/share/gtd-agents/dispatcher there. Re-running updates and restarts.
# Tokens are read from docker/.env here and end up in the launchd plist there
# (mode 600), the same way the runner keeps them on this host.
#
# Optional (export before running):
#   AI_SERVICE_URL                   how that computer reaches ai-service
#                                    (default: this host's Tailscale address, port HTTP_PORT)
#   AGENT_DISPATCH_MACHINE           name of the computer on the server (default: its hostname)
#   AGENT_DISPATCH_PERMISSION_MODE   mode a closed session is resumed in (default auto)
#   AGENT_DISPATCH_SIGNATURE         last line of messages sessions send to people
#   AGENT_DISPATCH_DAYS              sessions untouched for longer are not offered (default 30)

set -euo pipefail

TARGET="${1:-}"
[[ -n "$TARGET" ]] || { echo "usage: $0 user@computer" >&2; exit 2; }

LABEL="uk.kurdy.gtd-session-dispatch"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$REPO_ROOT/apps/agent-runner/src"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/docker/.env}"
FILES=(session-index.ts session-dispatch.ts dispatch.ts)

[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file $ENV_FILE not found (set ENV_FILE=...)" >&2; exit 1; }
for f in "${FILES[@]}"; do [[ -f "$SRC_DIR/$f" ]] || { echo "ERROR: $SRC_DIR/$f not found" >&2; exit 1; }; done

get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

SERVICE_TOKEN="$(get_env HTTP_AUTH_TOKEN)"
RUNNER_TOKEN="$(get_env AGENT_RUNNER_TOKEN)"
[[ -n "$SERVICE_TOKEN" && -n "$RUNNER_TOKEN" ]] || { echo "ERROR: HTTP_AUTH_TOKEN / AGENT_RUNNER_TOKEN not found in $ENV_FILE (install the runner first)" >&2; exit 1; }

SERVICE_URL="${AI_SERVICE_URL:-}"
if [[ -z "$SERVICE_URL" ]]; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [[ -n "$TS_IP" ]] || { echo "ERROR: set AI_SERVICE_URL (no Tailscale address found for this host)" >&2; exit 1; }
  HTTP_PORT_VALUE="$(get_env HTTP_PORT)"
  SERVICE_URL="http://$TS_IP:${HTTP_PORT_VALUE:-3030}"
fi

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET")

# Facts about the other computer: home, bun, claude, uid.
# (interactive shell: bun and claude are usually put on PATH by ~/.zshrc)
REMOTE="$("${SSH[@]}" 'zsh -lic "echo \$HOME; command -v bun || echo -; command -v claude || echo -; id -u" 2>/dev/null' | tail -4)"
R_HOME="$(sed -n 1p <<<"$REMOTE")"
R_BUN="$(sed -n 2p <<<"$REMOTE")"
R_CLAUDE="$(sed -n 3p <<<"$REMOTE")"
R_UID="$(sed -n 4p <<<"$REMOTE")"
[[ "$R_BUN" != "-" && -n "$R_BUN" ]] || { echo "ERROR: bun not found on $TARGET" >&2; exit 1; }
[[ "$R_CLAUDE" != "-" && -n "$R_CLAUDE" ]] || { echo "ERROR: claude not found on $TARGET" >&2; exit 1; }

"${SSH[@]}" "curl -s -o /dev/null -m 8 -w '%{http_code}' '$SERVICE_URL/health' | grep -q 200" \
  || { echo "ERROR: $TARGET cannot reach $SERVICE_URL/health" >&2; exit 1; }

APP_DIR="$R_HOME/.local/share/gtd-agents/dispatcher"
LOG_DIR="$R_HOME/Library/Logs/gtd-session-dispatch"
PLIST="$R_HOME/Library/LaunchAgents/$LABEL.plist"
RUN_PATH="$(dirname "$R_BUN"):$(dirname "$R_CLAUDE"):$R_HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

optional_env() {
  local name="$1" value="${!1:-}"
  [[ -n "$value" ]] && printf '    <key>%s</key><string>%s</string>\n' "$name" "$(xml_escape "$value")"
  return 0
}

"${SSH[@]}" "mkdir -p '$APP_DIR' '$LOG_DIR' '$R_HOME/Library/LaunchAgents'"
for f in "${FILES[@]}"; do scp -q -o BatchMode=yes "$SRC_DIR/$f" "$TARGET:$APP_DIR/$f"; done

# The plist goes over stdin: tokens never appear in a command line.
"${SSH[@]}" "umask 077 && cat > '$PLIST'" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$R_BUN</string>
    <string>run</string>
    <string>$APP_DIR/dispatch.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_SERVICE_URL</key><string>$(xml_escape "$SERVICE_URL")</string>
    <key>AI_SERVICE_TOKEN</key><string>$(xml_escape "$SERVICE_TOKEN")</string>
    <key>AGENT_RUNNER_TOKEN</key><string>$(xml_escape "$RUNNER_TOKEN")</string>
    <key>CLAUDE_BIN</key><string>$R_CLAUDE</string>
    <key>HOME</key><string>$R_HOME</string>
    <key>PATH</key><string>$RUN_PATH</string>
$(optional_env AGENT_DISPATCH_MACHINE)$(optional_env AGENT_DISPATCH_PERMISSION_MODE)$(optional_env AGENT_DISPATCH_SIGNATURE)$(optional_env AGENT_DISPATCH_DAYS)  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/dispatch.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/dispatch.err.log</string>
</dict>
</plist>
PLIST

DOMAIN="gui/$R_UID"
"${SSH[@]}" "launchctl bootout '$DOMAIN/$LABEL' 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do launchctl print '$DOMAIN/$LABEL' >/dev/null 2>&1 || break; sleep 1; done; launchctl bootstrap '$DOMAIN' '$PLIST' || { sleep 3; launchctl bootstrap '$DOMAIN' '$PLIST'; }; sleep 3; launchctl print '$DOMAIN/$LABEL' >/dev/null 2>&1" \
  || { echo "ERROR: $LABEL did not start on $TARGET; see $LOG_DIR/dispatch.err.log there" >&2; exit 1; }

echo "Installed $LABEL on $TARGET → $SERVICE_URL"
echo "Logs:      ssh $TARGET tail -f $LOG_DIR/dispatch.log"
echo "Restart:   ssh $TARGET launchctl kickstart -k $DOMAIN/$LABEL"
echo "Uninstall: ssh $TARGET \"launchctl bootout $DOMAIN/$LABEL; rm '$PLIST'\""
