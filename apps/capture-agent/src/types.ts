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
  /** Window pixel rect; used to figure out which display the window is on. */
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface DisplayInfo {
  /** Stable index in the captureAll() array (0-based). */
  index: number
  /** Raw display id from screenshot-desktop. */
  id: number
  /** Display name, e.g. "Color LCD", "LS27D300G". */
  name: string
  primary: boolean
  /** Source PNG dimensions (before any wiki resize). */
  width: number
  height: number
}

export interface DesktopCapture {
  /** Active window app name (or "background" for non-active displays). */
  app: string
  /** Window title (empty for non-active displays). */
  windowTitle: string
  /** Optional URL when active app is a browser */
  url?: string
  /** Concatenated OCR text from the screenshot */
  ocrText: string
  /** When the snapshot was taken */
  capturedAt: string
  /** Which display this capture is from. Optional for back-compat with single-display callers. */
  display?: DisplayInfo
  /** True when the active window was on this display at capture time. */
  isActiveDisplay?: boolean
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
  /** Append-only capture log on disk (off when dir is empty). */
  wiki: WikiConfig
  /**
   * Apps where screen captures are written to the wiki but NOT sent to AI
   * Service (case-insensitive substring match). Typical entries: code
   * editors, LLM chat clients — content is useful for history/context but
   * rarely a real "task to put in inbox". Audio is unaffected.
   */
  wikiOnlyApps: string[]
  /** Capture all displays (true) or only the primary (false). */
  multiDisplay: boolean
}

export interface WikiConfig {
  /** Root dir for the wiki. Empty string disables archiving. */
  dir: string
  /** Persist screenshot images alongside MD entries. */
  saveImage: boolean
  /** Resize the longest edge of each screenshot to this many pixels (0 = no resize). */
  imageMaxEdge: number
  /** JPEG quality 1–100 when imageMaxEdge > 0. */
  imageQuality: number
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
