/**
 * Composes raw OCR text + active window metadata into a DesktopCapture
 * payload ready for the AI Service. Pure function for easy testing.
 */

import type { ActiveWindowInfo, DesktopCapture, DisplayInfo } from '../types'

export interface ComposeInput {
  window: ActiveWindowInfo
  ocrText: string
  capturedAt?: string
  display?: DisplayInfo
  isActiveDisplay?: boolean
}

export function composeCapture({
  window,
  ocrText,
  capturedAt,
  display,
  isActiveDisplay,
}: ComposeInput): DesktopCapture {
  // Non-active displays don't get the focused window's metadata — that
  // would be misleading. We mark them generically; per-display frontmost
  // detection is future work.
  const onActive = isActiveDisplay !== false
  return {
    app: onActive ? window.app : 'background',
    windowTitle: onActive ? window.title : '',
    url: onActive ? window.url : undefined,
    ocrText: ocrText.trim(),
    capturedAt: capturedAt ?? new Date().toISOString(),
    display,
    isActiveDisplay,
  }
}

/**
 * Build the text body that the AI Service will store as the inbox task title/body.
 * Format keeps the active context first (so titles look meaningful) and OCR after.
 */
export function captureToText(capture: DesktopCapture): string {
  const header = capture.url
    ? `[${capture.app} · ${capture.windowTitle} · ${capture.url}]`
    : `[${capture.app} · ${capture.windowTitle}]`
  return `${header}\n\n${capture.ocrText}`
}
