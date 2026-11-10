# Working in this repository

This is a fork of Mindwtr that also carries a personal production stack (the
GTD service on the makurdi host). Upstream code lives in `apps/desktop`,
`apps/mobile`, `apps/cloud`, `packages/core`; the additions are
`apps/ai-service`, `apps/agent-runner` and `docker/`.

## Deploying

The runbook is `docker/cloud-prod/AGENT_INSTRUCTIONS.md` — read it before you
build, restart or deploy anything. The parts agents get wrong most often:

- **ai-service: restart, do not build.** The container runs
  `apps/ai-service/src` and `packages/core/src` from this checkout (bind
  mounts). After a code change: `docker compose restart ai-service` in
  `docker/`. Build its image only when dependencies or its Dockerfile changed.
- The same mount means uncommitted edits to those folders go live on the next
  restart. Finish or stash them before restarting.
- Any image build: one at a time, nothing else heavy alongside, and not while
  agent runs are `running` or `queued`. The host has 8 GB.
- Restart the agent runner (`launchctl kickstart -k
  gui/$(id -u)/uk.kurdy.gtd-agent-runner`) only when no run is `running` or
  `queued`; it reads `apps/agent-runner` from this checkout too.
- Never open `context.db` from the host while the container runs; use
  `docker exec ai-service …`.

## Conventions

- The repository is public: no real client or people names, tokens or chat ids
  in code, tests, examples or docs.
- Tests: `bun test` in `apps/ai-service` and `apps/agent-runner`; typecheck
  with `bunx tsc --noEmit` in the same folders.
- Inbox agent runs are described in `apps/agent-runner/README.md` (accesses,
  confirmations, Telegram, the assistant chat).
