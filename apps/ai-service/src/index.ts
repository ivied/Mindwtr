import { MindwtrClient } from './api/mindwtr-client'
import { LLMClient } from './ai/client'
import { Classifier } from './ai/classifier'
import { ClassificationQueue } from './ai/queue'
import { createBot } from './bot'
import { createCaptureSink } from './capture/sink'
import type { Channel } from './channels/types'
import { SlackChannel } from './channels/slack'
import { NotionChannel } from './channels/notion'
import { FileStateStore, channelStateFile } from './channels/state-store'

const MINDWTR_CLOUD_URL = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
const MINDWTR_AUTH_TOKEN = process.env.MINDWTR_AUTH_TOKEN ?? ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? ''
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'cc/claude-opus-4-6'

const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? ''

const NOTION_API_KEY = process.env.NOTION_API_KEY ?? ''
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID ?? ''
const NOTION_POLL_INTERVAL_MS = Number(process.env.NOTION_POLL_INTERVAL_MS ?? 5 * 60 * 1000)

const DATA_DIR = process.env.DATA_DIR ?? '/app/data'

if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is required')
  process.exit(1)
}

if (!MINDWTR_AUTH_TOKEN) {
  console.error('MINDWTR_AUTH_TOKEN is required')
  process.exit(1)
}

const mindwtr = new MindwtrClient({
  baseUrl: MINDWTR_CLOUD_URL,
  authToken: MINDWTR_AUTH_TOKEN,
})

let queue: ClassificationQueue | null = null
if (LLM_BASE_URL && LLM_API_KEY) {
  const llm = new LLMClient(LLM_BASE_URL, LLM_API_KEY, LLM_MODEL)
  const classifier = new Classifier(llm)
  queue = new ClassificationQueue(classifier, mindwtr)
  console.log(`🧠 AI Classification enabled (${LLM_MODEL})`)
} else {
  console.warn('⚠️ LLM_BASE_URL or LLM_API_KEY not set — classification disabled')
}

const capture = createCaptureSink(mindwtr, queue)

function buildChannels(): Channel[] {
  const channels: Channel[] = []

  if (SLACK_APP_TOKEN && SLACK_BOT_TOKEN) {
    channels.push(
      new SlackChannel(
        { appToken: SLACK_APP_TOKEN, botToken: SLACK_BOT_TOKEN },
        (item) => capture(item)
      )
    )
    console.log('💬 Slack channel enabled')
  }

  if (NOTION_API_KEY && NOTION_DATABASE_ID) {
    const state = new FileStateStore(channelStateFile(DATA_DIR), 'notion')
    channels.push(
      new NotionChannel(
        { apiKey: NOTION_API_KEY, databaseId: NOTION_DATABASE_ID, pollIntervalMs: NOTION_POLL_INTERVAL_MS },
        (item) => capture(item),
        state
      )
    )
    console.log(`📝 Notion channel enabled (poll every ${NOTION_POLL_INTERVAL_MS}ms)`)
  }

  return channels
}

async function main() {
  // Wait for Mindwtr Cloud to be ready
  let retries = 10
  while (retries > 0) {
    const healthy = await mindwtr.healthCheck()
    if (healthy) break
    console.log(`Waiting for Mindwtr Cloud at ${MINDWTR_CLOUD_URL}...`)
    await new Promise((r) => setTimeout(r, 2000))
    retries--
  }

  if (retries === 0) {
    console.error(`Mindwtr Cloud not reachable at ${MINDWTR_CLOUD_URL}`)
    process.exit(1)
  }

  console.log(`✅ Connected to Mindwtr Cloud at ${MINDWTR_CLOUD_URL}`)

  if (queue) {
    queue.start()
    console.log('🔄 Classification queue started')
  }

  // Start additional channels
  const channels = buildChannels()
  for (const ch of channels) {
    try {
      await ch.start()
      console.log(`✅ ${ch.name} channel started`)
    } catch (err) {
      console.error(`Failed to start ${ch.name}:`, err)
    }
  }

  const bot = createBot(TELEGRAM_BOT_TOKEN, capture)

  const shutdown = async () => {
    console.log('🛑 Shutting down...')
    for (const ch of channels) {
      try {
        await ch.stop()
      } catch (err) {
        console.error(`Failed to stop ${ch.name}:`, err)
      }
    }
    if (queue) await queue.stop()
    await bot.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  console.log('🤖 AI Service starting...')
  await bot.start({
    onStart: () => console.log('🚀 Bot is running'),
  })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
