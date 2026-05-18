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
      // active-win ships an ad-hoc-signed Swift helper in node_modules.
      // macOS TCC can't durably grant Accessibility/Screen-Recording to an
      // unsigned CLI binary, so the prompt re-fires on every call forever
      // (sindresorhus/get-windows#135). We only need the app name + bundle
      // id for capture tagging — `title`/`url` are already visible in the
      // screenshot+OCR — so disable both permission checks: no prompt,
      // `title` comes back '' and `url` undefined, everything else stays.
      const win = await activeWin({
        accessibilityPermission: false,
        screenRecordingPermission: false,
      })
      if (!win) return null
      return {
        app: win.owner.name,
        title: win.title,
        url: 'url' in win ? (win as { url?: string }).url : undefined,
        bundleId: 'bundleId' in win.owner ? (win.owner as { bundleId?: string }).bundleId : undefined,
        pid: win.owner.processId,
        bounds:
          'bounds' in win
            ? (win as { bounds?: { x: number; y: number; width: number; height: number } }).bounds
            : undefined,
      }
    } catch {
      return null
    }
  },
}
