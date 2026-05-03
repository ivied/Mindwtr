/**
 * Active window provider — wraps active-win into an injectable interface.
 * Returns null if detection fails (e.g. permission missing on macOS).
 */

import activeWin from 'active-win'
import type { ActiveWindowInfo } from '../types'

export interface ActiveWindowProvider {
  current(): Promise<ActiveWindowInfo | null>
}

export const defaultActiveWindowProvider: ActiveWindowProvider = {
  async current() {
    try {
      const win = await activeWin()
      if (!win) return null
      return {
        app: win.owner.name,
        title: win.title,
        url: 'url' in win ? (win as { url?: string }).url : undefined,
        bundleId: 'bundleId' in win.owner ? (win.owner as { bundleId?: string }).bundleId : undefined,
        pid: win.owner.processId,
      }
    } catch {
      return null
    }
  },
}
