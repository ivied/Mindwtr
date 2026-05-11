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
import { MdWikiWriter, type ImageAttachment } from './wiki/md-writer'
import { resizeToJpeg } from './wiki/image-processor'

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
  console.log(`   multi-display: ${config.multiDisplay}`)
  if (config.wikiOnlyApps.length)
    console.log(`   wiki-only apps: ${config.wikiOnlyApps.join(', ')}`)

  const wikiWriter = config.wiki.dir ? new MdWikiWriter(config.wiki.dir) : null
  if (wikiWriter) {
    const img = config.wiki.saveImage
      ? `JPEG@${config.wiki.imageQuality}, max ${config.wiki.imageMaxEdge}px`
      : 'off'
    console.log(`📝 Wiki archive: ${config.wiki.dir} (image: ${img})`)
  }

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
        audioFilter: config.audio.audioFilter,
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
          archive: wikiWriter
            ? async (ctx) => {
                await wikiWriter.write({
                  source: 'audio',
                  ts: ctx.ts,
                  app: ctx.window?.app ?? 'unknown',
                  title: ctx.window?.title ?? '',
                  url: ctx.window?.url,
                  device: config.audio.inputDevice,
                  durationMs: ctx.durationMs,
                  model: config.audio.whisperModel,
                  rms: ctx.rms,
                  body: ctx.text,
                })
              }
            : undefined,
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
      archive: wikiWriter
        ? async (capture, png) => {
            let image: ImageAttachment | undefined
            if (config.wiki.saveImage) {
              if (config.wiki.imageMaxEdge > 0) {
                try {
                  const jpg = await resizeToJpeg(png, {
                    maxEdge: config.wiki.imageMaxEdge,
                    quality: config.wiki.imageQuality,
                  })
                  image = { bytes: jpg, ext: 'jpg' }
                } catch (err) {
                  console.warn(`[wiki] resize failed, saving raw PNG: ${(err as Error).message}`)
                  image = { bytes: png, ext: 'png' }
                }
              } else {
                image = { bytes: png, ext: 'png' }
              }
            }
            const sent = (capture as { sentToInbox?: boolean }).sentToInbox
            await wikiWriter.write(
              {
                source: 'screen',
                ts: new Date(capture.capturedAt),
                app: capture.app,
                title: capture.windowTitle,
                url: capture.url,
                body: capture.ocrText,
                displayIndex: capture.display?.index,
                displayName: capture.display?.name,
                displayPrimary: capture.display?.primary,
                isActiveDisplay: capture.isActiveDisplay,
                sentToInbox: sent,
              },
              { image }
            )
          }
        : undefined,
      dedup,
      multiDisplay: config.multiDisplay,
      wikiOnlyApps: config.wikiOnlyApps,
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
