import type { Context } from 'grammy'

export async function handleStart(ctx: Context) {
  await ctx.reply(
    '👋 Привет! Я GTD Automation Bot.\n\n' +
      'Отправляй мне всё что приходит в голову — текст, голосовые, пересылки. ' +
      'Я захвачу это и отправлю в твой GTD inbox.\n\n' +
      'Команды:\n' +
      '/proposals — список pending AI-предложений\n' +
      '/whoami — твой chat id (нужен для TG_NOTIFY_CHAT_ID)\n' +
      '/help — помощь'
  )
}

export async function handleWhoami(ctx: Context) {
  const chatId = ctx.chat?.id
  await ctx.reply(
    chatId !== undefined
      ? `Chat id: \`${chatId}\`\n\nSet \`TG_NOTIFY_CHAT_ID\` to this value to receive proposal push notifications.`
      : 'Cannot determine chat id from this update.',
    { parse_mode: 'Markdown' }
  )
}
