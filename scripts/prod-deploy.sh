#!/usr/bin/env bash
# prod-deploy.sh — put a commit on the production checkout of this host.
#
# Production does not run from the working tree you edit. It runs from its own
# clone (default ~/gtd-prod): the containers mount the sources from there and
# the agent runner starts from there. Nothing reaches production until this
# script moves that clone to a commit.
#
#   scripts/prod-deploy.sh                 deploy HEAD of this checkout
#   scripts/prod-deploy.sh <ref>           deploy a branch, tag or commit
#   scripts/prod-deploy.sh --web [<ref>]   also rebuild the web bundle (7–10 min)
#   scripts/prod-deploy.sh --build [<ref>] also rebuild the ai-service image
#   scripts/prod-deploy.sh --dry-run       show what would happen
#
# What it does, depending on what changed between the deployed commit and the
# new one:
#   dependencies            bun install in the production clone
#   ai-service / core       typecheck + tests there, then restart ai-worker and
#                           ai-service (or `up -d` when compose.yaml changed)
#   agent-runner            restart the runner, if no run is running or queued
#   desktop / web image     only with --web
# A failed typecheck or test puts the clone back on the previous commit.
#
# Uncommitted changes are never deployed. GTD_PROD_DIR overrides the location.

set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PROD="${GTD_PROD_DIR:-$HOME/gtd-prod}"
RUNNER_LABEL="uk.kurdy.gtd-agent-runner"
REF="HEAD"
WEB=0
BUILD=0
DRY=0

for arg in "$@"; do
  case "$arg" in
    --web) WEB=1 ;;
    --build) BUILD=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "▸ $*"; }

[[ -d "$PROD/.git" ]] || die "no production checkout at $PROD (see docker/cloud-prod/AGENT_INSTRUCTIONS.md)"
[[ -f "$PROD/docker/.env" ]] || die "$PROD/docker/.env is missing"
[[ "$(cd "$PROD" && pwd -P)" != "$(cd "$SRC" && pwd -P)" ]] || die "run this from a development checkout, not from the production one"

SHA="$(git -C "$SRC" rev-parse --verify --quiet "$REF^{commit}")" || die "unknown ref: $REF"
OLD="$(git -C "$PROD" rev-parse HEAD)"

if [[ -n "$(git -C "$PROD" status --porcelain --untracked-files=no)" ]]; then
  die "the production checkout has local edits — somebody changed $PROD by hand; look before deploying"
fi
if [[ "$REF" == "HEAD" && -n "$(git -C "$SRC" status --porcelain --untracked-files=no -- apps packages docker scripts)" ]]; then
  echo "note: uncommitted changes in $SRC are not part of this deploy"
fi

git -C "$PROD" fetch --quiet "$SRC" '+refs/heads/*:refs/remotes/dev/*'
git -C "$PROD" cat-file -e "$SHA^{commit}" 2>/dev/null || die "$SHA is not on any branch of $SRC — commit it to a branch first"

CHANGED="$(git -C "$PROD" diff --name-only "$OLD" "$SHA")"
touches() { grep -qE "$1" <<<"$CHANGED"; }

say "production: $(git -C "$PROD" log -1 --format='%h %s' "$OLD")"
say "deploying:  $(git -C "$PROD" log -1 --format='%h %s' "$SHA")"
if [[ "$OLD" == "$SHA" && $WEB -eq 0 && $BUILD -eq 0 ]]; then
  say "already deployed"
  exit 0
fi
[[ -z "$CHANGED" ]] || echo "$CHANGED" | sed 's/^/    /' | head -40

DEPS=0; SERVICE=0; COMPOSE=0; RUNNER=0; WEBSRC=0; CLOUD=0
touches '(^|/)(package\.json|bun\.lock)$' && DEPS=1
touches '^(apps/ai-service/|packages/core/src/)' && SERVICE=1
touches '^docker/compose\.yaml$' && COMPOSE=1
touches '^docker/ai-service/' && BUILD=1
touches '^apps/agent-runner/' && RUNNER=1
touches '^(apps/desktop/|packages/core/|docker/app/)' && WEBSRC=1
touches '^(apps/cloud/|docker/cloud/)' && CLOUD=1

if [[ $DRY -eq 1 ]]; then
  say "dry run: deps=$DEPS service=$SERVICE compose=$COMPOSE image=$BUILD runner=$RUNNER web=$WEBSRC (build: $WEB) cloud=$CLOUD"
  exit 0
