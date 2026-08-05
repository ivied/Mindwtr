/**
 * Channel-agnostic capture normalizer.
 * Converts raw input from any channel into a unified CapturedItem format.
 */

export interface CapturedItem {
  /** Raw text content (or transcript for voice) */
  text: string
  /** Source channel identifier */
  sourceChannel:
    | 'telegram_dm'
    | 'telegram_forward'
    | 'telegram_voice'
    | 'telegram_user_dm'
    | 'telegram_group'
    | 'slack_dm'
    | 'slack_channel'
    | 'notion_page'
    | 'screen_capture'
    | 'audio_capture'
  /** Original message type */
  type: 'text' | 'voice' | 'forward' | 'photo' | 'document' | 'page' | 'audio'
  /** ISO timestamp of the original message */
  timestamp: string
  /** Channel-specific metadata */
  sourceMeta?: Record<string, unknown>
}

/**
 * Channels that are "pull/passive": they land in the Context Store and reach
 * the inbox only through the Commitment Detector (never create a task on
 * arrival). Single source of truth — both ContextStore (is_pull flag) and the
 * capture sink (push-vs-pull routing) import this. Keeping two copies in sync
 * silently broke Slack batching once; don't re-fork it.
 */
export const PULL_CHANNELS = new Set<CapturedItem['sourceChannel']>([
  'screen_capture',
  'audio_capture',
  'slack_dm',
  'slack_channel',
  'telegram_user_dm',
  'telegram_group',
])

export interface TaskSuggestion {
  title: string
  status: 'inbox'
  description?: string
  contexts?: string[]
  tags?: string[]
  sourceMeta: CapturedItem['sourceMeta'] & {
    sourceChannel: CapturedItem['sourceChannel']
    capturedAt: string
  }
}

/**
 * Convert a CapturedItem into a task suggestion for Mindwtr inbox.
 * For now, a simple pass-through. AI classification will enhance this later.
 */
export function toTaskSuggestion(item: CapturedItem): TaskSuggestion {
  return {
    title: item.text.slice(0, 200),
    status: 'inbox',
    description: item.text.length > 200 ? item.text : undefined,
    sourceMeta: {
      ...item.sourceMeta,
      sourceChannel: item.sourceChannel,
      capturedAt: item.timestamp,
    },
  }
}
