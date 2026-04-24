import { Bot } from 'grammy'
import type { MindwtrClient } from '../api/mindwtr-client'
import type { ClassificationQueue } from '../ai/queue'
import { handleStart } from './handlers/start'
import { createCaptureHandlers } from './handlers/capture'

export function createBot(
  token: string,
  mindwtr: MindwtrClient,
  queue: ClassificationQueue | null
) {
  const bot = new Bot(token)
  const capture = createCaptureHandlers(mindwtr, queue)

  bot.command('start', handleStart)
  bot.command('help', handleStart)

  // Capture handlers — order matters
  // Forwards first (have forward_origin), then specific types, then text fallback
  bot.on('message:forward_origin', capture.handleForward)
  bot.on('message:photo', capture.handlePhoto)
  bot.on('message:text', capture.handleTextMessage)

  bot.catch((err) => {
    console.error('Bot error:', err)
  })

  return bot
}
