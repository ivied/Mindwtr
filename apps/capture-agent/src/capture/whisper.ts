/**
 * OpenAI Whisper transcription client.
 *
 * Uses the audio/transcriptions endpoint (multipart/form-data) — same one
 * the OpenAI Python SDK calls. We POST the raw WAV buffer with model
 * "whisper-1" and get a text response back.
 *
 * Cost: $0.006/minute of audio (Apr 2026).
 */

export interface WhisperConfig {
  apiKey: string
  /** Override base URL, e.g. for proxy or compatible endpoint. */
  baseUrl?: string
  /** Whisper model. "whisper-1" is the only public option as of 2026-04. */
  model?: string
  /** Hint Whisper for source language ("en", "ru"). Empty string = auto. */
  language?: string
}

interface WhisperResponse {
  text: string
}

export class WhisperClient {
  private base: string
  private apiKey: string
  private model: string
  private language: string

  constructor(config: WhisperConfig) {
    this.apiKey = config.apiKey
    this.base = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.model = config.model ?? 'whisper-1'
    this.language = config.language ?? ''
  }

  /**
   * Transcribe a WAV/MP3 audio buffer. Returns the recognized text (trimmed).
   * Throws on non-2xx response so callers can decide retry vs skip.
   */
  async transcribe(audio: Buffer, mimeType = 'audio/wav'): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'chunk.wav')
    form.append('model', this.model)
    if (this.language) form.append('language', this.language)
    form.append('response_format', 'json')

    const res = await fetch(`${this.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Whisper transcribe failed: ${res.status} ${body.slice(0, 500)}`)
    }
    const json = (await res.json()) as WhisperResponse
    return (json.text ?? '').trim()
  }
}
