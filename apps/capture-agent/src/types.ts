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
  /** Audio capture (off by default) */
  audio: AudioConfig
}

export interface AudioConfig {
  /** Master toggle. False = audio capture not started. */
  enabled: boolean
  /** OpenAI API key for Whisper. Empty disables audio even when enabled=true. */
  openaiApiKey: string
  /** Optional Whisper baseUrl (proxies / compatible endpoints). */
  openaiBaseUrl: string
  /** Whisper hint language (e.g. 'en', 'ru'). Empty = auto-detect. */
  whisperLanguage: string
  /** Whisper model: whisper-1 | gpt-4o-mini-transcribe | gpt-4o-transcribe */
  whisperModel: string
  /** Whisper prompt to bias vocabulary (e.g. "GTD tasks, deadlines, names") */
  whisperPrompt: string
  /** Chunk length in ms (default 30s). */
  chunkMs: number
  /** RMS threshold for silence gating (0..1). */
  energyThreshold: number
  /** ffmpeg binary path. */
  ffmpegPath: string
  /** macOS avfoundation input device (":default" or ":<idx>"). */
  inputDevice: string
  /** ffmpeg -af filter chain (denoise + loudnorm). Empty string = disable. */
  audioFilter: string
}
