import { describe, it, expect } from 'bun:test'
import {
  evaluateSourceDeny,
  denyConfigFromEnv,
  DEFAULT_DENY_APPS,
  DEFAULT_DENY_URL_PATTERNS,
} from './source-deny'
import type { CaptureRecord } from '../context-store/types'

function record(meta: Record<string, unknown> | null): CaptureRecord {
  return {
    id: 'cap',
    text: 'whatever',
    sourceChannel: 'screen_capture',
    sourceMeta: meta,
    capturedAt: '2026-05-06T22:00:00Z',
    receivedAt: '2026-05-06T22:00:00Z',
    contentHash: 'h',
    ttlAt: '2026-05-13T22:00:00Z',
    isPull: true,
  }
}

const DEFAULTS = { apps: [...DEFAULT_DENY_APPS], urlPatterns: [...DEFAULT_DENY_URL_PATTERNS] }

describe('evaluateSourceDeny', () => {
  it('denies Telegram app (TG self-loop guard)', () => {
    const out = evaluateSourceDeny(record({ app: 'Telegram', windowTitle: '' }), DEFAULTS)
    expect(out.denied).toBe(true)
    expect(out.reason).toMatch(/Telegram/)
  })

  it('denies claude.ai/design URL (the trigger that surfaced the fix)', () => {
    const out = evaluateSourceDeny(
      record({
        app: 'Google Chrome',
        url: 'https://claude.ai/design/p/019dff52-c366-7747-92fe-e3dc8e0a7958?file=STT+Overlay.html',
      }),
      DEFAULTS
    )
    expect(out.denied).toBe(true)
    expect(out.reason).toContain('claude.ai/design')
  })

  it('denies Figma app', () => {
    expect(evaluateSourceDeny(record({ app: 'Figma' }), DEFAULTS).denied).toBe(true)
  })

  it('denies generic /design/ path on bespoke domains', () => {
    expect(
      evaluateSourceDeny(record({ app: 'Chrome', url: 'https://acme.com/design/board' }), DEFAULTS)
        .denied
    ).toBe(true)
  })

  it('denies localhost dev server URLs', () => {
    expect(
      evaluateSourceDeny(record({ app: 'Chrome', url: 'http://localhost:3000/admin' }), DEFAULTS)
        .denied
    ).toBe(true)
  })

  it('does NOT deny ordinary apps with no design context', () => {
    expect(evaluateSourceDeny(record({ app: 'Mail' }), DEFAULTS).denied).toBe(false)
    expect(
      evaluateSourceDeny(record({ app: 'Chrome', url: 'https://news.ycombinator.com' }), DEFAULTS)
        .denied
    ).toBe(false)
  })

  it('case-insensitive app and url match', () => {
    expect(evaluateSourceDeny(record({ app: 'TELEGRAM' }), DEFAULTS).denied).toBe(true)
    expect(
      evaluateSourceDeny(record({ app: 'Chrome', url: 'https://CLAUDE.AI/Design/foo' }), DEFAULTS)
        .denied
    ).toBe(true)
  })

  it('treats null sourceMeta as not denied', () => {
    expect(evaluateSourceDeny(record(null), DEFAULTS).denied).toBe(false)
  })

  it('honors custom config — extra apps appended to defaults', () => {
    const cfg = { apps: ['Linear'], urlPatterns: [] }
    expect(evaluateSourceDeny(record({ app: 'Linear' }), cfg).denied).toBe(true)
    expect(evaluateSourceDeny(record({ app: 'Telegram' }), cfg).denied).toBe(false)
  })
})

describe('denyConfigFromEnv', () => {
  it('falls back to defaults when env unset', () => {
    const cfg = denyConfigFromEnv({})
    expect(cfg.apps).toContain('Telegram')
    expect(cfg.urlPatterns).toContain('claude.ai/design')
  })

  it('appends custom apps + urls to defaults', () => {
    const cfg = denyConfigFromEnv({
      COMMITMENT_DENY_APPS: 'Linear , Notion',
      COMMITMENT_DENY_URL_PATTERNS: '/internal-tool/',
    })
    expect(cfg.apps).toContain('Telegram') // default kept
    expect(cfg.apps).toContain('Linear')
    expect(cfg.apps).toContain('Notion')
    expect(cfg.urlPatterns).toContain('/internal-tool/')
  })

  it('replaces defaults entirely when COMMITMENT_DENY_USE_DEFAULTS=false', () => {
    const cfg = denyConfigFromEnv({
      COMMITMENT_DENY_USE_DEFAULTS: 'false',
      COMMITMENT_DENY_APPS: 'OnlyThis',
    })
    expect(cfg.apps).toEqual(['OnlyThis'])
    expect(cfg.urlPatterns).toEqual([])
  })
})
