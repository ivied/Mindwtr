import { describe, expect, it } from 'bun:test'
import type { Message } from '@mtcute/bun'
import { toCapturedItem } from './telegram-user'

interface StubOpts {
  text?: string
  isOutgoing?: boolean
  isService?: boolean
  isMention?: boolean
  senderIsBot?: boolean
  chatType?: 'user' | 'group' | 'supergroup' | 'channel'
}

function stubMessage(opts: StubOpts = {}): Message {
  const chatIsUser = (opts.chatType ?? 'user') === 'user'
  const chat = chatIsUser
    ? { type: 'user', id: 111, displayName: 'Alice' }
    : { type: 'chat', id: 222, chatType: opts.chatType, title: 'Work Group' }
  return {
    id: 42,
    text: opts.text ?? 'привет, глянь PR',
    isOutgoing: opts.isOutgoing ?? false,
    isService: opts.isService ?? false,
    isMention: opts.isMention ?? false,
    date: new Date('2026-07-01T12:00:00Z'),
    sender: { type: 'user', id: 111, displayName: 'Alice', isBot: opts.senderIsBot ?? false },
    chat,
  } as unknown as Message
}

describe('toCapturedItem (telegram-user)', () => {
  it('maps private DM to telegram_user_dm with identity meta', () => {
    const item = toCapturedItem(stubMessage())
    expect(item).not.toBeNull()
    expect(item!.sourceChannel).toBe('telegram_user_dm')
    expect(item!.text).toBe('привет, глянь PR')
    expect(item!.sourceMeta).toMatchObject({
      isDm: true,
      fromSelf: false,
      mentionsSelf: true,
      authorName: 'Alice',
      chatTitle: 'Alice',
    })
  })

  it('maps group message to telegram_group, mentionsSelf follows isMention', () => {
    const plain = toCapturedItem(stubMessage({ chatType: 'supergroup' }))
    expect(plain!.sourceChannel).toBe('telegram_group')
    expect(plain!.sourceMeta).toMatchObject({ isDm: false, mentionsSelf: false, chatTitle: 'Work Group' })

    const mentioned = toCapturedItem(stubMessage({ chatType: 'group', isMention: true }))
    expect(mentioned!.sourceMeta!.mentionsSelf).toBe(true)
  })

  it('skips channels/broadcasts', () => {
    expect(toCapturedItem(stubMessage({ chatType: 'channel' }))).toBeNull()
  })

  it('skips own outgoing, service, bot and empty messages', () => {
    expect(toCapturedItem(stubMessage({ isOutgoing: true }))).toBeNull()
    expect(toCapturedItem(stubMessage({ isService: true }))).toBeNull()
    expect(toCapturedItem(stubMessage({ senderIsBot: true }))).toBeNull()
    expect(toCapturedItem(stubMessage({ text: '   ' }))).toBeNull()
  })
})
