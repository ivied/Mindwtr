import { describe, it, expect } from 'bun:test'
import { detectVoiceChat } from './voice-chat-detect'

describe('detectVoiceChat', () => {
  it('returns inactive for null window', () => {
    expect(detectVoiceChat(null)).toEqual({ active: false })
  })

  it('flags Zoom by app name', () => {
    const r = detectVoiceChat({ app: 'zoom.us', title: 'Zoom Meeting' })
    expect(r.active).toBe(true)
    expect(r.reason).toContain('app:zoom')
  })

  it('flags Microsoft Teams by app name', () => {
    const r = detectVoiceChat({ app: 'Microsoft Teams', title: 'Standup' })
    expect(r.active).toBe(true)
    expect(r.reason).toContain('Microsoft Teams')
  })

  it('flags Google Meet by browser title', () => {
    const r = detectVoiceChat({ app: 'Google Chrome', title: 'Meet — abc-defg-hij' })
    expect(r.active).toBe(true)
    expect(r.reason).toContain('title:')
  })

  it('flags meet.google.com by url', () => {
    const r = detectVoiceChat({
      app: 'Google Chrome',
      title: 'Some page',
      url: 'https://meet.google.com/abc-defg-hij',
    })
    expect(r.active).toBe(true)
    expect(r.reason).toContain('url:meet.google.com')
  })

  it('does NOT flag generic Slack window', () => {
    expect(detectVoiceChat({ app: 'Slack', title: 'general — Slack' })).toEqual({ active: false })
  })

  it('flags Slack huddle by title', () => {
    const r = detectVoiceChat({ app: 'Slack', title: 'Slack | Huddle | engineering' })
    expect(r.active).toBe(true)
  })

  it('case-insensitive on app and title', () => {
    expect(detectVoiceChat({ app: 'DISCORD', title: '' }).active).toBe(true)
    expect(detectVoiceChat({ app: 'browser', title: 'IN-CALL with team' }).active).toBe(true)
  })
})
