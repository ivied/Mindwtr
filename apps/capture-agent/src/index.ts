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
import { AiServiceClient } from './client/ai-service'

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
      log: (msg) => console.log(`[agent] ${msg}`),
    },
    config.intervalMs
  )

  const shutdown = async () => {
    console.log('🛑 Shutting down agent...')
    await loop.stop()
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
