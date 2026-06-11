const endpointEl = document.getElementById('endpoint')
const authTokenEl = document.getElementById('authToken')
const intervalEl = document.getElementById('intervalMin')
const savedEl = document.getElementById('saved')

const DEFAULTS = {
  endpoint: 'https://ai.kurdy.uk/v1/slack/session',
  authToken: '',
  intervalMin: 30,
}

async function load() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) }
  endpointEl.value = cfg.endpoint
  authTokenEl.value = cfg.authToken
  intervalEl.value = cfg.intervalMin
}

document.getElementById('save').addEventListener('click', async () => {
  const intervalMin = Math.max(5, Number(intervalEl.value) || 30)
  await chrome.storage.sync.set({
    endpoint: endpointEl.value.trim(),
    authToken: authTokenEl.value.trim(),
    intervalMin,
  })
  // Re-arm the alarm so a new interval takes effect immediately.
  await chrome.runtime.sendMessage({ type: 'rearm' })
  savedEl.classList.add('show')
  setTimeout(() => savedEl.classList.remove('show'), 1500)
})

load()
