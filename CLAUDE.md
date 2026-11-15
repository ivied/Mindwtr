# Working in this repository

This is a fork of Mindwtr that also carries a personal production stack (the
GTD service on the makurdi host). Upstream code lives in `apps/desktop`,
`apps/mobile`, `apps/cloud`, `packages/core`; the additions are
`apps/ai-service`, `apps/agent-runner` and `docker/`.

## Deploying

The runbook is `docker/cloud-prod/AGENT_INSTRUCTIONS.md` — read it before you
build, restart or deploy anything. The parts agents get wrong most often:

- **Production does not run from this checkout.** It runs from its own clone,
  `~/gtd-prod`, and changes only when a commit is deployed there:
  `scripts/prod-deploy.sh [ref]` (default: HEAD here). Uncommitted edits are
  never deployed. Do not edit `~/gtd-prod` by hand.
- The deploy script typechecks and tests what changed, restarts what needs it
  and rolls the clone back if the checks fail. `--dry-run` shows the plan,
  `--web` also rebuilds the web bundle.
- ai-service is two containers on one database: `ai-worker` (the full
  service) and `ai-service` (a gateway that answers the agent-runs routes
  itself and forwards the rest). They run the sources bind-mounted from the
  clone: a code change needs a restart of both, not an image build.
- Any image build: one at a time, nothing else heavy alongside, and not while
  agent runs are `running` or `queued`. The host has 8 GB.
- The agent runner (launchd `uk.kurdy.gtd-agent-runner`) also starts from the
  clone; it is restarted only when no run is `running` or `queued`.
- Secrets and production data live in the clone (`~/gtd-prod/docker/.env`,
  `docker/data`, the backup folders). Do not run `docker compose` from this
  checkout: it would recreate the production containers from these sources.
- Never open `context.db` from the host while the containers run; use
  `docker exec ai-worker …`.

## Conventions

- The repository is public: no real client or people names, tokens or chat ids
  in code, tests, examples or docs.
- Tests: `bun test` in `apps/ai-service` and `apps/agent-runner`; typecheck
  with `bunx tsc --noEmit` in the same folders.
- Inbox agent runs are described in `apps/agent-runner/README.md` (accesses,
  confirmations, Telegram, the assistant chat).
