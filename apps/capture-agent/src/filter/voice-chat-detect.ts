/**
 * Detect whether the focused window suggests an active voice-chat session
 * (Zoom call, Teams meeting, Google Meet in browser, Discord voice, etc.).
 *
 * Used to tag audio captures with `likely_mixed: true` so the Proposer
 * knows the transcript may contain voices from other people in the call
 * and should be conservative about extracting commitments.
 *
 * Pure heuristic on active window's app + title — false negatives are
 * fine (we lose the tag), false positives are also fine (Proposer just
 * gets a hint, not a hard skip).
 */

import type { ActiveWindowInfo } from '../types'

/** App names whose mere presence usually implies a live voice-chat. */
const VOICE_CHAT_APPS = [
  'zoom.us',
  'zoom',
  'Microsoft Teams',
  'MicrosoftTeams',
  'Teams',
  'Webex',
  'Cisco Webex',
  'Discord',
  'FaceTime',
  'Skype',
  'WhatsApp',
]

/**
 * Browser windows hosting a meeting URL or showing the call UI. We can't
 * see the URL when the focused window isn't a tab we can read, but the
 * title nearly always contains a tell ("Meet — …", "(unread) — Slack" is
 * NOT a call; "Meet" or "Huddle" usually is).
 */
const VOICE_CHAT_TITLE_HINTS = [
  'Google Meet',
  'Meet — ',
  'Meet - ',
  'meet.google.com',
  'huddle',
  'Whereby',
  'Around',
  'Hangouts',
  'Slack | Huddle',
  '— Slack call',
  ' is calling',
  'Calling…',
  'In-call',
]

function caseInsensitiveIncludes(haystack: string, needles: string[]): string | null {
  const hay = haystack.toLowerCase()
  for (const n of needles) {
    if (hay.includes(n.toLowerCase())) return n
  }
  return null
}

export interface VoiceChatDetection {
  /** True when the active window strongly suggests a live voice call. */
  active: boolean
  /** Which rule fired, for debugging in frontmatter. */
  reason?: string
}

export function detectVoiceChat(window: ActiveWindowInfo | null): VoiceChatDetection {
  if (!window) return { active: false }

  const appHit = caseInsensitiveIncludes(window.app, VOICE_CHAT_APPS)
  if (appHit) return { active: true, reason: `app:${appHit}` }

  const titleHit = caseInsensitiveIncludes(window.title, VOICE_CHAT_TITLE_HINTS)
  if (titleHit) return { active: true, reason: `title:${titleHit}` }

  if (window.url) {
    const urlHit = caseInsensitiveIncludes(window.url, ['meet.google.com', 'zoom.us/j/', 'teams.live.com'])
    if (urlHit) return { active: true, reason: `url:${urlHit}` }
  }

  return { active: false }
}
