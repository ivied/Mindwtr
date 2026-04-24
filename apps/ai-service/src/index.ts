import { MindwtrClient } from './api/mindwtr-client'
import { LLMClient } from './ai/client'
import { Classifier } from './ai/classifier'
import { ClassificationQueue } from './ai/queue'
import { createBot } from './bot'

const MINDWTR_CLOUD_URL = process.env.MINDWTR_CLOUD_URL ?? 'http://localhost:8787'
const MINDWTR_AUTH_TOKEN = process.env.MINDWTR_AUTH_TOKEN ?? ''
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? ''
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'cc/claude-opus-4-6'

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

  const bot = createBot(TELEGRAM_BOT_TOKEN, mindwtr, queue)

  console.log('🤖 AI Service starting...')
  await bot.start({
    onStart: () => console.log('🚀 Bot is running'),
  })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
