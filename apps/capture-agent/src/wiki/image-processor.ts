/**
 * macOS-only image resizer/compressor — wraps `sips` so we don't pull in a
 * native image dep. Used to compress raw screen-capture PNGs (~2.5 MB each)
 * into JPEGs an order of magnitude smaller before persisting in the wiki.
 *
 * `sips` doesn't speak stdin/stdout reliably; we round-trip through temp
 * files, which is fine at one-per-minute capture cadence.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ResizeOptions {
  /** Max edge in pixels; image is scaled so the longest side equals this. */
  maxEdge: number
  /** JPEG quality 1–100. */
  quality: number
}

/**
 * Resize a PNG buffer to a JPEG buffer. Throws on sips failure — caller is
 * expected to fall back to the raw PNG.
 */
export async function resizeToJpeg(png: Buffer, opts: ResizeOptions): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'gtd-img-'))
  const inPath = join(dir, 'in.png')
  const outPath = join(dir, 'out.jpg')
  try {
    await writeFile(inPath, png)
    await runSips([
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      String(Math.max(1, Math.min(100, Math.round(opts.quality)))),
      '-Z',
      String(Math.max(1, Math.round(opts.maxEdge))),
      inPath,
      '--out',
      outPath,
    ])
    return await readFile(outPath)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runSips(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sips', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (b) => (stderr += b.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`sips exit ${code}: ${stderr.trim().slice(0, 300)}`))
    })
  })
}
