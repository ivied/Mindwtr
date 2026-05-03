/**
 * Privacy filter: decide whether the current window/title should be captured.
 * All comparisons are case-insensitive substring matches.
 */

import type { ActiveWindowInfo } from '../types'

export interface ExclusionRules {
  excludedApps: string[]
  excludedTitles: string[]
}

export function shouldSkip(window: ActiveWindowInfo, rules: ExclusionRules): boolean {
  const app = window.app.toLowerCase()
  const title = window.title.toLowerCase()

  for (const banned of rules.excludedApps) {
    if (!banned) continue
    if (app.includes(banned.toLowerCase())) return true
  }
  for (const banned of rules.excludedTitles) {
    if (!banned) continue
    if (title.includes(banned.toLowerCase())) return true
  }
  return false
}

/**
 * Sane defaults for sensitive apps/titles. Users can override via env.
 */
export const DEFAULT_EXCLUDED_APPS = [
  '1Password',
  'KeePass',
  'Bitwarden',
  'Keychain Access',
  'Tor Browser',
]

export const DEFAULT_EXCLUDED_TITLES = [
  'Private Browsing',
  'Incognito',
  'Login',
  'Sign in',
  'Password',
]
