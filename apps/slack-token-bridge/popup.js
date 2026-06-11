const statusEl = document.getElementById('status')
const whenEl = document.getElementById('when')
const syncBtn = document.getElementById('sync')

function render(status) {
  if (!status) {
    statusEl.className = 'status muted'
    statusEl.textContent = 'No sync yet. Click "Push tokens now".'
    whenEl.textContent = ''
    return
  }
  if (status.ok) {
    statusEl.className = 'status ok'
    const teams = status.teams?.length ? `\n${status.teams.join(', ')}` : ''
    statusEl.textContent = `Pushed ${status.pushed}/${status.total} workspace(s).${teams}`
  } else {
    statusEl.className = 'status err'
    statusEl.textContent = status.error ?? 'Failed.'
  }
  whenEl.textContent = status.at ? new Date(status.at).toLocaleTimeString() : ''
}

async function load() {
  const { lastStatus } = await chrome.storage.local.get('lastStatus')
  render(lastStatus)
}

syncBtn.addEventListener('click', async () => {
  syncBtn.disabled = true
  syncBtn.textContent = 'Pushing…'
  const status = await chrome.runtime.sendMessage({ type: 'syncNow' })
  render(status)
  syncBtn.disabled = false
  syncBtn.textContent = 'Push tokens now'
})

document.getElementById('options').addEventListener('click', (e) => {
  e.preventDefault()
  chrome.runtime.openOptionsPage()
})

load()
