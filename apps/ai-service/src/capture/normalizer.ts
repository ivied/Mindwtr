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
