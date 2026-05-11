/**
 * Screenshot provider — wraps screenshot-desktop into an injectable
 * interface. Exposes both single-display and multi-display capture so the
 * runner can choose based on AGENT_MULTI_DISPLAY.
 */

import screenshot from 'screenshot-desktop'
import { pngDimensions } from './png-dimensions'
import type { DisplayInfo } from '../types'

export interface DisplayCapture {
  display: DisplayInfo
  png: Buffer
}

export interface ScreenshotProvider {
  /** Capture the primary screen and return PNG bytes (legacy, single-display). */
  capture(): Promise<Buffer>
  /** Capture every attached display and return PNGs + metadata. */
  captureAll(): Promise<DisplayCapture[]>
}

interface RawDisplay {
  id: number
  name: string
  primary?: boolean
}

export const defaultScreenshotProvider: ScreenshotProvider = {
  async capture() {
    return screenshot({ format: 'png' })
  },
  async captureAll() {
    const raws = (await screenshot.listDisplays()) as RawDisplay[]
    const out: DisplayCapture[] = []
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i]!
      const png = await screenshot({ format: 'png', screen: raw.id } as never)
      let width = 0
      let height = 0
      try {
        const dim = pngDimensions(png)
        width = dim.width
        height = dim.height
      } catch {
        // dimensions remain 0 — display-routing falls back to bounds-less behavior
      }
      out.push({
        display: {
          index: i,
          id: raw.id,
          name: raw.name,
          primary: Boolean(raw.primary),
          width,
          height,
        },
        png,
      })
    }
    return out
  },
}
