import { Bot } from 'grammy'
import type { CaptureFn } from '../capture/sink'
import { handleStart } from './handlers/start'
import { createCaptureHandlers } from './handlers/capture'

export function createBot(token: string, capture: CaptureFn) {
  const bot = new Bot(token)
  const handlers = createCaptureHandlers(capture)

  bot.command('start', handleStart)
  bot.command('help', handleStart)

  // Capture handlers — order matters
  bot.on('message:forward_origin', handlers.handleForward)
  bot.on('message:photo', handlers.handlePhoto)
  bot.on('message:text', handlers.handleTextMessage)

  bot.catch((err) => {
    console.error('Bot error:', err)
  })

  return bot
}
