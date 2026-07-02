/**
 * One-time interactive Telegram user login. Creates the MTProto session file
 * that TelegramUserChannel reuses non-interactively.
 *
 * Designed to run non-TTY (e.g. driven by an agent): phone comes from
 * TELEGRAM_PHONE, and the login code / 2FA password are read by polling
 * TELEGRAM_CODE_FILE (default /tmp/tg-login-code.txt) — write the code into
 * that file when Telegram delivers it.
 *
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... TELEGRAM_PHONE=+44... \
 *   DATA_DIR=./data bun run scripts/telegram-login.ts
 *
 * Then copy `telegram-user-session*` into the ai-service data volume and
 * restart the service.
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'

const apiId = Number(process.env.TELEGRAM_API_ID ?? 0)
const apiHash = process.env.TELEGRAM_API_HASH ?? ''
const phone = process.env.TELEGRAM_PHONE ?? ''
const dataDir = process.env.DATA_DIR ?? './data'
const codeFile = process.env.TELEGRAM_CODE_FILE ?? '/tmp/tg-login-code.txt'

if (!apiId || !apiHash) {
  console.error('TELEGRAM_API_ID and TELEGRAM_API_HASH are required (my.telegram.org → API development tools)')
  process.exit(1)
}
if (!phone) {
  console.error('TELEGRAM_PHONE is required (international format, e.g. +447700900123)')
  process.exit(1)
}

async function pollCodeFile(label: string): Promise<string> {
  await rm(codeFile, { force: true })
  console.log(`⏳ waiting for ${label} in ${codeFile} ...`)
  for (let i = 0; i < 600; i++) {
    try {
      const value = (await readFile(codeFile, 'utf8')).trim()
      if (value) {
        await rm(codeFile, { force: true })
        console.log(`✓ got ${label}`)
        return value
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sessionPath = join(dataDir, 'telegram-user-session')
const tg = new TelegramClient({ apiId, apiHash, storage: sessionPath })

const self = await tg.start({
  phone,
  code: () => pollCodeFile('login code'),
  password: () => pollCodeFile('2FA password'),
})
console.log(`✅ logged in as ${self.displayName} (@${self.username ?? '—'})`)
console.log(`Session stored at: ${sessionPath}`)
await tg.destroy()
