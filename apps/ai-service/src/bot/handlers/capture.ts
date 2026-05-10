import type { Context } from 'grammy'
import type { CaptureFn } from '../../capture/sink'
import { extractTextMessage, extractForward, extractPhotoCaption } from '../../capture/telegram'
import type { CapturedItem } from '../../capture/normalizer'

export function createCaptureHandlers(capture: CaptureFn) {
  async function captureAndNotify(
    ctx: Context,
    item: CapturedItem,
    extraTags: string[] = []
  ): Promise<void> {
    try {
      await capture(item, {
        extraTags,
        onTaskCreated: async (_taskId, title) => {
          await ctx.reply(`📥 Captured → inbox\n"${title}"`, {
            reply_parameters: { message_id: ctx.message!.message_id },
          })
        },
      })
    } catch (err) {
      console.error('Capture failed:', err)
      await ctx.reply('❌ Не удалось сохранить. Попробуй ещё раз.')
    }
  }

  async function handleTextMessage(ctx: Context) {
    const item = extractTextMessage(ctx)
    if (!item) return
    await captureAndNotify(ctx, item)
  }

  async function handleForward(ctx: Context) {
    const item = extractForward(ctx)
    if (!item) return
    await captureAndNotify(ctx, item, ['forwarded'])
  }

  async function handlePhoto(ctx: Context) {
    const item = extractPhotoCaption(ctx)
    if (!item) {
      await ctx.reply('📷 Фото получено, но без подписи — добавь текст для capture.')
      return
    }
    await captureAndNotify(ctx, item)
  }

  return { handleTextMessage, handleForward, handlePhoto }
}
