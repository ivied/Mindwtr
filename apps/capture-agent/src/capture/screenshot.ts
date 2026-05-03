/**
 * Screenshot provider — wraps screenshot-desktop into an injectable interface.
 */

import screenshot from 'screenshot-desktop'

export interface ScreenshotProvider {
  /** Capture full screen and return PNG bytes */
  capture(): Promise<Buffer>
}

export const defaultScreenshotProvider: ScreenshotProvider = {
  async capture() {
    return screenshot({ format: 'png' })
  },
}
