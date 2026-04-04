/**
 * Telegram-specific capture extraction.
 * Converts grammY message types into CapturedItem format.
 */

import type { Context } from 'grammy'
import type { CapturedItem } from './normalizer'

export function extractTextMessage(ctx: Context): CapturedItem | null {
  const msg = ctx.message
  if (!msg?.text) return null

  return {
    text: msg.text,
    sourceChannel: 'telegram_dm',
    type: 'text',
    timestamp: new Date(msg.date * 1000).toISOString(),
    sourceMeta: {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      from: msg.from?.username ?? msg.from?.first_name,
    },
  }
}

export function extractForward(ctx: Context): CapturedItem | null {
  const msg = ctx.message
  if (!msg?.forward_origin) return null

  const text = msg.text ?? msg.caption ?? ''
  if (!text) return null

  return {
    text,
    sourceChannel: 'telegram_forward',
    type: 'forward',
    timestamp: new Date(msg.date * 1000).toISOString(),
    sourceMeta: {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      forwardOrigin: msg.forward_origin,
      from: msg.from?.username ?? msg.from?.first_name,
    },
  }
}

export function extractVoiceTranscript(ctx: Context, transcript: string): CapturedItem {
  const msg = ctx.message!
  return {
    text: transcript,
    sourceChannel: 'telegram_voice',
    type: 'voice',
    timestamp: new Date(msg.date * 1000).toISOString(),
    sourceMeta: {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      from: msg.from?.username ?? msg.from?.first_name,
      duration: (msg as unknown as { voice?: { duration?: number } }).voice?.duration,
    },
  }
}

export function extractPhotoCaption(ctx: Context): CapturedItem | null {
  const msg = ctx.message
  if (!msg?.caption) return null

  return {
    text: msg.caption,
    sourceChannel: 'telegram_dm',
    type: 'photo',
    timestamp: new Date(msg.date * 1000).toISOString(),
    sourceMeta: {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      from: msg.from?.username ?? msg.from?.first_name,
      hasPhoto: true,
    },
  }
}
