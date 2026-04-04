import { describe, it, expect } from 'vitest'
import { toTaskSuggestion, type CapturedItem } from './normalizer'

describe('toTaskSuggestion', () => {
  it('creates inbox task from short text', () => {
    const item: CapturedItem = {
      text: 'Buy milk',
      sourceChannel: 'telegram_dm',
      type: 'text',
      timestamp: '2026-04-03T12:00:00Z',
    }

    const suggestion = toTaskSuggestion(item)

    expect(suggestion.title).toBe('Buy milk')
    expect(suggestion.status).toBe('inbox')
    expect(suggestion.description).toBeUndefined()
    expect(suggestion.sourceMeta?.sourceChannel).toBe('telegram_dm')
    expect(suggestion.sourceMeta?.capturedAt).toBe('2026-04-03T12:00:00Z')
  })

  it('truncates title at 200 chars and puts full text in description', () => {
    const longText = 'A'.repeat(250)
    const item: CapturedItem = {
      text: longText,
      sourceChannel: 'telegram_forward',
      type: 'forward',
      timestamp: '2026-04-03T12:00:00Z',
      sourceMeta: { forwardFrom: 'Alice' },
    }

    const suggestion = toTaskSuggestion(item)

    expect(suggestion.title).toHaveLength(200)
    expect(suggestion.description).toBe(longText)
    expect(suggestion.sourceMeta?.forwardFrom).toBe('Alice')
  })

  it('preserves source metadata', () => {
    const item: CapturedItem = {
      text: 'Voice note content',
      sourceChannel: 'telegram_voice',
      type: 'voice',
      timestamp: '2026-04-03T14:30:00Z',
      sourceMeta: { duration: 15, chatId: 12345 },
    }

    const suggestion = toTaskSuggestion(item)

    expect(suggestion.sourceMeta?.duration).toBe(15)
    expect(suggestion.sourceMeta?.chatId).toBe(12345)
    expect(suggestion.sourceMeta?.sourceChannel).toBe('telegram_voice')
  })
})
