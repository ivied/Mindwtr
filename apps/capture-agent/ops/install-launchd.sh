#!/usr/bin/env bash
# Install launchd agents for the GTD capture pipeline so they survive
# logout, reboot, and the nightly sleep/wake that kept killing the
# Terminal-launched processes.
#
# Three agents (capture, rollup, curator) all use the same template.
# Re-runnable: bootout + bootstrap replaces any existing definition.
#
#   ./ops/install-launchd.sh            # install + start all three
#   ./ops/install-launchd.sh uninstall  # stop + remove all three

set -euo pipefail
cd "$(dirname "$0")/.."                       # → apps/capture-agent
WORKDIR="$(pwd)"
BUN="$(command -v bun)"
BUNDIR="$(dirname "$BUN")"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOGDIR="$HOME/Library/Logs/gtd-capture"
TEMPLATE="$WORKDIR/ops/uk.kurdy.gtd-capture.plist.template"
DOMAIN="gui/$(id -u)"

# label → script path (relative to WORKDIR)
AGENTS=(
  "uk.kurdy.gtd-capture:src/index.ts"
  "uk.kurdy.gtd-rollup:src/wiki/rollup-runner.ts"
  "uk.kurdy.gtd-curator:src/wiki/curator/curator-runner.ts"
)

uninstall() {
  for entry in "${AGENTS[@]}"; do
    label="${entry%%:*}"
    plist="$LAUNCH_AGENTS/$label.plist"
    echo "⏏  bootout $label"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    rm -f "$plist"
  done
  echo "✅ uninstalled"
}

if [[ "${1:-}" == "uninstall" ]]; then
  uninstall
  exit 0
fi

mkdir -p "$LAUNCH_AGENTS" "$LOGDIR"

for entry in "${AGENTS[@]}"; do
  label="${entry%%:*}"
  script="${entry##*:}"
  plist="$LAUNCH_AGENTS/$label.plist"

  sed -e "s|@BUN@|$BUN|g" \
      -e "s|@BUNDIR@|$BUNDIR|g" \
      -e "s|@WORKDIR@|$WORKDIR|g" \
      -e "s|@LABEL@|$label|g" \
      -e "s|@SCRIPT@|$script|g" \
      -e "s|@LOGDIR@|$LOGDIR|g" \
      "$TEMPLATE" > "$plist"

  # Replace any prior definition cleanly.
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
  launchctl enable "$DOMAIN/$label"
  echo "✅ $label → $plist (script: $script)"
done

echo
echo "logs: $LOGDIR/*.log"
echo "status: launchctl print $DOMAIN/uk.kurdy.gtd-capture | grep -E 'state|pid'"
echo
echo "⚠️  First run: macOS may need a one-time mic grant for the bun binary."
echo "    If audio captures stay empty, open System Settings → Privacy &"
echo "    Security → Microphone and ensure the helper/bun has access, then"
echo "    'launchctl kickstart -k $DOMAIN/uk.kurdy.gtd-capture'."
