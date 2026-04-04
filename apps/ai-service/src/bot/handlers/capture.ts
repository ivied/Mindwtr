import type { Context } from 'grammy'
import type { MindwtrClient } from '../../api/mindwtr-client'
import { extractTextMessage, extractForward, extractPhotoCaption } from '../../capture/telegram'
import { toTaskSuggestion } from '../../capture/normalizer'

export function createCaptureHandlers(mindwtr: MindwtrClient) {
  async function handleTextMessage(ctx: Context) {
    const item = extractTextMessage(ctx)
    if (!item) return

    const suggestion = toTaskSuggestion(item)
    try {
      const task = await mindwtr.createTask({
        title: suggestion.title,
        status: 'inbox',
        description: suggestion.description,
      })
      await ctx.reply(`📥 Captured → inbox\n"${task.title}"`, {
        reply_parameters: { message_id: ctx.message!.message_id },
      })
    } catch (err) {
      console.error('Capture failed:', err)
      await ctx.reply('❌ Не удалось сохранить. Попробуй ещё раз.')
    }
  }

  async function handleForward(ctx: Context) {
    const item = extractForward(ctx)
    if (!item) return

    const suggestion = toTaskSuggestion(item)
    try {
      const task = await mindwtr.createTask({
        title: suggestion.title,
        status: 'inbox',
        description: suggestion.description,
        tags: ['forwarded'],
      })
      await ctx.reply(`📥 Forward captured → inbox\n"${task.title}"`, {
        reply_parameters: { message_id: ctx.message!.message_id },
      })
    } catch (err) {
      console.error('Forward capture failed:', err)
      await ctx.reply('❌ Не удалось сохранить пересылку.')
    }
  }

  async function handlePhoto(ctx: Context) {
    const item = extractPhotoCaption(ctx)
    if (!item) {
      await ctx.reply('📷 Фото получено, но без подписи — добавь текст для capture.')
      return
    }

    const suggestion = toTaskSuggestion(item)
    try {
      const task = await mindwtr.createTask({
        title: suggestion.title,
        status: 'inbox',
        description: suggestion.description,
      })
      await ctx.reply(`📥 Photo captured → inbox\n"${task.title}"`, {
        reply_parameters: { message_id: ctx.message!.message_id },
      })
    } catch (err) {
      console.error('Photo capture failed:', err)
      await ctx.reply('❌ Не удалось сохранить.')
    }
  }

  return { handleTextMessage, handleForward, handlePhoto }
}
