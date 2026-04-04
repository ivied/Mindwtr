import type { Context } from 'grammy'

export async function handleStart(ctx: Context) {
  await ctx.reply(
    '👋 Привет! Я GTD Automation Bot.\n\n' +
      'Отправляй мне всё что приходит в голову — текст, голосовые, пересылки. ' +
      'Я захвачу это и отправлю в твой GTD inbox.\n\n' +
      'Команды:\n' +
      '/inbox — показать inbox\n' +
      '/next — показать Next Actions\n' +
      '/help — помощь'
  )
}
