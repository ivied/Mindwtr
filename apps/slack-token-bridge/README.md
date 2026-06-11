# Slack Token Bridge

Chrome extension (Manifest V3) that lifts your Slack browser session
(`xoxc` token + `d` cookie) from every signed-in workspace and pushes it to the
GTD `ai-service`, so the agent can read what you read — including workspaces
where you can't install an OAuth app.

This is the no-install path: it reuses your own browser session, like Telethon
does for Telegram. It's against Slack's ToS and the `xoxc` token rotates, so
the extension re-pushes on a timer (default 30 min) and on browser startup to
keep the credential fresh.

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `apps/slack-token-bridge/` folder.
3. Click the extension → **Settings**:
   - **Endpoint**: `https://ai.kurdy.uk/v1/slack/session`
   - **Auth token**: your ai-service `HTTP_AUTH_TOKEN` (from `docker/.env`).
   - Save.
4. Make sure you're signed into your Slack workspaces at `app.slack.com`
   (one browser tab per workspace is enough — Slack stores all workspace
   tokens in one config blob, so a single tab usually covers all of them).
5. Click **Push tokens now**. The popup shows which workspaces were pushed.

After that it runs automatically on the refresh interval and on startup.

## How it works

- The `d` cookie is `HttpOnly` — page JS can't read it, but the extension can
  via `chrome.cookies`. That's why this is an extension and not a bookmarklet.
- The `xoxc` tokens live in each Slack tab's `localStorage.localConfig_v2`;
  the worker reads them via `chrome.scripting` in the MAIN world.
- It POSTs `{ token, cookie }` per workspace to `/v1/slack/session`. The
  ai-service runs `auth.test`, registers the workspace in the poller, and
  persists the credential so a service restart doesn't need a re-push.

## Notes

- Personal use only. Don't publish to the Chrome Web Store.
- If a workspace shows `invalid_auth`, sign back into Slack and re-push.
- Nothing is stored except in your browser's `chrome.storage` (endpoint +
  auth token) and the ai-service data volume (the session credentials).