fi

env_value() { sed -n "s/^$1=//p" "$PROD/docker/.env" | tail -1; }
PORT="$(env_value HTTP_PORT)"; PORT="${PORT:-3030}"
TOKEN="$(env_value HTTP_AUTH_TOKEN)"

# Runs that are running or queued; "?" when the service does not answer.
active_runs() {
  local body
  body="$(curl -s -m 20 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/agent-runs")" || { echo '?'; return; }
  [[ "$body" == *'"items"'* ]] || { echo '?'; return; }
  grep -oE '"state":"(running|queued)"' <<<"$body" | wc -l | tr -d ' '
}

compose() { (cd "$PROD/docker" && docker compose "$@"); }

git -C "$PROD" checkout --quiet --detach "$SHA"
rollback() {
  git -C "$PROD" checkout --quiet --detach "$OLD"
  die "$1 — production checkout is back on $(git -C "$PROD" rev-parse --short "$OLD"), nothing was restarted"
}

if [[ $DEPS -eq 1 || ! -d "$PROD/node_modules" ]]; then
  say "installing dependencies"
  (cd "$PROD" && bun install --frozen-lockfile >/dev/null) || rollback "bun install failed"
  # The container has its own node_modules, baked into the image.
  [[ $DEPS -eq 1 ]] && BUILD=1
fi

if [[ $SERVICE -eq 1 ]]; then
  say "checking ai-service (typecheck + tests)"
  (cd "$PROD/apps/ai-service" && bunx tsc --noEmit) || rollback "ai-service does not typecheck"
  (cd "$PROD/apps/ai-service" && bun test >/dev/null 2>&1) || rollback "ai-service tests fail (run 'bun test' in apps/ai-service)"
fi
if [[ $RUNNER -eq 1 ]]; then
  say "checking agent-runner (typecheck + tests)"
  (cd "$PROD/apps/agent-runner" && bunx tsc --noEmit) || rollback "agent-runner does not typecheck"
  (cd "$PROD/apps/agent-runner" && bun test >/dev/null 2>&1) || rollback "agent-runner tests fail"
fi

if [[ $BUILD -eq 1 || $WEB -eq 1 ]]; then
  ACTIVE="$(active_runs)"
  [[ "$ACTIVE" == "0" ]] || die "an image build needs a quiet host, and $ACTIVE agent run(s) are running or queued (the checkout is already on the new commit; rerun when they finish)"
fi
if [[ $BUILD -eq 1 ]]; then
  say "building the ai-service image"
  compose build ai-worker
fi

if [[ $BUILD -eq 1 || $COMPOSE -eq 1 ]]; then
  say "recreating ai-worker and ai-service"
  compose up -d ai-worker ai-service
elif [[ $SERVICE -eq 1 ]]; then
  say "restarting ai-worker and ai-service"
  compose restart ai-worker ai-service
fi

if [[ $BUILD -eq 1 || $COMPOSE -eq 1 || $SERVICE -eq 1 ]]; then
  say "waiting for the service"
  ok=0
  for _ in $(seq 1 90); do
    if curl -fsS -m 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [[ $ok -eq 1 ]] || echo "WARNING: /health did not turn green in 3 minutes — check 'docker logs ai-worker'"
fi

if [[ $WEB -eq 1 ]]; then
  say "building the web bundle (7–10 min)"
  compose build mindwtr-app
  compose up -d mindwtr-app
elif [[ $WEBSRC -eq 1 ]]; then
  echo "note: the web app changed; it is rebuilt only with --web"
fi
[[ $CLOUD -eq 0 ]] || echo "note: mindwtr-cloud changed; rebuild it by hand (docker compose build mindwtr-cloud && docker compose up -d mindwtr-cloud)"

if [[ $RUNNER -eq 1 ]]; then
  ACTIVE="$(active_runs)"
  if [[ "$ACTIVE" == "0" ]]; then
    say "restarting the agent runner"
    launchctl kickstart -k "gui/$(id -u)/$RUNNER_LABEL"
  else
    echo "note: the agent runner was NOT restarted ($ACTIVE run(s) active). When they finish:"
    echo "      launchctl kickstart -k gui/$(id -u)/$RUNNER_LABEL"
  fi
fi

say "done: $(git -C "$PROD" rev-parse --short "$OLD") → $(git -C "$PROD" rev-parse --short "$SHA")"
