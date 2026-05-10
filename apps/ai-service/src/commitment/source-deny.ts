/**
 * Source-deny filter — early pipeline guard that skips Proposer/Writer for
 * captures whose origin is a design/mockup tool, an AI artifact preview,
 * or a messenger where our own proposal cards land (TG self-loop).
 *
 * Capture still flows into Context Store (we want the surrounding context),
 * we just don't generate a Proposal.
 *
 * Configurable via env:
 *   COMMITMENT_DENY_APPS=Telegram,Figma,Sketch,...        (case-insensitive substring on sourceMeta.app)
 *   COMMITMENT_DENY_URL_PATTERNS=claude.ai/design,figma.com,/preview/,...   (case-insensitive substring on sourceMeta.url)
 *
 * Sensible defaults below cover the common cases observed in production
 * (see feedback_design_tool_false_positives.md).
 */

import type { CaptureRecord } from '../context-store/types'

export interface SourceDenyConfig {
  /** Substrings matched (case-insensitive) against sourceMeta.app. */
  apps: string[]
  /** Substrings matched (case-insensitive) against sourceMeta.url. */
  urlPatterns: string[]
}

export const DEFAULT_DENY_APPS: ReadonlyArray<string> = [
  // Messengers — agent's own TG-card self-loop, plus other chat apps where mockup
  // text often lives.
  'Telegram',
  'Slack',
  'Discord',
  // Design / mockup / prototyping tools.
  'Figma',
  'Sketch',
  'Framer',
  'Penpot',
  'Lunacy',
  'Principle',
  'OmniGraffle',
  'Affinity Designer',
  'Affinity Photo',
]

export const DEFAULT_DENY_URL_PATTERNS: ReadonlyArray<string> = [
  // Claude artifacts / design previews (the trigger that surfaced this fix).
  'claude.ai/design',
  'claude.ai/artifacts',
  'claude.ai/public/artifacts',
  // Figma / Framer canvases when opened in browser.
  'figma.com',
  'figma.app',
  'framer.com',
  // Generic design / preview / playground patterns — used by many tools and
  // app builders. Substring match is intentional (design subsystems often live
  // under `/design/` even on bespoke domains).
  '/design/',
  '/preview/',
  '/mockup/',
  '/template/',
  '/sandbox/',
  '/playground/',
  // Vercel previews, Netlify previews, localhost dev servers.
  '.vercel.app',
  '.netlify.app',
  'localhost:',
]

export interface SourceDenyResult {
  denied: boolean
  reason?: string
}

export function evaluateSourceDeny(
  capture: CaptureRecord,
  config: SourceDenyConfig
): SourceDenyResult {
  const meta = capture.sourceMeta ?? null
  if (!meta || typeof meta !== 'object') return { denied: false }

  const app = typeof meta.app === 'string' ? meta.app : ''
  const url = typeof meta.url === 'string' ? meta.url : ''

  if (app) {
    const appLower = app.toLowerCase()
    for (const needle of config.apps) {
      if (!needle) continue
      if (appLower.includes(needle.toLowerCase())) {
        return { denied: true, reason: `app:${needle}` }
      }
    }
  }

  if (url) {
    const urlLower = url.toLowerCase()
    for (const needle of config.urlPatterns) {
      if (!needle) continue
      if (urlLower.includes(needle.toLowerCase())) {
        return { denied: true, reason: `url:${needle}` }
      }
    }
  }

  return { denied: false }
}

export function denyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SourceDenyConfig {
  const customApps = parseList(env.COMMITMENT_DENY_APPS)
  const customUrls = parseList(env.COMMITMENT_DENY_URL_PATTERNS)
  const useDefaults = env.COMMITMENT_DENY_USE_DEFAULTS !== 'false'
  return {
    apps: useDefaults ? [...DEFAULT_DENY_APPS, ...customApps] : customApps,
    urlPatterns: useDefaults ? [...DEFAULT_DENY_URL_PATTERNS, ...customUrls] : customUrls,
  }
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
