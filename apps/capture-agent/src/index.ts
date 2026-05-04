/**
 * Capture Agent entry point.
 *
 * Runs locally on the user's machine. Snapshots the active window every
 * AGENT_INTERVAL_MS, OCRs it, and POSTs the result to AI Service.
 * Sensitive apps and incognito windows are excluded by default.
 *
 * Pause anytime: `touch ~/.gtd-paused` (resume: `rm ~/.gtd-paused`).
 */

import { loadConfigFromEnv } from './config'
import { defaultScreenshotProvider } from './capture/screenshot'
import { TesseractOcrProvider } from './capture/ocr'
import { defaultActiveWindowProvider } from './capture/active-window'
import { startLoop } from './runner'
import { startAudioLoop } from './audio-runner'
import { AiServiceClient } from './client/ai-service'
import { CaptureDeduper } from './filter/dedup'
import { AudioRecorder } from './capture/audio-recorder'
import { WhisperClient } from './capture/whisper'

async function main() {
  const config = loadConfigFromEnv()
  const client = new AiServiceClient({
    endpoint: config.endpoint,
    authToken: config.authToken,
  })
  const ocr = new TesseractOcrProvider(config.ocrLang)

  console.log(`📸 Capture Agent starting`)
  console.log(`   endpoint: ${config.endpoint}`)
  console.log(`   interval: ${config.intervalMs}ms`)
  console.log(`   excluded apps: ${config.excludedApps.length}`)
  console.log(`   excluded titles: ${config.excludedTitles.length}`)
  console.log(`   pause flag: ${config.pauseFlagPath}`)

  const dedup = new CaptureDeduper()

  // --- Audio loop (Phase 4c, opt-in) ---
  let audioController: { stop: () => Promise<void> } | null = null
  if (config.audio.enabled) {
    if (!config.audio.openaiApiKey) {
      console.warn('⚠️ AGENT_AUDIO_ENABLED=true but no OPENAI/AGENT_OPENAI_API_KEY — audio disabled')
    } else {
      const recorder = new AudioRecorder({
        ffmpegPath: config.audio.ffmpegPath,
        sampleRate: 16000,
        inputDevice: config.audio.inputDevice,
      })
      const whisper = new WhisperClient({
        apiKey: config.audio.openaiApiKey,
        baseUrl: config.audio.openaiBaseUrl,
        language: config.audio.whisperLanguage,
        model: config.audio.whisperModel,
        prompt: config.audio.whisperPrompt,
      })
      audioController = startAudioLoop(
        {
          recorder,
          whisper,
          window: defaultActiveWindowProvider,
          rules: {
            excludedApps: config.excludedApps,
            excludedTitles: config.excludedTitles,
          },
          pauseFlagPath: config.pauseFlagPath,
          send: (text) =>
            client.sendAudioTranscript(text, { source: 'mic', device: config.audio.inputDevice }),
          log: (msg) => console.log(`[audio] ${msg}`),
        },
        {
          chunkMs: config.audio.chunkMs,
          energyThreshold: config.audio.energyThreshold,
          minTranscriptLength: 8,
        }
      )
      console.log(
        `🎤 Audio capture enabled (model ${config.audio.whisperModel}, chunk ${config.audio.chunkMs}ms, threshold ${config.audio.energyThreshold}, lang "${config.audio.whisperLanguage || 'auto'}")`
      )
    }
  }

  const loop = startLoop(
    {
      screenshot: defaultScreenshotProvider,
      ocr,
      window: defaultActiveWindowProvider,
      rules: {
        excludedApps: config.excludedApps,
        excludedTitles: config.excludedTitles,
      },
      pauseFlagPath: config.pauseFlagPath,
      minOcrLength: config.minOcrLength,
      sink: (capture) => client.sendCapture(capture),
      dedup,
      log: (msg) => console.log(`[agent] ${msg}`),
    },
    config.intervalMs
  )

  const shutdown = async () => {
    console.log('🛑 Shutting down agent...')
    await loop.stop()
    if (audioController) await audioController.stop()
    await ocr.shutdown()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
