import { describe, it, expect } from 'bun:test'
import { parseDiarizeJson } from './diarizer'

describe('parseDiarizeJson', () => {
  it('parses speakers + segments with user attribution', () => {
    const raw = JSON.stringify({
      schema: 1,
      user_speaker_id: 'user',
      speakers_seen: ['speaker_1', 'user'],
      speaker_count: 2,
      segments: [
        {
          speaker_id: 'user',
          is_user: true,
          start_ms: 0,
          end_ms: 5000,
          duration_ms: 5000,
          quality_score: 0.92,
        },
        {
          speaker_id: 'speaker_1',
          is_user: false,
          start_ms: 5000,
          end_ms: 12000,
          duration_ms: 7000,
          quality_score: 0.8,
        },
      ],
    })
    const r = parseDiarizeJson(raw)
    expect(r.speakerCount).toBe(2)
    expect(r.userSpeakerId).toBe('user')
    expect(r.userSeen).toBe(true)
    expect(r.userSpeechMs).toBe(5000)
    expect(r.otherSpeechMs).toBe(7000)
    expect(r.segments[0]!.isUser).toBe(true)
  })

  it('handles missing optional fields', () => {
    const raw = JSON.stringify({
      segments: [{ speaker_id: 'speaker_0', start_ms: 0, end_ms: 1000 }],
    })
    const r = parseDiarizeJson(raw)
    expect(r.speakerCount).toBe(1)
    expect(r.userSeen).toBe(false)
    expect(r.segments[0]!.durationMs).toBe(1000)
  })

  it('zero segments → counts default to 0', () => {
    const r = parseDiarizeJson(JSON.stringify({ segments: [] }))
    expect(r.speakerCount).toBe(0)
    expect(r.userSpeechMs).toBe(0)
    expect(r.otherSpeechMs).toBe(0)
  })
})
