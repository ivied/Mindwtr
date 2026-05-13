/**
 * Append-only capture log writer.
 *
 * One MD file per capture event (screen or audio). YAML frontmatter holds
 * structured metadata; body is the raw text (OCR or transcript). Files never
 * get rewritten — entity pages with cross-links are built later by a separate
 * rollup pass over this corpus.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface CaptureEntry {
  source: 'audio' | 'screen'
  ts: Date
  app: string
  title: string
  url?: string
  body: string
  /** Audio-only metadata. */
  device?: string
  durationMs?: number
  model?: string
  rms?: number
  /** Screen-only: which display this capture is from. */
  displayIndex?: number
  displayName?: string
  displayPrimary?: boolean
  /** Screen-only: whether the focused window was on this display. */
  isActiveDisplay?: boolean
  /** Screen-only: whether this entry was sent to AI Service or wiki-only. */
  sentToInbox?: boolean
  /** Audio-only: voice-chat is likely active (Zoom/Teams/Meet/…). When
   *  true the transcript probably contains voices from other people in
   *  the call, so downstream (Proposer) should be conservative about
   *  treating utterances as the user's commitments. */
  likelyMixedSpeakers?: boolean
  /** Audio-only: why we flagged likelyMixedSpeakers (e.g. "app:zoom"). */
  voiceChatReason?: string
  /** Audio-only diarization output (FluidAudio). */
  speakerCount?: number
  /** True when at least one segment matched the enrolled user voice. */
  userSeen?: boolean
  /** Total ms attributed to the enrolled user in this chunk. */
  userSpeechMs?: number
  /** Total ms attributed to anyone else in this chunk. */
  otherSpeechMs?: number
}

export interface ImageAttachment {
  bytes: Buffer
  /** File extension without the dot, e.g. "jpg" or "png". */
  ext: string
}

export interface WriteResult {
  mdPath: string
  imagePath?: string
}

export interface WikiWriter {
  write(entry: CaptureEntry, opts?: { image?: ImageAttachment }): Promise<WriteResult>
}

export class MdWikiWriter implements WikiWriter {
  constructor(private readonly rootDir: string) {}

  async write(
    entry: CaptureEntry,
    opts: { image?: ImageAttachment } = {}
  ): Promise<WriteResult> {
    const id = randomUUID()
    const shortId = id.slice(0, 8)
    const dir = join(this.rootDir, 'captures', ...datePathSegments(entry.ts))
    const stem = `${timeSegment(entry.ts)}-${entry.source}-${shortId}`
    const mdPath = join(dir, `${stem}.md`)

    await mkdir(dir, { recursive: true })

    let imagePath: string | undefined
    let imageRef: string | undefined
    if (opts.image && entry.source === 'screen') {
      imageRef = `${stem}.${opts.image.ext}`
      imagePath = join(dir, imageRef)
      await writeFile(imagePath, opts.image.bytes)
    }

    await writeFile(mdPath, render(entry, id, imageRef), 'utf8')
    return { mdPath, imagePath }
  }
}

export function render(entry: CaptureEntry, id: string, imageRef?: string): string {
  const fm: Array<[string, string | number]> = [
    ['id', id],
    ['ts', entry.ts.toISOString()],
    ['source', entry.source],
    ['app', yamlString(entry.app)],
    ['title', yamlString(entry.title)],
  ]
  if (entry.url) fm.push(['url', yamlString(entry.url)])
  if (entry.device) fm.push(['device', yamlString(entry.device)])
  if (entry.durationMs !== undefined) fm.push(['duration_ms', entry.durationMs])
  if (entry.model) fm.push(['model', yamlString(entry.model)])
  if (entry.rms !== undefined) fm.push(['rms', Number(entry.rms.toFixed(4))])
  if (imageRef) fm.push(['image', yamlString(imageRef)])
  if (entry.displayIndex !== undefined) fm.push(['display_index', entry.displayIndex])
  if (entry.displayName) fm.push(['display_name', yamlString(entry.displayName)])
  if (entry.displayPrimary !== undefined)
    fm.push(['display_primary', entry.displayPrimary ? 'true' : 'false'])
  if (entry.isActiveDisplay !== undefined)
    fm.push(['active_display', entry.isActiveDisplay ? 'true' : 'false'])
  if (entry.sentToInbox !== undefined)
    fm.push(['sent_to_inbox', entry.sentToInbox ? 'true' : 'false'])
  if (entry.likelyMixedSpeakers !== undefined)
    fm.push(['likely_mixed_speakers', entry.likelyMixedSpeakers ? 'true' : 'false'])
  if (entry.voiceChatReason) fm.push(['voice_chat_reason', yamlString(entry.voiceChatReason)])
  if (entry.speakerCount !== undefined) fm.push(['speaker_count', entry.speakerCount])
  if (entry.userSeen !== undefined)
    fm.push(['user_seen', entry.userSeen ? 'true' : 'false'])
  if (entry.userSpeechMs !== undefined) fm.push(['user_speech_ms', entry.userSpeechMs])
  if (entry.otherSpeechMs !== undefined) fm.push(['other_speech_ms', entry.otherSpeechMs])

  const frontmatter = ['---', ...fm.map(([k, v]) => `${k}: ${v}`), '---'].join('\n')
  return `${frontmatter}\n\n${entry.body.trim()}\n`
}

function datePathSegments(ts: Date): string[] {
  return [pad(ts.getFullYear(), 4), pad(ts.getMonth() + 1, 2), pad(ts.getDate(), 2)]
}

function timeSegment(ts: Date): string {
  return `${pad(ts.getHours(), 2)}${pad(ts.getMinutes(), 2)}${pad(ts.getSeconds(), 2)}`
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

function yamlString(s: string): string {
  // Quote everything to keep colons, leading spaces, and unicode safe.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
