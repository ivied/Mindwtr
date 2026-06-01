/**
 * Routing target tag helpers — WHERE an @ai-agent task runs.
 *
 * Pure parse/format only; the live thread list and the pre-fill matcher live
 * in ../threads/registry (built by scanning ~/.claude/projects). The target
 * rides the existing tag machine alongside ai-stage:* / locked-by:*
 *
 *   ai-target:openclaw            → OpenClaw worker (cloud, fresh context)
 *   ai-target:mac:<sessionId>     → resume a local Claude Code thread on the Mac
 *   ai-target:mac-new:<repoSlug>  → fresh Claude Code thread in <repo> on the Mac
 */

export type ParsedTarget =
  | { kind: 'openclaw' }
  | { kind: 'mac-thread'; sessionId: string }
  | { kind: 'mac-new'; repo: string }

export const TARGET_PREFIX = 'ai-target:'

export function parseTargetTag(tags: string[] | undefined): ParsedTarget | null {
  const raw = (tags ?? []).find((t) => t.startsWith(TARGET_PREFIX))
  if (!raw) return null
  const body = raw.slice(TARGET_PREFIX.length)
  if (body === 'openclaw') return { kind: 'openclaw' }
  if (body.startsWith('mac-new:')) return { kind: 'mac-new', repo: body.slice('mac-new:'.length) }
  if (body.startsWith('mac:')) return { kind: 'mac-thread', sessionId: body.slice('mac:'.length) }
  return null
}
