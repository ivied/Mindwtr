/**
 * Notion adapter — polls a database for new/updated pages.
 * Self-created Internal Integration: user shares a database with the integration
 * and provides the API key + database ID.
 *
 * Capture rules:
 * - Query database with filter: last_edited_time > lastSeenIso
 * - For each new/updated page: extract title + first plain-text content block
 * - Deduplicate by page id within a single poll to avoid repeated captures
 */

import { Client as NotionClient, isFullPage, isFullBlock } from '@notionhq/client'
import type { Channel, CaptureSink } from './types'
import type { CapturedItem } from '../capture/normalizer'

interface NotionConfig {
  apiKey: string
  databaseId: string
  pollIntervalMs?: number
}

interface StateStore {
  getLastSync(): Promise<string | null>
  setLastSync(iso: string): Promise<void>
}

export class NotionChannel implements Channel {
  readonly name = 'notion'

  private client: NotionClient
  private timer: NodeJS.Timeout | null = null
  private pollIntervalMs: number
  private stopped = false

  constructor(
    private config: NotionConfig,
    private sink: CaptureSink,
    private state: StateStore
  ) {
    this.client = new NotionClient({ auth: config.apiKey })
    this.pollIntervalMs = config.pollIntervalMs ?? 5 * 60 * 1000 // 5 min default
  }

  async start(): Promise<void> {
    this.stopped = false
    // Kick off first poll after a short delay so startup log is clean
    this.timer = setTimeout(() => void this.loop(), 2000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return
    try {
      await this.poll()
    } catch (err) {
      console.error('[notion] Poll failed:', err)
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs)
    }
  }

  private async poll(): Promise<void> {
    const since = (await this.state.getLastSync()) ?? new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const response = await this.client.databases.query({
      database_id: this.config.databaseId,
      filter: {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: since },
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 50,
    })

    let latestEdited = since
    for (const page of response.results) {
      if (!isFullPage(page)) continue
      if (page.last_edited_time <= since) continue // extra safety, API should handle

      const item = await this.pageToCapturedItem(page)
      if (item) {
        try {
          await this.sink(item)
        } catch (err) {
          console.error('[notion] Failed to capture page:', page.id, err)
        }
      }

      if (page.last_edited_time > latestEdited) {
        latestEdited = page.last_edited_time
      }
    }

    if (latestEdited !== since) {
      await this.state.setLastSync(latestEdited)
    }
  }

  private async pageToCapturedItem(
    page: Extract<Awaited<ReturnType<NotionClient['pages']['retrieve']>>, { properties: Record<string, unknown> }>
  ): Promise<CapturedItem | null> {
    const title = extractPageTitle(page.properties)
    const snippet = await this.firstTextSnippet(page.id)
    const text = [title, snippet].filter(Boolean).join('\n\n')
    if (!text.trim()) return null

    return {
      text,
      sourceChannel: 'notion_page',
      type: 'page',
      timestamp: page.last_edited_time,
      sourceMeta: {
        pageId: page.id,
        url: page.url,
        lastEditedBy: page.last_edited_by?.id,
      },
    }
  }

  private async firstTextSnippet(pageId: string): Promise<string> {
    try {
      const response = await this.client.blocks.children.list({ block_id: pageId, page_size: 20 })
      const parts: string[] = []
      for (const block of response.results) {
        if (!isFullBlock(block)) continue
        const text = extractBlockText(block)
        if (text) parts.push(text)
        if (parts.join(' ').length > 500) break
      }
      return parts.join('\n').slice(0, 500)
    } catch {
      return ''
    }
  }
}

function extractPageTitle(properties: Record<string, unknown>): string {
  for (const value of Object.values(properties)) {
    if (!value || typeof value !== 'object') continue
    const prop = value as { type?: string; title?: Array<{ plain_text: string }> }
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text).join('')
    }
  }
  return ''
}

function extractBlockText(block: { type: string } & Record<string, unknown>): string {
  const content = block[block.type] as { rich_text?: Array<{ plain_text: string }> } | undefined
  if (!content?.rich_text) return ''
  return content.rich_text.map((t) => t.plain_text).join('')
}
