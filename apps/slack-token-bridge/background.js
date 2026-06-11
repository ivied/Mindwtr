/**
 * Slack Token Bridge — service worker.
 *
 * Lifts the browser's Slack session for every signed-in workspace and pushes
 * { token: xoxc-..., cookie: xoxd-... } to the GTD ai-service. The xoxc token
 * lives in each workspace tab's localStorage; the d cookie is HttpOnly, so we
 * read it via chrome.cookies (a content script / page JS can't).
 *
 * Triggers: on install, on a periodic alarm, and on demand from the popup.
 */

const DEFAULTS = {
  // POST target. Override in the options page.
  endpoint: 'https://ai.kurdy.uk/v1/slack/session',
  // Bearer token = ai-service HTTP_AUTH_TOKEN. Set in options.
  authToken: '',
  // How often to re-push (minutes). Cheap; keeps the token fresh on rotation.
  intervalMin: 30,
}

async function getConfig() {
  const stored = await chrome.storage.sync.get(['endpoint', 'authToken', 'intervalMin'])
  return { ...DEFAULTS, ...stored }
}

/** The d cookie is shared across *.slack.com; one read covers all workspaces. */
async function readDCookie() {
  const cookie = await chrome.cookies.get({
    url: 'https://app.slack.com',
    name: 'd',
  })
  return cookie?.value ?? null
}

/**
 * Find every open Slack workspace tab and extract its xoxc token from
 * localStorage. Returns [{ teamId, token }]. Runs page JS via scripting since
 * localStorage isn't reachable from the worker.
 */
async function readWorkspaceTokens() {
  const tabs = await chrome.tabs.query({ url: 'https://app.slack.com/client/*' })
  const out = []
  const seenTeams = new Set()

  for (const tab of tabs) {
    if (!tab.id) continue
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // MAIN world so we can touch the page's localStorage.
        world: 'MAIN',
        func: () => {
          try {
            const cfg = JSON.parse(localStorage.localConfig_v2)
            const teams = cfg?.teams ?? {}
            // Return every team token the tab knows about, not just the active
            // one — Slack stores all signed-in workspaces in one config blob.
            return Object.entries(teams).map(([teamId, t]) => ({
              teamId,
              token: t?.token ?? null,
            }))
          } catch {
            return []
          }
        },
      })
      for (const entry of result?.result ?? []) {
        if (!entry?.token || !entry.teamId) continue
        if (seenTeams.has(entry.teamId)) continue
        seenTeams.add(entry.teamId)
        out.push(entry)
      }
    } catch (err) {
      console.warn('[bridge] token read failed for tab', tab.id, err?.message)
    }
  }
  return out
}

/** Push one workspace credential. Returns { ok, teamName?, error? }. */
async function pushOne(endpoint, authToken, token, cookie) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token, cookie }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}` }
    return { ok: true, teamName: body?.teamName }
  } catch (err) {
    return { ok: false, error: err?.message ?? 'network error' }
  }
}

/** Full sync cycle: read creds, push each workspace, record a status summary. */
export async function syncNow() {
  const { endpoint, authToken } = await getConfig()
  if (!authToken) {
    await setStatus({ ok: false, error: 'auth token not set (open Options)' })
    return { ok: false, error: 'auth token not set' }
  }

  const cookie = await readDCookie()
  if (!cookie) {
    await setStatus({ ok: false, error: 'no Slack d cookie — sign in to Slack in this browser' })
    return { ok: false, error: 'no d cookie' }
  }

  const tokens = await readWorkspaceTokens()
  if (tokens.length === 0) {
    await setStatus({ ok: false, error: 'no open Slack workspace tabs (open app.slack.com)' })
    return { ok: false, error: 'no workspace tabs' }
  }

  const results = []
  for (const { token } of tokens) {
    const r = await pushOne(endpoint, authToken, token, cookie)
    results.push(r)
  }

  const okCount = results.filter((r) => r.ok).length
  const teams = results.filter((r) => r.ok).map((r) => r.teamName).filter(Boolean)
  const errors = results.filter((r) => !r.ok).map((r) => r.error)
  const summary = {
    ok: okCount > 0,
    at: new Date().toISOString(),
    pushed: okCount,
    total: tokens.length,
    teams,
    error: errors.length ? errors.join('; ') : undefined,
  }
  await setStatus(summary)
  return summary
}

async function setStatus(status) {
  await chrome.storage.local.set({ lastStatus: status })
}

async function rearmAlarm() {
  const { intervalMin } = await getConfig()
  await chrome.alarms.clear('sync')
  chrome.alarms.create('sync', { periodInMinutes: Math.max(5, intervalMin) })
}

chrome.runtime.onInstalled.addListener(async () => {
  await rearmAlarm()
  await syncNow()
})

chrome.runtime.onStartup.addListener(async () => {
  await rearmAlarm()
  await syncNow()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') void syncNow()
})

// Popup → worker messages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'syncNow') {
    syncNow().then(sendResponse)
    return true // async response
  }
  if (msg?.type === 'rearm') {
    rearmAlarm().then(() => sendResponse({ ok: true }))
    return true
  }
  return false
})
