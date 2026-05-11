/**
 * Read agent configuration from env. Throws on missing required fields.
 */

import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfig } from './types'
import { DEFAULT_EXCLUDED_APPS, DEFAULT_EXCLUDED_TITLES } from './filter/exclusion'

function defaultNativeBinaryPath(): string {
  // Resolve relative to this file: src/config.ts → ../audio-helper/gtd-audio-capture
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'audio-helper', 'gtd-audio-capture')
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const endpoint = env.AGENT_ENDPOINT
  const authToken = env.AGENT_AUTH_TOKEN
  if (!endpoint) throw new Error('AGENT_ENDPOINT is required (e.g. http://localhost:3030)')
  if (!authToken) throw new Error('AGENT_AUTH_TOKEN is required (matches HTTP_AUTH_TOKEN of AI Service)')

  const intervalMs = Number(env.AGENT_INTERVAL_MS ?? 60_000)
  const excludedApps = parseList(env.AGENT_EXCLUDED_APPS)
  const excludedTitles = parseList(env.AGENT_EXCLUDED_TITLES)
  const useDefaults = env.AGENT_USE_DEFAULT_EXCLUSIONS !== 'false'

  return {
    endpoint,
    authToken,
    intervalMs,
    excludedApps: useDefaults ? [...DEFAULT_EXCLUDED_APPS, ...excludedApps] : excludedApps,
    excludedTitles: useDefaults
      ? [...DEFAULT_EXCLUDED_TITLES, ...excludedTitles]
      : excludedTitles,
    pauseFlagPath: env.AGENT_PAUSE_FLAG ?? join(homedir(), '.gtd-paused'),
    minOcrLength: Number(env.AGENT_MIN_OCR_LENGTH ?? 30),
    ocrLang: env.AGENT_OCR_LANG ?? 'eng',
    audio: {
      enabled: env.AGENT_AUDIO_ENABLED === 'true',
      openaiApiKey: env.AGENT_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? '',
      openaiBaseUrl: env.AGENT_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      whisperLanguage: env.AGENT_WHISPER_LANGUAGE ?? '',
      whisperModel: env.AGENT_WHISPER_MODEL ?? 'gpt-4o-mini-transcribe',
      whisperPrompt: env.AGENT_WHISPER_PROMPT ?? '',
      chunkMs: Number(env.AGENT_AUDIO_CHUNK_MS ?? 30_000),
      energyThreshold: Number(env.AGENT_AUDIO_ENERGY_THRESHOLD ?? 0.005),
      ffmpegPath: env.AGENT_FFMPEG_PATH ?? 'ffmpeg',
      inputDevice: env.AGENT_AUDIO_INPUT_DEVICE ?? ':default',
      audioFilter:
        env.AGENT_AUDIO_FILTER ??
        'highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11',
      backend: (env.AGENT_AUDIO_BACKEND ?? 'native') === 'ffmpeg' ? 'ffmpeg' : 'native',
      nativeBinaryPath: env.AGENT_AUDIO_HELPER_PATH ?? defaultNativeBinaryPath(),
      nativeNoVoiceProcessing: env.AGENT_AUDIO_NO_VP === 'true',
    },
    wiki: {
      dir: env.AGENT_WIKI_DIR ?? '',
      saveImage:
        (env.AGENT_WIKI_SAVE_IMAGE ?? env.AGENT_WIKI_SAVE_PNG ?? 'true') !== 'false',
      imageMaxEdge: Number(env.AGENT_WIKI_IMAGE_MAX_EDGE ?? 1920),
      imageQuality: Number(env.AGENT_WIKI_IMAGE_QUALITY ?? 70),
    },
    wikiOnlyApps:
      env.AGENT_WIKI_ONLY_APPS !== undefined
        ? parseList(env.AGENT_WIKI_ONLY_APPS)
        : ['Code', 'Cursor', 'Claude', 'Windsurf', 'Zed', 'Xcode'],
    multiDisplay: env.AGENT_MULTI_DISPLAY !== 'false',
  }
}
