/**
 * Minimal file-based state store for channel sync checkpoints.
 * One JSON file per channel under DATA_DIR.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export class FileStateStore {
  constructor(
    private filePath: string,
    private key: string
  ) {}

  async getLastSync(): Promise<string | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const data = JSON.parse(raw) as Record<string, string>
      return data[this.key] ?? null
    } catch {
      return null
    }
  }

  async setLastSync(iso: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    let data: Record<string, string> = {}
    try {
      const raw = await readFile(this.filePath, 'utf8')
      data = JSON.parse(raw) as Record<string, string>
    } catch {
      // new file
    }
    data[this.key] = iso
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf8')
  }
}

export function channelStateFile(dataDir: string): string {
  return join(dataDir, 'channel-state.json')
}
