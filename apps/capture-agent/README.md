# Capture Agent

Local desktop agent for GTD Automation. Periodically snapshots your active
window, runs OCR on it, and sends the captured text to the AI Service for
inbox classification.

Runs natively on your machine (not in Docker), because it needs access to
the screen and the active window. Talks to AI Service over HTTP using a
shared bearer token.

## Setup

```bash
cd apps/capture-agent
bun install
```

macOS users will be prompted to grant the agent **Screen Recording** and
**Accessibility** permissions on first run.

## Run

```bash
export AGENT_ENDPOINT=http://localhost:3030
export AGENT_AUTH_TOKEN=$HTTP_AUTH_TOKEN   # same as ai-service's HTTP_AUTH_TOKEN
bun run start
```

## Pause / resume

```bash
touch ~/.gtd-paused   # pause
rm ~/.gtd-paused      # resume
```

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `AGENT_ENDPOINT` | required | e.g. `http://localhost:3030` |
| `AGENT_AUTH_TOKEN` | required | matches AI Service `HTTP_AUTH_TOKEN` |
| `AGENT_INTERVAL_MS` | `60000` | snapshot interval |
| `AGENT_MIN_OCR_LENGTH` | `30` | skip captures with less text than this |
| `AGENT_OCR_LANG` | `eng` | tesseract code, e.g. `eng+rus` |
| `AGENT_EXCLUDED_APPS` | _(empty)_ | comma-separated, merged with defaults |
| `AGENT_EXCLUDED_TITLES` | _(empty)_ | comma-separated, merged with defaults |
| `AGENT_USE_DEFAULT_EXCLUSIONS` | `true` | set `false` to drop bundled defaults |
| `AGENT_PAUSE_FLAG` | `~/.gtd-paused` | path to pause file |

Default-excluded apps include 1Password, KeePass, Bitwarden, Keychain, Tor.
Default-excluded titles include `Incognito`, `Private Browsing`, `Login`,
`Sign in`, `Password`.
