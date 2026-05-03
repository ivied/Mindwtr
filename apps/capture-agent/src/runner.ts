/**
 * Capture loop. Pure orchestration — providers and sink are injected so that
 * the loop is fully testable without screenshot/OCR/network access.
 */

import type { ScreenshotProvider } from './capture/screenshot'
import type { OcrProvider } from './capture/ocr'
import type { ActiveWindowProvider } from './capture/active-window'
import type { ExclusionRules } from './filter/exclusion'
import { shouldSkip } from './filter/exclusion'
import { isPaused } from './filter/pause'
import { composeCapture } from './capture/composer'
import type { DesktopCapture } from './types'

export interface RunnerDeps {
  screenshot: ScreenshotProvider
  ocr: OcrProvider
  window: ActiveWindowProvider
  rules: ExclusionRules
  pauseFlagPath: string
  minOcrLength: number
  sink: (capture: DesktopCapture) => Promise<void>
  log?: (msg: string) => void
}

export type SkipReason =
  | 'paused'
  | 'no-window'
  | 'excluded'
  | 'low-ocr'
  | null

/**
 * Run a single capture iteration. Returns a skip reason or null when capture was sent.
 * Throws only on unexpected errors (network, etc.) so callers can decide whether
 * to keep looping (the standard `runOnce` path swallows nothing else).
 */
export async function runOnce(deps: RunnerDeps): Promise<SkipReason> {
  if (await isPaused(deps.pauseFlagPath)) return 'paused'

  const window = await deps.window.current()
  if (!window) return 'no-window'

  if (shouldSkip(window, deps.rules)) return 'excluded'

  const png = await deps.screenshot.capture()
  const text = await deps.ocr.recognize(png)
  if (text.length < deps.minOcrLength) return 'low-ocr'

  const capture = composeCapture({ window, ocrText: text })
  await deps.sink(capture)
  deps.log?.(`captured ${capture.app} · ${capture.windowTitle}`)
  return null
}

export interface LoopController {
  stop: () => Promise<void>
}

export function startLoop(deps: RunnerDeps, intervalMs: number): LoopController {
  let stopped = false
  let timer: NodeJS.Timeout | null = null

  const tick = async () => {
    if (stopped) return
    try {
      const skip = await runOnce(deps)
      if (skip) deps.log?.(`skipped: ${skip}`)
    } catch (err) {
      deps.log?.(`error: ${(err as Error).message ?? err}`)
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  // First tick after intervalMs (so startup is quiet); use 1s for very fast intervals
  timer = setTimeout(() => void tick(), Math.min(intervalMs, 1000))

  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
