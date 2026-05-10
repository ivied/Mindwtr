/**
 * LLM-based entity extraction from a single capture.
 *
 * Returns canonical entities (project / person / repo / technology / place /
 * deadline) with a slug for the entity page filename and a short excerpt
 * showing why each entity was identified.
 */

import type { LlmClient } from './llm-client'

export type EntityType =
  | 'project'
  | 'person'
  | 'repository'
  | 'technology'
  | 'place'
  | 'deadline'
  | 'organization'

export interface Entity {
  slug: string
  name: string
  type: EntityType
  excerpt: string
}

export interface ExtractInput {
  app: string
  title: string
  url?: string
  source: 'audio' | 'screen'
  body: string
}

const SYSTEM_PROMPT = `You extract entities from a developer's screen-capture or speech-transcript snippet.

Return a JSON array. Each entity has:
- slug: lowercase kebab-case canonical id (e.g. "gtd-automation", "sergey-kurdyuk", "claude-opus-4-6")
- name: human-readable name
- type: one of project | person | repository | technology | place | deadline | organization
- excerpt: ≤80 characters from the input that justifies this entity

Rules:
- Only extract entities that are NAMED, SPECIFIC, and clearly referenced — not generic concepts.
- Skip generic words: "task", "code", "feature", "bug", "thing", "stuff".
- Skip UI chrome and OCR garbage. If the body looks like noise, return [].
- Same canonical slug across captures: prefer the most specific real name.
- Output ONLY valid JSON, no prose, no markdown fences.`

export async function extractEntities(
  llm: LlmClient,
  input: ExtractInput
): Promise<Entity[]> {
  const userPrompt = buildUserPrompt(input)
  const raw = await llm.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ])
  return parseEntitiesJson(raw)
}

function buildUserPrompt(input: ExtractInput): string {
  const truncatedBody = input.body.slice(0, 4000)
  const urlLine = input.url ? `URL: ${input.url}\n` : ''
  return `Source: ${input.source}
App: ${input.app}
Title: ${input.title}
${urlLine}Body:
${truncatedBody}`
}

export function parseEntitiesJson(raw: string): Entity[] {
  const cleaned = stripFences(raw).trim()
  if (!cleaned) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Entity[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    if (
      typeof e.slug === 'string' &&
      typeof e.name === 'string' &&
      typeof e.type === 'string' &&
      typeof e.excerpt === 'string'
    ) {
      const slug = normalizeSlug(e.slug)
      if (!slug) continue
      out.push({
        slug,
        name: e.name.trim().slice(0, 200),
        type: e.type as EntityType,
        excerpt: e.excerpt.trim().slice(0, 200),
      })
    }
  }
  return out
}

function stripFences(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  return m ? m[1]! : s
}

function normalizeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
