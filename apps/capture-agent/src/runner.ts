/**
 * Capture loop. Pure orchestration — providers and sink are injected so the
 * loop is fully testable without screenshot/OCR/network access.
 *
 * Multi-display semantics:
 * - When `multiDisplay` is true, every tick captures all attached displays.
 *   Each display is OCR'd, deduped, archived (wiki) and sent to AI Service
 *   (one sink call per display). Sending all displays is intentional:
 *   secondary monitors often carry actionable content (chats, mail) while
 *   the focused window sits on the primary.
 * - "Active display" is the one whose pixel rect contains the focused
 *   window's center. It still flows downstream via `isActiveDisplay` on the
 *   capture record so Proposer/Enricher can weight foreground vs background.
 * - When the focused window's app is in `wikiOnlyApps`, ALL displays are
 *   wiki-only for that tick — the captures are persisted for context but
 *   never proposed. (Rationale: when user is heads-down in a code editor,
 *   they're not asking the AI to scan their setup.)
 */

import type { DisplayCapture, ScreenshotProvider } from './capture/screenshot'
import type { OcrProvider } from './capture/ocr'
import type { ActiveWindowProvider } from './capture/active-window'
import { type ExclusionRules, shouldSkip } from './filter/exclusion'
import { isPaused } from './filter/pause'
import type { CaptureDeduper } from './filter/dedup'
import { composeCapture } from './capture/composer'
import { findActiveDisplayIndex } from './capture/display-routing'
import type { DesktopCapture } from './types'

export interface RunnerDeps {
  screenshot: ScreenshotProvider
  ocr: OcrProvider
  window: ActiveWindowProvider
  rules: ExclusionRules
  pauseFlagPath: string
  minOcrLength: number
  sink: (capture: DesktopCapture) => Promise<void>
  /** Optional fail-open hook for persistence (wiki MD + optional PNG). */
  archive?: (capture: DesktopCapture, png: Buffer) => Promise<void>
  dedup?: CaptureDeduper
  log?: (msg: string) => void
  /** Capture all attached displays per tick. Defaults to false (primary only). */
  multiDisplay?: boolean
  /** Apps where screen captures go to wiki but not to AI Service. */
  wikiOnlyApps?: string[]
}

export type SkipReason =
  | 'paused'
  | 'no-window'
  | 'excluded'
  | 'low-ocr'
  | 'duplicate'
  | 'wiki-only'
  | null

/**
 * Run a single capture iteration. Returns the result for the *active*
 * display — non-active displays are processed via archive but don't
 * influence the return value.
 */
export async function runOnce(deps: RunnerDeps): Promise<SkipReason> {
  if (await isPaused(deps.pauseFlagPath)) return 'paused'

  const window = await deps.window.current()
  if (!window) return 'no-window'

  if (shouldSkip(window, deps.rules)) return 'excluded'

  const displays = deps.multiDisplay
    ? await deps.screenshot.captureAll()
    : await captureSinglePrimary(deps.screenshot)

  if (displays.length === 0) return 'no-window'

  const activeIdx = findActiveDisplayIndex(
    window.bounds,
    displays.map((d) => ({
      primary: d.display.primary,
      width: d.display.width,
      height: d.display.height,
    }))
  )

  const wikiOnly = deps.wikiOnlyApps ?? []
  const focusedApp = window.app.toLowerCase()
  const focusedTitle = window.title.toLowerCase()
  const focusedAppIsWikiOnly = wikiOnly.some((rule) => {
    if (!rule) return false
    const r = rule.toLowerCase()
    return focusedApp.includes(r) || focusedTitle.includes(r)
  })

  let activeResult: SkipReason = 'no-window'
  for (let i = 0; i < displays.length; i++) {
    const { display, png } = displays[i]!
    const isActiveDisplay = i === activeIdx

    const text = await deps.ocr.recognize(png)
    if (text.length < deps.minOcrLength) {
      if (isActiveDisplay) activeResult = 'low-ocr'
      continue
    }

    const capture = composeCapture({
      window,
      ocrText: text,
      display,
      isActiveDisplay,
    })

    if (
      deps.dedup &&
      deps.dedup.isDuplicate({
        app: `${capture.app}@${display.index}`,
        windowTitle: capture.windowTitle,
        ocrText: capture.ocrText,
      })
    ) {
      if (isActiveDisplay) activeResult = 'duplicate'
      continue
    }

    const shouldSink = !focusedAppIsWikiOnly
    ;(capture as DesktopCapture & { sentToInbox?: boolean }).sentToInbox = shouldSink

    if (deps.archive) {
      try {
        await deps.archive(capture, png)
      } catch (err) {
        deps.log?.(`archive-error (non-fatal): ${(err as Error).message}`)
      }
    }

    if (shouldSink) {
      await deps.sink(capture)
      if (isActiveDisplay) activeResult = null
      deps.log?.(
        `captured ${capture.app} · ${capture.windowTitle} (display ${display.index}/${display.name}${isActiveDisplay ? ', active' : ', bg'})`
      )
    } else if (isActiveDisplay) {
      activeResult = 'wiki-only'
      deps.log?.(
        `wiki-only (focused app is wiki-only): ${capture.app} · display ${display.index}/${display.name}`
      )
    } else {
      deps.log?.(`wiki-only bg display ${display.index}/${display.name} (focused app is wiki-only)`)
    }

    deps.dedup?.markSent({
      app: `${capture.app}@${display.index}`,
      windowTitle: capture.windowTitle,
      ocrText: capture.ocrText,
    })
  }

  return activeResult
}

async function captureSinglePrimary(
  provider: ScreenshotProvider
): Promise<DisplayCapture[]> {
  const png = await provider.capture()
  return [
    {
      display: { index: 0, id: 0, name: 'primary', primary: true, width: 0, height: 0 },
      png,
    },
  ]
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
