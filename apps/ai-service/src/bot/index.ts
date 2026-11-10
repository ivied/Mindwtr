import { Bot } from 'grammy'
import type { CaptureFn } from '../capture/sink'
import { handleStart, handleWhoami } from './handlers/start'
import { createCaptureHandlers } from './handlers/capture'
import { registerProposalHandlers, type ProposalBotDeps } from './handlers/proposals'

export interface CreateBotOptions {
  /** When provided, /proposals command is registered (read-only awareness, no decisions). */
  proposals?: ProposalBotDeps
  /**
   * A chat the bot only posts to (the agents' group with the assistant). What
   * people write there is not a capture and must not be answered.
   */
  silentChatId?: () => number | null
}

export function createBot(token: string, capture: CaptureFn, options: CreateBotOptions = {}) {
  const bot = new Bot(token)
  const handlers = createCaptureHandlers(capture)

  if (options.silentChatId) {
    const silent = options.silentChatId
    bot.use(async (ctx, next) => {
      if (ctx.chat && ctx.chat.id === silent()) return
      await next()
    })
  }

  bot.command('start', handleStart)
  bot.command('help', handleStart)
  bot.command('whoami', handleWhoami)

  if (options.proposals) {
    registerProposalHandlers(bot, options.proposals)
  }

  // Capture handlers — order matters
  bot.on('message:forward_origin', handlers.handleForward)
  bot.on('message:photo', handlers.handlePhoto)
  bot.on('message:text', handlers.handleTextMessage)

  bot.catch((err) => {
    console.error('Bot error:', err)
  })

  return bot
}
