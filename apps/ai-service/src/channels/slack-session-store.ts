/**
 * Persists Slack browser-session credentials (xoxc token + d cookie) pushed by
 * the browser extension, so they survive an ai-service restart without the
 * user re-extracting. Keyed by teamId; one record per workspace.
 *
 * This file holds live session secrets — it lives on the same data volume as
 * context.db and is never committed. On restart, index.ts loads these and
 * re-arms each workspace via SlackChannel.upsertSessionWorkspace().
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface SlackSessionRecord {
  teamId: string
  teamName: string
  token: string
  cookie: string
  /** ISO timestamp of the last push from the extension. */
  updatedAt: string
}

export class SlackSessionStore {
  constructor(private filePath: string) {}

  async load(): Promise<SlackSessionRecord[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw) as Record<string, SlackSessionRecord>
      return Object.values(data)
    } catch {
      return []
    }
  }

  async upsert(rec: SlackSessionRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    let data: Record<string, SlackSessionRecord> = {}
    try {
      data = JSON.parse(await readFile(this.filePath, 'utf8')) as Record<string, SlackSessionRecord>
    } catch {
      // new file
    }
    data[rec.teamId] = rec
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}

export function slackSessionFile(dataDir: string): string {
  return join(dataDir, 'slack-sessions.json')
}
