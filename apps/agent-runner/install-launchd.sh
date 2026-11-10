#!/usr/bin/env bash
# install-launchd.sh — install the agent runner as a launchd agent so it
# survives reboots.
#
# Run ON THE HOST that should execute agent runs (it needs `bun`, a logged-in
# Claude Code, and whatever the agents are expected to reach: repos, docker,
# hermes, …):
#   bash apps/agent-runner/install-launchd.sh
#
# Reads the ai-service and Mindwtr tokens from docker/.env in this checkout.
# Re-running reinstalls. Optional overrides (export before running):
#   AGENT_RUNNER_MODEL            model for the agents (default: Claude Code's default)
#   AGENT_RUNNER_CONCURRENCY      parallel runs (default 2)
#   AGENT_RUNNER_MAX_BUDGET_USD   spend cap per turn (default 3, 0 = none)
#   AGENT_RUNNER_CHROME           false = no Claude in Chrome for the agents (default on)
#   AGENT_RUNNER_CWD              working dir of fresh sessions (default $HOME)
#   AI_SERVICE_URL                default http://localhost:<HTTP_PORT>
#   MINDWTR_CLOUD_URL             default http://localhost:8787

set -euo pipefail

LABEL="uk.kurdy.gtd-agent-runner"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP_DIR="$REPO_ROOT/apps/agent-runner"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/docker/.env}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/gtd-agent-runner"

BUN_BIN="$(command -v bun || true)"
[[ -n "$BUN_BIN" ]] || { echo "ERROR: bun not found in PATH" >&2; exit 1; }
[[ -f "$APP_DIR/src/run.ts" ]] || { echo "ERROR: $APP_DIR/src/run.ts not found" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "ERROR: env file $ENV_FILE not found (set ENV_FILE=...)" >&2; exit 1; }

get_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

HTTP_PORT_VALUE="$(get_env HTTP_PORT)"
SERVICE_URL="${AI_SERVICE_URL:-http://localhost:${HTTP_PORT_VALUE:-3030}}"
SERVICE_TOKEN="${AI_SERVICE_TOKEN:-$(get_env HTTP_AUTH_TOKEN)}"
CLOUD_URL="${MINDWTR_CLOUD_URL:-http://localhost:8787}"
CLOUD_TOKEN="${MINDWTR_AUTH_TOKEN:-$(get_env MINDWTR_CLOUD_AUTH_TOKENS)}"
CLOUD_TOKEN="${CLOUD_TOKEN%%,*}"
[[ -n "$SERVICE_TOKEN" ]] || { echo "ERROR: HTTP_AUTH_TOKEN not found in $ENV_FILE" >&2; exit 1; }
# Separate token for the runner endpoints: the UI token is baked into the web
# bundle, and a claimed run carries the secrets the user typed for it.
RUNNER_TOKEN="${AGENT_RUNNER_TOKEN:-$(get_env AGENT_RUNNER_TOKEN)}"
if [[ -z "$RUNNER_TOKEN" ]]; then
  RUNNER_TOKEN="$(openssl rand -hex 24)"
  printf '\n# Runner-only token for /v1/agent-runs claim/events/finish (see apps/agent-runner).\nAGENT_RUNNER_TOKEN=%s\n' "$RUNNER_TOKEN" >> "$ENV_FILE"
  echo "Generated AGENT_RUNNER_TOKEN in $ENV_FILE — recreate ai-service so it starts requiring it."
fi
[[ -n "$CLOUD_TOKEN" ]] || { echo "ERROR: MINDWTR_CLOUD_AUTH_TOKENS not found in $ENV_FILE" >&2; exit 1; }

# The agents shell out to whatever the user has: keep the usual tool dirs on PATH.
RUN_PATH="$(dirname "$BUN_BIN"):$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

optional_env() {
  local name="$1" value="${!1:-}"
  [[ -n "$value" ]] && printf '    <key>%s</key><string>%s</string>\n' "$name" "$(xml_escape "$value")"
  return 0
}

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
    <string>$APP_DIR/src/run.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AI_SERVICE_URL</key><string>$(xml_escape "$SERVICE_URL")</string>
    <key>AI_SERVICE_TOKEN</key><string>$(xml_escape "$SERVICE_TOKEN")</string>
    <key>AGENT_RUNNER_TOKEN</key><string>$(xml_escape "$RUNNER_TOKEN")</string>
    <key>MINDWTR_CLOUD_URL</key><string>$(xml_escape "$CLOUD_URL")</string>
    <key>MINDWTR_AUTH_TOKEN</key><string>$(xml_escape "$CLOUD_TOKEN")</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$RUN_PATH</string>
$(optional_env AGENT_RUNNER_MODEL)$(optional_env AGENT_RUNNER_CONCURRENCY)$(optional_env AGENT_RUNNER_MAX_BUDGET_USD)$(optional_env AGENT_RUNNER_CWD)$(optional_env AGENT_RUNNER_NAME)$(optional_env AGENT_RUNNER_CHROME)  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/runner.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/runner.err.log</string>
</dict>
</plist>
PLIST
chmod 600 "$PLIST"   # holds tokens

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping too early fails with EIO.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done
launchctl bootstrap "$DOMAIN" "$PLIST" || { sleep 3; launchctl bootstrap "$DOMAIN" "$PLIST"; }
sleep 2

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "Installed $LABEL → $SERVICE_URL"
  echo "Logs:      $LOG_DIR/runner.log"
  echo "Restart:   launchctl kickstart -k $DOMAIN/$LABEL"
  echo "Uninstall: launchctl bootout $DOMAIN/$LABEL && rm $PLIST"
else
  echo "ERROR: $LABEL did not start; see $LOG_DIR/runner.err.log" >&2
  exit 1
fi
