import { describe, it, expect } from 'vitest'
import { extractTextMessage, extractForward, extractPhotoCaption } from './telegram'
import type { Context } from 'grammy'

function mockCtx(message: Record<string, unknown>): Context {
  return { message } as unknown as Context
}

describe('extractTextMessage', () => {
  it('extracts text message', () => {
    const ctx = mockCtx({
      text: 'Hello world',
      date: 1712150400, // 2024-04-03T12:00:00Z
      chat: { id: 100 },
      message_id: 1,
      from: { username: 'sergey', first_name: 'Sergey' },
    })

    const result = extractTextMessage(ctx)

    expect(result).not.toBeNull()
    expect(result!.text).toBe('Hello world')
    expect(result!.sourceChannel).toBe('telegram_dm')
    expect(result!.type).toBe('text')
    expect(result!.sourceMeta?.chatId).toBe(100)
    expect(result!.sourceMeta?.from).toBe('sergey')
  })

  it('returns null for empty message', () => {
    const ctx = mockCtx({})
    expect(extractTextMessage(ctx)).toBeNull()
  })

  it('returns null when no text', () => {
    const ctx = mockCtx({ photo: [] })
    expect(extractTextMessage(ctx)).toBeNull()
  })
})

describe('extractForward', () => {
  it('extracts forwarded message', () => {
    const ctx = mockCtx({
      text: 'Forwarded content',
      date: 1712150400,
      chat: { id: 200 },
      message_id: 2,
      from: { first_name: 'Sergey' },
      forward_origin: { type: 'user', sender_user: { first_name: 'Alice' } },
    })

    const result = extractForward(ctx)

    expect(result).not.toBeNull()
    expect(result!.text).toBe('Forwarded content')
    expect(result!.sourceChannel).toBe('telegram_forward')
    expect(result!.type).toBe('forward')
  })

  it('returns null when no forward_origin', () => {
    const ctx = mockCtx({
      text: 'Normal message',
      date: 1712150400,
      chat: { id: 100 },
      message_id: 1,
    })

    expect(extractForward(ctx)).toBeNull()
  })

  it('extracts caption from forwarded photo', () => {
    const ctx = mockCtx({
      caption: 'Photo caption',
      date: 1712150400,
      chat: { id: 300 },
      message_id: 3,
      from: { username: 'sergey' },
      forward_origin: { type: 'user' },
    })

    const result = extractForward(ctx)

    expect(result).not.toBeNull()
    expect(result!.text).toBe('Photo caption')
  })
})

describe('extractPhotoCaption', () => {
  it('extracts photo with caption', () => {
    const ctx = mockCtx({
      caption: 'Check this out',
      date: 1712150400,
      chat: { id: 400 },
      message_id: 4,
      from: { username: 'sergey' },
    })

    const result = extractPhotoCaption(ctx)

    expect(result).not.toBeNull()
    expect(result!.text).toBe('Check this out')
    expect(result!.type).toBe('photo')
    expect(result!.sourceMeta?.hasPhoto).toBe(true)
  })

  it('returns null for photo without caption', () => {
    const ctx = mockCtx({
      date: 1712150400,
      chat: { id: 400 },
      message_id: 4,
    })

    expect(extractPhotoCaption(ctx)).toBeNull()
  })
})
