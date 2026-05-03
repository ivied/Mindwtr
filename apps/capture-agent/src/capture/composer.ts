/**
 * Composes raw OCR text + active window metadata into a DesktopCapture
 * payload ready for the AI Service. Pure function for easy testing.
 */

import type { ActiveWindowInfo, DesktopCapture } from '../types'

export interface ComposeInput {
  window: ActiveWindowInfo
  ocrText: string
  capturedAt?: string
}

export function composeCapture({ window, ocrText, capturedAt }: ComposeInput): DesktopCapture {
  return {
    app: window.app,
    windowTitle: window.title,
    url: window.url,
    ocrText: ocrText.trim(),
    capturedAt: capturedAt ?? new Date().toISOString(),
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
