/**
 * Capture Agent types — shared across modules.
 * Mirrors the AI Service POST /v1/capture payload contract.
 */

export interface ActiveWindowInfo {
  app: string
  title: string
  url?: string
  bundleId?: string
  pid?: number
}

export interface DesktopCapture {
  /** Active window app name */
  app: string
  /** Window title */
  windowTitle: string
  /** Optional URL when active app is a browser */
  url?: string
  /** Concatenated OCR text from the screenshot */
  ocrText: string
  /** When the snapshot was taken */
  capturedAt: string
}

export interface AgentConfig {
  /** AI Service base URL, e.g. http://localhost:3030 */
  endpoint: string
  /** Bearer token shared with AI Service HTTP_AUTH_TOKEN */
  authToken: string
  /** Snapshot interval in ms (default 60000) */
  intervalMs: number
  /** App names to skip (case-insensitive substring match) */
  excludedApps: string[]
  /** Window title substrings to skip */
  excludedTitles: string[]
  /** Path to a pause flag file — when present, agent skips capture */
  pauseFlagPath: string
  /** Minimum OCR text length required to send capture (filters empty/junk) */
  minOcrLength: number
  /** OCR language code(s), e.g. 'eng', 'eng+rus' */
  ocrLang: string
}
