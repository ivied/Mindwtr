import { describe, it, expect } from 'bun:test'
import { composeCapture, captureToText } from './composer'

describe('composeCapture', () => {
  it('builds a capture from window + ocr text', () => {
    const capture = composeCapture({
      window: { app: 'Safari', title: 'BBC News', url: 'https://bbc.com' },
      ocrText: '   Headline text   ',
      capturedAt: '2026-04-24T10:00:00Z',
    })
    expect(capture).toEqual({
      app: 'Safari',
      windowTitle: 'BBC News',
      url: 'https://bbc.com',
      ocrText: 'Headline text',
      capturedAt: '2026-04-24T10:00:00Z',
    })
  })

  it('defaults capturedAt to now when omitted', () => {
    const capture = composeCapture({
      window: { app: 'X', title: 'Y' },
      ocrText: 'z',
    })
    expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('captureToText', () => {
  it('formats with URL when present', () => {
    const text = captureToText({
      app: 'Safari',
      windowTitle: 'BBC News',
      url: 'https://bbc.com',
      ocrText: 'Body',
      capturedAt: 'now',
    })
    expect(text).toBe('[Safari · BBC News · https://bbc.com]\n\nBody')
  })

  it('formats without URL when missing', () => {
    const text = captureToText({
      app: 'Notes',
      windowTitle: 'Untitled',
      ocrText: 'Body',
      capturedAt: 'now',
    })
    expect(text).toBe('[Notes · Untitled]\n\nBody')
  })
})
