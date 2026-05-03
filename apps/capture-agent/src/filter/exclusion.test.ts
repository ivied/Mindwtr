import { describe, it, expect } from 'bun:test'
import {
  shouldSkip,
  DEFAULT_EXCLUDED_APPS,
  DEFAULT_EXCLUDED_TITLES,
} from './exclusion'

describe('shouldSkip', () => {
  it('skips when app matches excluded list (case-insensitive)', () => {
    const skip = shouldSkip(
      { app: '1Password 7', title: 'Vault' },
      { excludedApps: ['1password'], excludedTitles: [] }
    )
    expect(skip).toBe(true)
  })

  it('skips when title contains an excluded substring', () => {
    const skip = shouldSkip(
      { app: 'Safari', title: 'GitHub Sign in' },
      { excludedApps: [], excludedTitles: ['Sign in'] }
    )
    expect(skip).toBe(true)
  })

  it('passes when neither app nor title match', () => {
    const skip = shouldSkip(
      { app: 'Safari', title: 'BBC News' },
      { excludedApps: ['1password'], excludedTitles: ['login'] }
    )
    expect(skip).toBe(false)
  })

  it('ignores empty entries in rule lists', () => {
    const skip = shouldSkip(
      { app: 'Safari', title: 'BBC' },
      { excludedApps: [''], excludedTitles: [''] }
    )
    expect(skip).toBe(false)
  })

  it('default app list catches password managers', () => {
    expect(
      shouldSkip(
        { app: 'Bitwarden', title: 'My vault' },
        { excludedApps: DEFAULT_EXCLUDED_APPS, excludedTitles: [] }
      )
    ).toBe(true)
  })

  it('default title list catches incognito windows', () => {
    expect(
      shouldSkip(
        { app: 'Chrome', title: 'New Incognito Tab' },
        { excludedApps: [], excludedTitles: DEFAULT_EXCLUDED_TITLES }
      )
    ).toBe(true)
  })
})
