import { describe, it, expect } from 'bun:test'
import { loadConfigFromEnv } from './config'

const baseEnv = {
  AGENT_ENDPOINT: 'http://localhost:3030',
  AGENT_AUTH_TOKEN: 'tok',
}

describe('loadConfigFromEnv', () => {
  it('throws when endpoint is missing', () => {
    expect(() => loadConfigFromEnv({ AGENT_AUTH_TOKEN: 'tok' })).toThrow(/AGENT_ENDPOINT/)
  })

  it('throws when auth token is missing', () => {
    expect(() => loadConfigFromEnv({ AGENT_ENDPOINT: 'http://x' })).toThrow(/AGENT_AUTH_TOKEN/)
  })

  it('returns parsed config with defaults', () => {
    const cfg = loadConfigFromEnv(baseEnv)
    expect(cfg.endpoint).toBe('http://localhost:3030')
    expect(cfg.authToken).toBe('tok')
    expect(cfg.intervalMs).toBe(60_000)
    expect(cfg.minOcrLength).toBe(30)
    expect(cfg.ocrLang).toBe('eng')
    expect(cfg.excludedApps).toContain('1Password')
    expect(cfg.excludedTitles).toContain('Incognito')
  })

  it('merges user app/title exclusions with defaults', () => {
    const cfg = loadConfigFromEnv({
      ...baseEnv,
      AGENT_EXCLUDED_APPS: 'Slack, Discord',
      AGENT_EXCLUDED_TITLES: 'Banking',
    })
    expect(cfg.excludedApps).toContain('1Password')
    expect(cfg.excludedApps).toContain('Slack')
    expect(cfg.excludedApps).toContain('Discord')
    expect(cfg.excludedTitles).toContain('Banking')
  })

  it('skips defaults when AGENT_USE_DEFAULT_EXCLUSIONS=false', () => {
    const cfg = loadConfigFromEnv({
      ...baseEnv,
      AGENT_USE_DEFAULT_EXCLUSIONS: 'false',
      AGENT_EXCLUDED_APPS: 'OnlyThis',
    })
    expect(cfg.excludedApps).toEqual(['OnlyThis'])
    expect(cfg.excludedTitles).toEqual([])
  })

  it('parses interval and min OCR length as numbers', () => {
    const cfg = loadConfigFromEnv({
      ...baseEnv,
      AGENT_INTERVAL_MS: '15000',
      AGENT_MIN_OCR_LENGTH: '100',
    })
    expect(cfg.intervalMs).toBe(15_000)
    expect(cfg.minOcrLength).toBe(100)
  })
})
