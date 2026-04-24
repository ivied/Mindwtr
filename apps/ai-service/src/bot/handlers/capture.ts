import type { Context } from 'grammy'
import type { CaptureFn } from '../../capture/sink'
import type { ClassificationResult } from '../../ai/types'
import { extractTextMessage, extractForward, extractPhotoCaption } from '../../capture/telegram'
import type { CapturedItem } from '../../capture/normalizer'

const CATEGORY_EMOJI: Record<string, string> = {
  next: '⚡',
  waiting: '⏸',
  someday: '💭',
  reference: '📚',
  two_minute: '⏱',
}

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
        onClassified: async (_taskId, result) => {
          await notifyClassification(ctx, result)
        },
      })
    } catch (err) {
      console.error('Capture failed:', err)
      await ctx.reply('❌ Не удалось сохранить. Попробуй ещё раз.')
    }
  }

  async function notifyClassification(
    ctx: Context,
    result: ClassificationResult
  ): Promise<void> {
    const emoji = CATEGORY_EMOJI[result.category] ?? '📋'
    const confidencePct = Math.round(result.confidence * 100)
    const contexts = result.suggested_contexts.join(' ')
    const flags: string[] = []
    if (result.is_noise) flags.push('🔕 noise')
    if (result.is_project) flags.push('📁 project')
    if (result.is_delegation) flags.push(`👥 → ${result.delegate_to ?? '?'}`)

    const lines = [
      `${emoji} Классифицировано: ${result.category} (${confidencePct}%)`,
      contexts && `Контексты: ${contexts}`,
      flags.length > 0 && flags.join('  '),
      `💡 ${result.reasoning}`,
    ].filter(Boolean)

    try {
      await ctx.reply(lines.join('\n'))
    } catch (err) {
      console.error('Notify failed:', err)
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
