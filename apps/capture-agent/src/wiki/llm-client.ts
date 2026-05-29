/**
 * Minimal OpenAI-compatible chat-completions client. Used by the wiki rollup
 * to call whatever proxy the user has wired (e.g. cc/claude-opus-4-6).
 */

export interface LlmClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
}

/** A single content part — text, or an image (for vision models). */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  /** Plain string, or multimodal parts (text + image) for vision calls. */
  content: string | LlmContentPart[]
}

export class LlmClient {
  constructor(private readonly config: LlmClientConfig) {}

  /**
   * Convenience for a single vision turn: an image (base64 JPEG/PNG) plus a
   * text prompt, optionally with a system message. The image goes last so the
   * instruction is read first.
   */
  async chatWithImage(opts: {
    system?: string
    text: string
    imageBase64: string
    mime?: string
  }): Promise<string> {
    const parts: LlmContentPart[] = [
      { type: 'text', text: opts.text },
      {
        type: 'image_url',
        image_url: { url: `data:${opts.mime ?? 'image/jpeg'};base64,${opts.imageBase64}` },
      },
    ]
    const messages: LlmMessage[] = []
    if (opts.system) messages.push({ role: 'system', content: opts.system })
    messages.push({ role: 'user', content: parts })
    return this.chat(messages)
  }

  async chat(messages: LlmMessage[]): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: this.config.temperature ?? 0,
        stream: false,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`LLM ${res.status}: ${text.slice(0, 300)}`)
    }
    const data: { choices?: Array<{ message?: { content?: string } }> } = await res.json()
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error(`LLM response missing content: ${JSON.stringify(data).slice(0, 300)}`)
    }
    return content
  }
}
