/**
 * OpenAI-compatible HTTP client for 9Router (Anthropic proxy).
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
}

interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Cooldown duration for a rate-limit / quota error, 0 when the error is not
 * one. The router wraps provider errors as 503 with messages like
 * "[codex/gpt-5.6-sol] [429]: Rate limit exceeded (reset after 17m 39s)" or
 * "[antigravity/...] [403]: HTTP 403 (reset after 1m 36s)". Honour the reset
 * hint (capped at 30 min), default to 60s when the hint is missing.
 */
export function rateLimitCooldownMs(message: string): number {
  const isRateLimit =
    /\[429\]|\[403\]|rate limit|quota|insufficient balance/i.test(message)
  if (!isRateLimit) return 0
  const reset = /reset after (?:(\d+)m\s*)?(\d+)s/i.exec(message)
  if (reset) {
    const minutes = Number(reset[1] ?? 0)
    const seconds = Number(reset[2] ?? 0)
    const ms = (minutes * 60 + seconds) * 1000
    return Math.min(ms, 30 * 60_000)
  }
  return 60_000
}

export class LLMClient {
  private readonly defaultModel: string
  /** Maps a model to the ordered list of models to try (itself first). */
  private readonly chainOf: Map<string, string[]>

  constructor(
    private baseUrl: string,
    private apiKey: string,
    models:
      | string
      | {
          opus: string
          sonnet: string
          fallbackOpus?: string
          fallbackSonnet?: string
        }
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    if (typeof models === 'string') {
      this.defaultModel = models
      this.chainOf = new Map()
    } else {
      // opus-tier requests fall back to sonnet and vice versa, so a single
      // model being down on the proxy degrades quality rather than failing.
      // The optional fallback pair sits behind both: when the whole primary
      // provider is out (shared quota pool), requests cross over to it.
      this.defaultModel = models.opus
      const chain = (...tries: Array<string | undefined>) => {
        const seen = new Set<string>()
        return tries.filter(
          (m): m is string => !!m && !seen.has(m) && !!seen.add(m)
        )
      }
      this.chainOf = new Map([
        [
          models.opus,
          chain(models.opus, models.sonnet, models.fallbackOpus, models.fallbackSonnet),
        ],
        [
          models.sonnet,
          chain(models.sonnet, models.opus, models.fallbackSonnet, models.fallbackOpus),
        ],
      ])
    }
  }

  /** Models currently rate-limited / quota-exhausted → epoch ms when to retry.
   *  Prevents hammering dead providers: observed 1200+ failed pipeline runs in
   *  6h, each burning a request on all 4 chain models and keeping the 429
   *  window permanently open. */
  private readonly cooldownUntil = new Map<string, number>()

  async chatCompletion(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string }
  ): Promise<ChatCompletionResponse> {
    const primary = request.model ?? this.defaultModel
    const chain = this.chainOf.get(primary) ?? [primary]
    let lastErr: unknown
    const now = Date.now()
    for (const model of chain) {
      const coolUntil = this.cooldownUntil.get(model) ?? 0
      if (coolUntil > now) {
        lastErr ??= new Error(
          `LLM (${model}) cooling down after rate limit (retry in ${Math.ceil((coolUntil - now) / 1000)}s)`
        )
        continue
      }
      try {
        const res = await this.send(request, model)
        // tool_choice=required but no tool call back (e.g. Gemini burning the
        // whole max_tokens budget on thinking → finish_reason=max_tokens with
        // partial text). HTTP 200, so without this check the fallback chain
        // never fires and the caller just gets a useless response.
        if (
          request.tool_choice === 'required' &&
          !res.choices?.[0]?.message?.tool_calls?.length
        ) {
          throw new Error(
            `LLM (${model}) returned no tool call (finish_reason=${res.choices?.[0]?.finish_reason})`
          )
        }
        return res
      } catch (err) {
        lastErr = err
        const cooldownMs = rateLimitCooldownMs((err as Error).message ?? '')
        if (cooldownMs > 0) {
          this.cooldownUntil.set(model, Date.now() + cooldownMs)
        }
      }
    }
    throw lastErr
  }

  private async send(
    request: Omit<ChatCompletionRequest, 'model'> & { model?: string },
    model: string
  ): Promise<ChatCompletionResponse> {
    // Claude Sonnet 5+ rejects `temperature` as deprecated (400). All our
    // callers used ≤0.3 anyway; drop the knob entirely rather than branch by
    // model family.
    const body: ChatCompletionRequest = {
      model,
      messages: request.messages,
      tools: request.tools,
      tool_choice: request.tool_choice,
      max_tokens: request.max_tokens ?? 2000,
      stream: false,
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      // lone surrogates from truncated OCR text make Anthropic reject the body (400).
      // Well-formed JSON.stringify escapes them as literal \udXXX (valid pairs stay raw),
      // so strip the escaped form.
      body: JSON.stringify(body).replace(/(?<!\\)\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g, ''),
      // the router can silently hold a dead connection open forever
      signal: AbortSignal.timeout(180_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM request failed: ${res.status} ${text}`)
    }

    return res.json() as Promise<ChatCompletionResponse>
  }
}
