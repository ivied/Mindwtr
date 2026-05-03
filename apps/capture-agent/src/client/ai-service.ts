/**
 * HTTP client for AI Service POST /v1/capture.
 */

import type { DesktopCapture } from '../types'
import { captureToText } from '../capture/composer'

export interface AiServiceClientConfig {
  endpoint: string
  authToken: string
}

export class AiServiceClient {
  private base: string
  private headers: Record<string, string>

  constructor(config: AiServiceClientConfig) {
    this.base = config.endpoint.replace(/\/$/, '')
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.authToken}`,
    }
  }

  async sendCapture(capture: DesktopCapture): Promise<void> {
    const res = await fetch(`${this.base}/v1/capture`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        text: captureToText(capture),
        sourceChannel: 'screen_capture',
        type: 'text',
        timestamp: capture.capturedAt,
        sourceMeta: {
          app: capture.app,
          windowTitle: capture.windowTitle,
          url: capture.url,
        },
        extraTags: ['screen-capture'],
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`AI Service capture failed: ${res.status} ${text}`)
    }
  }

  async sendAudioTranscript(
    transcript: string,
    sourceMeta?: Record<string, unknown>
  ): Promise<void> {
    const res = await fetch(`${this.base}/v1/capture`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        text: transcript,
        sourceChannel: 'audio_capture',
        type: 'audio',
        timestamp: new Date().toISOString(),
        sourceMeta: sourceMeta ?? {},
        extraTags: ['audio-capture'],
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`AI Service audio capture failed: ${res.status} ${text}`)
    }
  }
}
