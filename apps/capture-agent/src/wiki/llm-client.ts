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

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class LlmClient {
  constructor(private readonly config: LlmClientConfig) {}

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
