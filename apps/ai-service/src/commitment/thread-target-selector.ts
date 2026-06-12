/**
 * ThreadTargetSelector — picks WHERE an @ai-agent task should run.
 *
 * The deterministic `pickRoutingTargetTag` matcher (registry.ts) is fast but
 * brittle: it scores shared substrings/words, so naming drift ("Upwork Monitor"
 * playbook ↔ "Upwork API" repo) or a task phrased differently than its threads
 * silently falls back to openclaw. The thread list is small (≤120), so an LLM
 * can read the candidate sessions + the playbook hint and choose the right one
 * the way a human would.
 *
 * Used only when is_ai_routable=true (one extra short call per routed task).
 * Fail-open: any error, a low-confidence verdict, or no LLM client → the
 * deterministic matcher's tag, which itself defaults to openclaw. The user can
 * override the chip on approve, so a wrong guess costs one tap.
 */

import type { LLMClient } from '../ai/client'
import { TARGET_PREFIX } from './routing-target'
import { getThreadRegistry, pickRoutingTargetTag } from '../threads/registry'
import type { RegistryThread } from '../threads/registry-scan'

export interface TargetSelectionInput {
  title: string
  description?: string
  tags?: string[]
  /** Playbook hint (tool/repo/session the procedure named). May be empty. */
  targetHint?: string
}

const SELECT_TOOL = {
  type: 'function',
  function: {
    name: 'select_run_target',
    description:
      'Choose where an AI-agent task should run: an existing Claude Code thread (by session_id), a fresh thread in a repo, or the cloud OpenClaw worker.',
    parameters: {
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          enum: ['existing_thread', 'new_thread_in_repo', 'openclaw'],
          description:
            'existing_thread = resume a listed session that already works on this exact area. new_thread_in_repo = the right repo is present but no listed thread fits — start fresh there. openclaw = no local thread/repo fits, or it is generic cloud-runnable work.',
        },
        session_id: {
          type: 'string',
          description:
            'When choice=existing_thread: the EXACT session_id of the chosen thread from the candidate list. Empty otherwise.',
        },
        repo: {
          type: 'string',
          description:
            'When choice=new_thread_in_repo: the EXACT repo slug from the candidate list. Empty otherwise.',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'How sure you are this target fits. Below 0.6 the system ignores the verdict and falls back to keyword matching.',
        },
        reasoning: {
          type: 'string',
          description: 'One short sentence on why this target.',
        },
      },
      required: ['choice', 'session_id', 'repo', 'confidence', 'reasoning'],
    },
  },
} as const

const SELECT_PROMPT = `You route an AI-agent task to where it should run.

You are given:
- The task (title, description, tags) and an optional PLAYBOOK_HINT — a tool/
  repo/session name the user's recorded procedure pointed at.
- CANDIDATE_THREADS — recent Claude Code sessions, each with session_id, repo
  slug, repo label, last-touched date, and a short summary.

Pick the best run target:
- existing_thread when a listed session is clearly about the SAME area/project
  as the task (match on repo, summary, or the playbook hint — e.g. a hint
  "Upwork Monitor" matches a thread in the "Upwork API" repo). Prefer the most
  recently touched fitting thread. Return its EXACT session_id.
- new_thread_in_repo when the right repo appears among the candidates but no
  single thread fits — return the EXACT repo slug.
- openclaw when nothing local fits, or it is generic work that needs no
  specific repo (research, drafting, a one-off script).

Be honest with confidence: when no candidate clearly matches, return openclaw
or a sub-0.6 confidence rather than forcing a thread. Always call the tool.`

export class ThreadTargetSelector {
  constructor(
    private llm: LLMClient,
    private model?: string,
    /** Candidate cap fed to the model. Registry is already freshness-sorted. */
    private maxCandidates = 40
  ) {}

  /**
   * Returns a full `ai-target:` tag. LLM-first, deterministic fallback.
   * Never throws — routing must not block the enrichment proposal.
   */
  async selectTargetTag(input: TargetSelectionInput): Promise<string> {
    const fallback = () =>
      pickRoutingTargetTag(input.title, input.description, input.tags, input.targetHint)

    let threads: RegistryThread[]
    try {
      threads = getThreadRegistry().slice(0, this.maxCandidates)
    } catch {
      return fallback()
    }
    // No threads at all → openclaw (the matcher returns the same).
    if (threads.length === 0) return fallback()

    try {
      const tag = await this.askLlm(input, threads)
      return tag ?? fallback()
    } catch (err) {
      console.error('[thread-target] llm select failed:', (err as Error).message)
      return fallback()
    }
  }

  private async askLlm(
    input: TargetSelectionInput,
    threads: RegistryThread[]
  ): Promise<string | null> {
    const repos = [...new Set(threads.map((t) => t.repo))]
    const candidateLines = threads
      .map(
        (t) =>
          `- session_id=${t.sessionId} | repo=${t.repo} (${t.repoLabel}) | touched=${t.lastTouched} | ${t.alias}${t.summary ? ` — ${t.summary.slice(0, 100)}` : ''}`
      )
      .join('\n')

    const parts = [
      `Task title: ${input.title}`,
      input.description ? `Task description: ${input.description.slice(0, 500)}` : '',
      input.tags && input.tags.length > 0 ? `Task tags: ${input.tags.join(', ')}` : '',
      input.targetHint ? `PLAYBOOK_HINT: ${input.targetHint}` : '',
      `Repo slugs present: ${repos.join(', ')}`,
      `CANDIDATE_THREADS:\n${candidateLines}`,
    ].filter((s) => s.length > 0)

    const response = await this.llm.chatCompletion({
      messages: [
        { role: 'system', content: SELECT_PROMPT },
        { role: 'user', content: parts.join('\n\n') },
      ],
      tools: [SELECT_TOOL],
      tool_choice: 'required',
      temperature: 0.1,
      max_tokens: 200,
      model: this.model,
    })

    const toolCall = response.choices[0]?.message?.tool_calls?.[0]
    if (!toolCall) return null
    let parsed: {
      choice?: string
      session_id?: string
      repo?: string
      confidence?: number
    }
    try {
      parsed = JSON.parse(toolCall.function.arguments)
    } catch {
      return null
    }

    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
    if (confidence < 0.6) return null // let the deterministic fallback decide

    if (parsed.choice === 'existing_thread' && parsed.session_id) {
      // Trust only a session_id that is actually in the candidate list.
      if (threads.some((t) => t.sessionId === parsed.session_id)) {
        return `${TARGET_PREFIX}mac:${parsed.session_id}`
      }
      return null
    }
    if (parsed.choice === 'new_thread_in_repo' && parsed.repo) {
      if (threads.some((t) => t.repo === parsed.repo)) {
        return `${TARGET_PREFIX}mac-new:${parsed.repo}`
      }
      return null
    }
    if (parsed.choice === 'openclaw') {
      return `${TARGET_PREFIX}openclaw`
    }
    return null
  }
}
