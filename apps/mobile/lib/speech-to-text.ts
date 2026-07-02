import { Directory, File, Paths } from 'expo-file-system';
import { NativeModules, Platform } from 'react-native';
import type { AudioCaptureMode, AudioFieldStrategy, SpeechToTextSettings } from '@mindwtr/core';
import { logInfo, logWarn } from './app-log';
import {
  buildMultipartAudioPart,
  normalizeAudioUri,
  normalizeAudioUriForFileRead,
} from './speech-to-text.helpers';

export type SpeechProvider = 'openai' | 'gemini' | 'whisper';

export type SpeechToTextResult = {
  transcript: string;
  title?: string | null;
  description?: string | null;
  dueDate?: string | null;
  startTime?: string | null;
  projectTitle?: string | null;
  tags?: string[] | null;
  contexts?: string[] | null;
  language?: string | null;
};

export type CapturedAudio = {
  uri: string;
  platform: 'ios' | 'android';
  source: 'expo-recorder' | 'pcm-recorder';
  extension?: string;
};

export type LocalWhisperAudio = {
  uri: string;
  format: 'wav-pcm';
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  bytes: number;
  durationMs: number;
};

export type SpeechToTextConfig = {
  provider: SpeechProvider;
  apiKey?: string;
  model: string;
  language?: string;
  mode?: AudioCaptureMode;
  fieldStrategy?: AudioFieldStrategy;
  parseModel?: string;
  modelPath?: string;
  isFossBuild?: boolean;
  now?: Date;
  timeZone?: string;
};

export type WhisperRealtimeHandle = {
  stop: () => Promise<void>;
  result: Promise<SpeechToTextResult>;
  hasRealtimeTranscript: boolean;
};

type FetchOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const WHISPER_ANDROID_MAX_THREADS = 1;
const WHISPER_ANDROID_N_PROCESSORS = 1;
const LOCAL_WHISPER_SAMPLE_RATE = 16000;
const LOCAL_WHISPER_CHANNELS = 1;
const LOCAL_WHISPER_BITS_PER_SAMPLE = 16;
const LOCAL_WHISPER_MIN_DURATION_MS = 150;
const LOCAL_WHISPER_UNSUPPORTED_AUDIO_ERROR =
  'Local Whisper can only transcribe 16 kHz mono PCM WAV audio.';
const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-transcribe';
const DEFAULT_GEMINI_STT_MODEL = 'gemini-2.5-flash';
const DEFAULT_WHISPER_STT_MODEL = 'whisper-tiny';
const WHISPER_STT_MODEL_IDS = new Set([
  'whisper-tiny',
  'whisper-tiny.en',
  'whisper-base',
  'whisper-base.en',
]);
export const REMOTE_SPEECH_TO_TEXT_FOSS_ERROR =
  'Remote speech-to-text is not available in FOSS builds.';

type ExpoConstantsExtra = {
  isFossBuild?: unknown;
};

type ExpoConstantsLike = {
  appOwnership?: string | null;
  expoConfig?: {
    extra?: ExpoConstantsExtra | null;
  } | null;
};

type WhisperContextLike = {
  transcribe: (uri: string, options?: Record<string, unknown>) => { promise: Promise<unknown> };
  transcribeData?: (
    data: ArrayBuffer,
    options?: Record<string, unknown>
  ) => { stop: () => Promise<void>; promise: Promise<unknown> };
};

type WhisperRealtimeEventLike = {
  data?: unknown;
  sliceIndex?: number;
};

type AudioPcmStreamAdapterLike = object;

type AudioPcmStreamAdapterConstructor = new () => AudioPcmStreamAdapterLike;

type RealtimeTranscriberLike = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  release: () => Promise<void>;
};

type RealtimeTranscriberConstructor = new (
  dependencies: {
    whisperContext: WhisperContextLike;
    audioStream: AudioPcmStreamAdapterLike;
    fs: RNFSModule;
  },
  options: Record<string, unknown>,
  handlers: {
    onBeginTranscribe?: () => Promise<boolean>;
    onTranscribe?: (event: WhisperRealtimeEventLike) => void;
    onError?: (error: string) => void;
    onStatusChange?: (isActive: boolean) => void;
  }
) => RealtimeTranscriberLike;

let whisperContextCache: { modelPath: string; context: WhisperContextLike } | null = null;
let whisperNativeLogEnabled = false;
type WhisperModule = typeof import('whisper.rn');
let whisperModuleCache: WhisperModule | null = null;
let expoConstantsCache: ExpoConstantsLike | null | undefined;
let whisperRealtimeModuleCache:
  | {
    AudioPcmStreamAdapter: AudioPcmStreamAdapterConstructor;
    RealtimeTranscriber: RealtimeTranscriberConstructor;
  }
  | null
  | undefined;

type RNFSModule = typeof import('react-native-fs');
let rnfsModuleCache: RNFSModule | null | undefined;
let rnfsModuleRequireFailed = false;
let rnfsModuleImportFailed = false;

const isRNFSNativeModuleEvaluationError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('RNFSFileTypeRegular') || message.includes('RNFSManager');
};

const hasRNFSNativeModule = (): boolean => Boolean(
  (NativeModules as Record<string, unknown> | undefined)?.RNFSManager
);

const resolveRNFSModule = (value: unknown): RNFSModule | null => {
  const candidates = [
    value,
    value && typeof value === 'object' ? (value as { default?: unknown }).default : undefined,
  ];
  for (const candidate of candidates) {
    const mod = candidate as RNFSModule | undefined;
    const hasCoreFs = !!mod
      && typeof (mod as unknown as { writeFile?: unknown }).writeFile === 'function'
      && typeof (mod as unknown as { appendFile?: unknown }).appendFile === 'function'
      && typeof (mod as unknown as { readFile?: unknown }).readFile === 'function'
      && typeof (mod as unknown as { exists?: unknown }).exists === 'function'
      && typeof (mod as unknown as { unlink?: unknown }).unlink === 'function';
    if (hasCoreFs) return mod;
  }
  return null;
};

const getRNFSModule = (): RNFSModule | null => {
  if (rnfsModuleCache !== undefined) return rnfsModuleCache;
  if (!hasRNFSNativeModule()) {
    rnfsModuleRequireFailed = true;
    rnfsModuleImportFailed = true;
    rnfsModuleCache = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    rnfsModuleCache = resolveRNFSModule(require('react-native-fs'));
    return rnfsModuleCache;
  } catch (error) {
    rnfsModuleRequireFailed = isRNFSNativeModuleEvaluationError(error);
    rnfsModuleCache = null;
    return null;
  }
};

const getRNFSModuleAsync = async (): Promise<RNFSModule | null> => {
  const loaded = getRNFSModule();
  if (loaded || rnfsModuleRequireFailed || rnfsModuleImportFailed) return loaded;
  try {
    const imported = await import('react-native-fs');
    rnfsModuleCache = resolveRNFSModule(imported);
    return rnfsModuleCache;
  } catch (error) {
    rnfsModuleImportFailed = true;
    rnfsModuleRequireFailed = rnfsModuleRequireFailed || isRNFSNativeModuleEvaluationError(error);
    rnfsModuleCache = null;
    return null;
  }
};

const getWhisperModule = () => {
  if (whisperModuleCache) return whisperModuleCache;
  try {
    // Use static fallback paths so Metro can bundle this file.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('whisper.rn/src/index') as WhisperModule;
      whisperModuleCache = mod;
      return mod;
    } catch (sourceError) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require('whisper.rn') as WhisperModule;
        whisperModuleCache = mod;
        return mod;
      } catch (rootError) {
        const errors = [sourceError, rootError]
          .map((value) => (value instanceof Error ? value.message : String(value)))
          .join(' | ');
        throw new Error(`Whisper module unavailable: ${errors}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Whisper module unavailable: ${message}`);
  }
};

const getExpoConstants = (): ExpoConstantsLike | null => {
  if (expoConstantsCache !== undefined) return expoConstantsCache;
  try {
    // Delay loading expo-constants so non-Expo test environments can import this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-constants') as {
      default?: ExpoConstantsLike | { default?: ExpoConstantsLike };
    } | ExpoConstantsLike | undefined;
    const moduleDefault = (mod as { default?: ExpoConstantsLike | { default?: ExpoConstantsLike } } | undefined)?.default;
    expoConstantsCache = (
      (moduleDefault as { default?: ExpoConstantsLike } | undefined)?.default
      ?? (moduleDefault as ExpoConstantsLike | undefined)
      ?? (mod as ExpoConstantsLike | undefined)
      ?? null
    );
    return expoConstantsCache;
  } catch {
    expoConstantsCache = null;
    return null;
  }
};

const parseExtraBool = (value: unknown): boolean => value === true || value === 'true' || value === '1';

const isExpoGo = (): boolean => getExpoConstants()?.appOwnership === 'expo';

export const isMobileFossBuild = (): boolean => parseExtraBool(
  getExpoConstants()?.expoConfig?.extra?.isFossBuild
);

const getDefaultSpeechModel = (provider: SpeechProvider): string => {
  if (provider === 'openai') return DEFAULT_OPENAI_STT_MODEL;
  if (provider === 'gemini') return DEFAULT_GEMINI_STT_MODEL;
  return DEFAULT_WHISPER_STT_MODEL;
};

const normalizeSpeechProviderForRuntime = (
  provider: SpeechToTextSettings['provider'] | undefined,
  fossBuild: boolean
): { provider: SpeechProvider; enabledProvider: boolean } => {
  if (fossBuild) return { provider: 'whisper', enabledProvider: true };
  if (!provider) return { provider: 'gemini', enabledProvider: true };
  if (provider === 'parakeet') return { provider: 'whisper', enabledProvider: false };
  return { provider, enabledProvider: true };
};

const normalizeSpeechModelForRuntime = (model: string | undefined, provider: SpeechProvider): string => {
  if (model && (provider !== 'whisper' || WHISPER_STT_MODEL_IDS.has(model))) return model;
  return getDefaultSpeechModel(provider);
};

export type ResolvedSpeechToTextRuntimeSettings = {
  provider: SpeechProvider;
  enabled: boolean;
  model: string;
  modelPath?: string;
  language?: string;
  mode: AudioCaptureMode;
  fieldStrategy: AudioFieldStrategy;
  isFossBuild: boolean;
};

export const resolveSpeechToTextRuntimeSettings = (
  speech: SpeechToTextSettings | undefined,
  options?: { isFossBuild?: boolean }
): ResolvedSpeechToTextRuntimeSettings => {
  const fossBuild = options?.isFossBuild ?? isMobileFossBuild();
  const normalized = normalizeSpeechProviderForRuntime(speech?.provider, fossBuild);
  const model = normalizeSpeechModelForRuntime(speech?.model, normalized.provider);
  return {
    provider: normalized.provider,
    enabled: speech?.enabled === true && normalized.enabledProvider,
    model,
    modelPath: normalized.provider === 'whisper' ? speech?.offlineModelPath : undefined,
    language: speech?.language,
    mode: speech?.mode ?? 'smart_parse',
    fieldStrategy: speech?.fieldStrategy ?? 'smart',
    isFossBuild: fossBuild,
  };
};

const assertSpeechProviderAllowedForRuntime = (provider: SpeechProvider, fossBuild = isMobileFossBuild()): void => {
  if (!fossBuild || provider === 'whisper') return;
  void logWarn('Remote speech-to-text blocked in FOSS build', {
    scope: 'speech',
    force: true,
    extra: { provider },
  });
  throw new Error(REMOTE_SPEECH_TO_TEXT_FOSS_ERROR);
};

const getWhisperRealtimeModule = () => {
  if (whisperRealtimeModuleCache !== undefined) return whisperRealtimeModuleCache;
  try {
    // Delay loading Whisper realtime modules so generic task-edit tests can import this file
    // without a native audio stream implementation in the environment.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adapterModule = require(
      'whisper.rn/realtime-transcription/adapters/AudioPcmStreamAdapter.js'
    ) as { AudioPcmStreamAdapter?: AudioPcmStreamAdapterConstructor } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realtimeModule = require(
      'whisper.rn/realtime-transcription/index.js'
    ) as { RealtimeTranscriber?: RealtimeTranscriberConstructor } | undefined;
    if (!adapterModule?.AudioPcmStreamAdapter || !realtimeModule?.RealtimeTranscriber) {
      whisperRealtimeModuleCache = null;
      return null;
    }
    whisperRealtimeModuleCache = {
      AudioPcmStreamAdapter: adapterModule.AudioPcmStreamAdapter,
      RealtimeTranscriber: realtimeModule.RealtimeTranscriber,
    };
    return whisperRealtimeModuleCache;
  } catch (error) {
    void logWarn('Whisper realtime module unavailable', {
      scope: 'speech',
      force: true,
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    whisperRealtimeModuleCache = null;
    return null;
  }
};

const buildWhisperTranscribeOptions = (language: string): Record<string, unknown> => {
  const options: Record<string, unknown> = {};
  if (language !== 'auto') {
    options.language = language;
  }
  if (Platform.OS === 'android') {
    options.maxThreads = WHISPER_ANDROID_MAX_THREADS;
    options.nProcessors = WHISPER_ANDROID_N_PROCESSORS;
  }
  return options;
};

const bytesToBase64 = (bytes: Uint8Array) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    const hasB1 = typeof b1 === 'number';
    const hasB2 = typeof b2 === 'number';

    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);

    out += alphabet[(triplet >> 18) & 0x3f];
    out += alphabet[(triplet >> 12) & 0x3f];
    out += hasB1 ? alphabet[(triplet >> 6) & 0x3f] : '=';
    out += hasB2 ? alphabet[triplet & 0x3f] : '=';
  }
  return out;
};

const parseJsonResponse = (text: unknown): SpeechToTextResult => {
  if (typeof text !== 'string') {
    throw new Error('Speech parser returned non-text response.');
  }
  const cleaned = text.replace(/```json|```/gi, '').trim();
  if (!cleaned) {
    throw new Error('Speech parser returned empty response.');
  }
  return JSON.parse(cleaned) as SpeechToTextResult;
};

const getExtension = (uri: string) => {
  const match = uri.match(/\.[a-z0-9]+$/i);
  return match ? match[0] : '.m4a';
};

const getMimeType = (uri: string) => {
  const extension = getExtension(uri);
  switch (extension.toLowerCase()) {
    case '.aac':
      return 'audio/aac';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.caf':
      return 'audio/x-caf';
    case '.3gp':
    case '.3gpp':
      return 'audio/3gpp';
    case '.webm':
      return 'audio/webm';
    case '.m4a':
    default:
      return 'audio/mp4';
  }
};

const resolveLanguage = (value?: string) => {
  if (!value) return 'auto';
  const trimmed = value.trim();
  if (!trimmed) return 'auto';
  const normalized = trimmed.toLowerCase();
  if (normalized === 'auto') return 'auto';
  const base = normalized.split(/[-_]/)[0];
  const map: Record<string, string> = {
    english: 'en',
    en: 'en',
    spanish: 'es',
    espanol: 'es',
    es: 'es',
  };
  return map[base] ?? base;
};

const buildSmartPrompt = ({
  fieldStrategy,
  language,
  now,
  timeZone,
}: {
  fieldStrategy: AudioFieldStrategy;
  language: string;
  now: Date;
  timeZone?: string;
}) => {
  return `
You are a personal assistant converting a voice note into a GTD task.

Audio language: ${language === 'auto' ? 'Detect automatically' : language}
Current date/time: ${now.toISOString()}
Time zone: ${timeZone || 'local'}

Return ONLY valid JSON with these keys:
{
  "transcript": "string",
  "title": "string or null",
  "description": "string or null",
  "dueDate": "ISO 8601 string or null",
  "startTime": "ISO 8601 string or null",
  "projectTitle": "string or null",
  "tags": ["#tag"] or [],
  "contexts": ["@context"] or [],
  "language": "detected language name or code"
}

Field strategy: ${fieldStrategy}
- smart: If transcript is short (<= 15 words), use it verbatim as title and leave description empty. If longer, create a concise 3-7 word title and put the full transcript in description.
- title_only: Put the full transcript in title and leave description empty.
- description_only: Keep title empty and put the full transcript in description.

Extract any dates/times and convert to ISO 8601 using the current date/time for relative phrases (e.g., "tomorrow 5pm").
If a field is unknown, return null or an empty array.
  `.trim();
};

const buildTranscriptionPrompt = (language: string) => {
  return `
Transcribe the audio into plain text.
Audio language: ${language === 'auto' ? 'Detect automatically' : language}

Return ONLY valid JSON with these keys:
{
  "transcript": "string",
  "language": "detected language name or code"
}
  `.trim();
};

const fetchJson = async (url: string, init: RequestInit, options?: FetchOptions) => {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (options?.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || `Request failed (${response.status})`);
    }
    const data = await response.json();
    return data as Promise<unknown>;
  } finally {
    clearTimeout(handle);
  }
};

type OpenAIUploadStrategy = 'blob' | 'uri';

const buildOpenAIMultipartPayload = async (
  audioUri: string,
  strategy: OpenAIUploadStrategy
): Promise<{
  part: Blob | { uri: string; name: string; type: string };
  fileName?: string;
  meta: Record<string, string>;
}> => {
  const uploadUri = normalizeAudioUri(audioUri);
  const fileReadUri = normalizeAudioUriForFileRead(audioUri);
  const file = new File(fileReadUri);
  const name = file.name || `audio${getExtension(uploadUri)}`;
  const type = file.type || getMimeType(uploadUri);
  const uriScheme = uploadUri.split(':')[0] || 'unknown';
  const baseMeta = {
    strategy,
    uriScheme,
    fileName: name,
    mimeType: type,
    fileExists: String(Boolean(file.exists)),
    fileSize: String(typeof file.size === 'number' ? file.size : 0),
    expoGo: String(isExpoGo()),
  };

  if (strategy === 'blob') {
    let bytes: Uint8Array | null = null;
    try {
      bytes = await file.bytes();
    } catch (error) {
      throw new Error(
        `Failed to read audio bytes for Blob upload: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const { part, fileName } = buildMultipartAudioPart({
      uri: uploadUri,
      name,
      type,
      bytes,
    });
    if (fileName && part instanceof Blob) {
      return {
        part,
        fileName,
        meta: {
          ...baseMeta,
          byteLength: String(bytes.byteLength),
        },
      };
    }
    throw new Error('Blob upload requested but Blob multipart part could not be created.');
  }

  return {
    part: { uri: uploadUri, name, type },
    meta: baseMeta,
  };
};

const transcribeOpenAI = async (audioUri: string, config: SpeechToTextConfig) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const language = resolveLanguage(config.language);
  const strategies: OpenAIUploadStrategy[] = isExpoGo() ? ['uri', 'blob'] : ['blob', 'uri'];
  let lastError: unknown = null;

  for (let index = 0; index < strategies.length; index += 1) {
    const strategy = strategies[index];
    try {
      const { part, fileName, meta } = await buildOpenAIMultipartPayload(audioUri, strategy);
      void logInfo('OpenAI transcription starting', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          ...meta,
        },
      });

      const form = new FormData();
      if (fileName) {
        form.append('file', part as Blob, fileName);
      } else {
        form.append('file', part as any);
      }
      form.append('model', config.model);
      if (language !== 'auto') {
        form.append('language', language);
      }
      form.append('response_format', 'json');

      const result = await fetchJson(
        OPENAI_TRANSCRIBE_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: form,
        },
        { timeoutMs: DEFAULT_TIMEOUT_MS }
      );
      const text = typeof (result as { text?: unknown }).text === 'string'
        ? (result as { text: string }).text
        : '';
      void logInfo('OpenAI transcription completed', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          strategy,
          transcriptLength: String(text.trim().length),
        },
      });
      return text.trim();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      void logWarn('OpenAI transcription failed', {
        scope: 'speech',
        extra: {
          provider: 'openai',
          model: config.model,
          language,
          attempt: String(index + 1),
          strategy,
          expoGo: String(isExpoGo()),
          audioUri,
          error: message,
        },
      });
      if (index < strategies.length - 1) {
        void logWarn('Retrying OpenAI transcription with alternate upload strategy', {
          scope: 'speech',
          extra: {
            currentStrategy: strategy,
            nextStrategy: strategies[index + 1],
            expoGo: String(isExpoGo()),
          },
        });
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'OpenAI transcription failed'));
};

const resolveOpenAIParseModel = (value?: string) => {
  if (!value) return 'gpt-4o-mini';
  const lower = value.toLowerCase();
  if (lower.startsWith('gpt-5')) return 'gpt-4o-mini';
  return value;
};

const extractResponsesText = (result: unknown) => {
  const direct = typeof (result as { output_text?: string }).output_text === 'string'
    ? (result as { output_text: string }).output_text
    : undefined;
  if (direct && direct.trim()) return direct;
  const output = (result as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }).output;
  if (!Array.isArray(output)) return undefined;
  for (const item of output) {
    if (!item || item.type !== 'message') continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    const textPart = content.find((part) => part?.type === 'output_text' || part?.type === 'text');
    if (textPart?.text && textPart.text.trim()) return textPart.text;
  }
  return undefined;
};

const parseWithOpenAIResponses = async (transcript: string, config: SpeechToTextConfig, overrideModel?: string) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const now = config.now ?? new Date();
  const prompt = buildSmartPrompt({
    fieldStrategy: config.fieldStrategy ?? 'smart',
    language: resolveLanguage(config.language),
    now,
    timeZone: config.timeZone,
  });
  const parserModel = resolveOpenAIParseModel(overrideModel ?? config.parseModel);
  const result = await fetchJson(
    OPENAI_RESPONSES_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: parserModel,
        temperature: 0.2,
        input: [
          { role: 'system', content: prompt },
          { role: 'user', content: transcript },
        ],
        text: { format: { type: 'json_object' } },
      }),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const content = extractResponsesText(result);
  if (!content) {
    throw new Error('OpenAI returned no content.');
  }
  return parseJsonResponse(content);
};

const parseWithOpenAIChat = async (transcript: string, config: SpeechToTextConfig, overrideModel?: string) => {
  if (!config.apiKey) {
    throw new Error('OpenAI API key missing');
  }
  const now = config.now ?? new Date();
  const prompt = buildSmartPrompt({
    fieldStrategy: config.fieldStrategy ?? 'smart',
    language: resolveLanguage(config.language),
    now,
    timeZone: config.timeZone,
  });
  const parserModel = resolveOpenAIParseModel(overrideModel ?? config.parseModel);
  const result = await fetchJson(
    OPENAI_CHAT_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: parserModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: transcript },
        ],
      }),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const content = (result as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned no content.');
  }
  return parseJsonResponse(content);
};

const parseWithOpenAI = async (transcript: string, config: SpeechToTextConfig, overrideModel?: string) => {
  try {
    return await parseWithOpenAIResponses(transcript, config, overrideModel);
  } catch (error) {
    void logWarn('OpenAI responses parse failed, retrying with chat completions', {
      scope: 'speech',
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return parseWithOpenAIChat(transcript, config, overrideModel);
  }
};

const requestGemini = async (audioUri: string, config: SpeechToTextConfig, promptOverride?: string) => {
  if (!config.apiKey) {
    throw new Error('Gemini API key missing');
  }
  const now = config.now ?? new Date();
  const prompt = promptOverride ?? buildSmartPrompt({
    fieldStrategy: config.fieldStrategy ?? 'smart',
    language: resolveLanguage(config.language),
    now,
    timeZone: config.timeZone,
  });
  const normalizedUri = normalizeAudioUri(audioUri);
  const fileReadUri = normalizeAudioUriForFileRead(audioUri);
  const file = new File(fileReadUri);
  const bytes = await file.bytes();
  const base64Audio = bytesToBase64(bytes);
  const mimeType = getMimeType(normalizedUri);
  const url = `${GEMINI_BASE_URL}/${config.model}:generateContent`;
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Audio,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
      candidateCount: 1,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  };
  const result = await fetchJson(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const text = (result as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    .candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('Gemini returned no content.');
  }
  return parseJsonResponse(text);
};

const MIN_WHISPER_MODEL_BYTES = 5 * 1024 * 1024;
const WHISPER_REALTIME_SLICE_SEC = 30;
const WHISPER_REALTIME_BUFFER_SIZE = 2048;
const WHISPER_MODEL_DIR_NAME = 'whisper-models';
const WHISPER_MODEL_FILES: Record<string, string> = {
  'whisper-tiny': 'ggml-tiny.bin',
  'whisper-tiny.en': 'ggml-tiny.en.bin',
  'whisper-base': 'ggml-base.bin',
  'whisper-base.en': 'ggml-base.en.bin',
};

const buildWhisperModelDirectoryUri = (rootUri: string): string => {
  const normalized = rootUri.endsWith('/') ? rootUri : `${rootUri}/`;
  return `${normalized}${WHISPER_MODEL_DIR_NAME}`;
};

const buildWhisperModelFileUri = (rootUri: string, fileName: string): string => {
  const directoryUri = buildWhisperModelDirectoryUri(rootUri);
  return `${directoryUri.endsWith('/') ? directoryUri : `${directoryUri}/`}${fileName}`;
};

type WhisperModelResolved = {
  path: string;
  uri: string;
  exists: boolean;
  size: number;
};

const normalizeFilePath = (value: string) => {
  if (value.startsWith('file://')) {
    return { path: value.replace(/^file:\/\//, ''), uri: value };
  }
  if (value.startsWith('file:/')) {
    const stripped = value.replace(/^file:\//, '/');
    return { path: stripped, uri: `file://${stripped}` };
  }
  if (value.startsWith('/')) {
    return { path: value, uri: `file://${value}` };
  }
  return { path: value, uri: value };
};

const getPathInfoSize = (info: unknown) => {
  if (!info || typeof info !== 'object') return 0;
  const size = (info as { size?: unknown }).size;
  return typeof size === 'number' ? size : 0;
};

const checkFile = (uri: string) => {
  try {
    const info = Paths.info(uri);
    if (info?.exists && !info.isDirectory) {
      const size = getPathInfoSize(info);
      return { exists: true, size };
    }
  } catch {
    // Fall back to File metadata when Paths.info cannot handle the uri.
  }
  try {
    const file = new File(uri);
    if (file.exists) {
      const size = typeof file.size === 'number' ? file.size : 0;
      return { exists: true, size };
    }
  } catch {
    // Ignore and report missing below.
  }
  return { exists: false, size: 0 };
};

type NativeStatLike = {
  size?: unknown;
  path?: unknown;
  originalFilepath?: unknown;
  isFile?: () => boolean;
  isDirectory?: () => boolean;
};

const checkNativeFile = async (normalized: ReturnType<typeof normalizeFilePath>) => {
  const rnfs = await getRNFSModuleAsync() as (RNFSModule & { stat?: (path: string) => Promise<NativeStatLike> }) | null;
  if (!rnfs || typeof rnfs.stat !== 'function') {
    return { exists: false, size: 0 };
  }
  try {
    const stat = await rnfs.stat(normalized.path);
    const isDirectory = typeof stat.isDirectory === 'function' ? stat.isDirectory() : false;
    const isFile = typeof stat.isFile === 'function' ? stat.isFile() : !isDirectory;
    const size = typeof stat.size === 'number' && Number.isFinite(stat.size) ? stat.size : 0;
    if (isFile && !isDirectory) {
      return { exists: true, size };
    }
  } catch {
  }
  return { exists: false, size: 0 };
};

const checkPath = (uri?: string) => {
  if (!uri) return { exists: false, isDirectory: false, size: 0 };
  let pathInfo: ReturnType<typeof Paths.info> | null = null;
  try {
    pathInfo = Paths.info(uri);
    if (pathInfo?.exists && pathInfo.isDirectory) {
      return {
        exists: true,
        isDirectory: true,
        size: getPathInfoSize(pathInfo),
      };
    }
  } catch {
  }
  try {
    const dir = new Directory(uri);
    if (dir.exists) {
      return { exists: true, isDirectory: true, size: 0 };
    }
  } catch {
  }
  try {
    const file = new File(uri);
    if (file.exists) {
      return { exists: true, isDirectory: false, size: typeof file.size === 'number' ? file.size : 0 };
    }
  } catch {
  }
  if (pathInfo?.exists) {
    return {
      exists: true,
      isDirectory: Boolean(pathInfo.isDirectory),
      size: getPathInfoSize(pathInfo),
    };
  }
  return { exists: false, isDirectory: false, size: 0 };
};

const normalizeWhisperDirectoryUri = (uri: string) => normalizeFilePath(uri).uri.replace(/\/+$/u, '');

const isKnownWhisperModelDirectoryUri = (uri: string): boolean => {
  const normalized = normalizeWhisperDirectoryUri(uri);
  const roots: Array<Directory | undefined> = [];
  try {
    roots.push(Paths.document);
  } catch {
  }
  try {
    roots.push(Paths.cache);
  } catch {
  }
  return roots.some((root) => {
    if (!root?.uri) return false;
    return normalizeWhisperDirectoryUri(buildWhisperModelDirectoryUri(root.uri)) === normalized;
  });
};

const deleteWhisperDirectoryBlockingFile = (uri: string, reason: string): boolean => {
  const normalized = normalizeFilePath(uri).uri;
  if (!isKnownWhisperModelDirectoryUri(normalized)) {
    void logWarn('Refusing to repair unsafe Whisper model directory target', {
      scope: 'speech',
      force: true,
      extra: { uri: normalized, reason },
    });
    return false;
  }
  const before = checkPath(normalized);
  if (!before.exists || before.isDirectory) return false;
  try {
    new File(normalized).delete();
  } catch (error) {
    void logWarn('Whisper model directory file cleanup failed', {
      scope: 'speech',
      force: true,
      extra: {
        uri: normalized,
        reason,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
  const after = checkPath(normalized);
  return !after.exists || after.isDirectory;
};

const listDirectorySample = (uri?: string) => {
  if (!uri) return '';
  try {
    const dir = new Directory(uri);
    if (!dir.exists) return '';
    const entries = dir.list();
    if (!entries.length) return '';
    return entries
      .slice(0, 8)
      .map((entry) => {
        try {
          return Paths.basename(entry.uri) ?? '';
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join(', ');
  } catch {
    return '';
  }
};

const buildWhisperDiagnostics = (
  modelId?: string,
  modelPath?: string,
  resolved?: WhisperModelResolved,
  candidates: string[] = []
) => {
  const docUri = Paths.document?.uri ?? '';
  const cacheUri = Paths.cache?.uri ?? '';
  const normalizedDoc = docUri ? normalizeFilePath(docUri).uri : '';
  const normalizedCache = cacheUri ? normalizeFilePath(cacheUri).uri : '';
  const docInfo = checkPath(normalizedDoc);
  const cacheInfo = checkPath(normalizedCache);
  const whisperDirUri = normalizedDoc
    ? `${normalizedDoc.endsWith('/') ? normalizedDoc : `${normalizedDoc}/`}${WHISPER_MODEL_DIR_NAME}`
    : '';
  const cacheWhisperDirUri = normalizedCache
    ? `${normalizedCache.endsWith('/') ? normalizedCache : `${normalizedCache}/`}${WHISPER_MODEL_DIR_NAME}`
    : '';
  const whisperDirInfo = checkPath(whisperDirUri);
  const cacheWhisperDirInfo = checkPath(cacheWhisperDirUri);
  const resolvedInfo = resolved ? checkFile(resolved.uri) : { exists: false, size: 0 };
  const documentSample = listDirectorySample(normalizedDoc);
  const cacheSample = listDirectorySample(normalizedCache);
  const whisperDirSample = listDirectorySample(whisperDirUri);
  const cacheWhisperDirSample = listDirectorySample(cacheWhisperDirUri);
  const candidateUris = candidates
    .map((candidate) => normalizeFilePath(candidate).uri)
    .filter(Boolean)
    .join(', ');
  return {
    modelId: modelId ?? '',
    modelPath: modelPath ?? '',
    resolvedUri: resolved?.uri ?? '',
    resolvedExists: String(Boolean(resolvedInfo.exists)),
    resolvedSize: String(resolvedInfo.size ?? 0),
    documentUri: normalizedDoc,
    documentExists: String(Boolean(docInfo.exists)),
    documentIsDir: String(Boolean(docInfo.isDirectory)),
    documentSample,
    cacheUri: normalizedCache,
    cacheExists: String(Boolean(cacheInfo.exists)),
    cacheIsDir: String(Boolean(cacheInfo.isDirectory)),
    cacheSample,
    whisperDirUri,
    whisperDirExists: String(Boolean(whisperDirInfo.exists)),
    whisperDirIsDir: String(Boolean(whisperDirInfo.isDirectory)),
    whisperDirSample,
    cacheWhisperDirUri,
    cacheWhisperDirExists: String(Boolean(cacheWhisperDirInfo.exists)),
    cacheWhisperDirIsDir: String(Boolean(cacheWhisperDirInfo.isDirectory)),
    cacheWhisperDirSample,
    candidateUris,
  };
};

const ensureWhisperModelDirectory = (): string | null => {
  const roots: Directory[] = [];
  try {
    roots.push(Paths.document);
  } catch {
  }
  try {
    roots.push(Paths.cache);
  } catch {
  }
  for (const root of roots) {
    const dirUri = buildWhisperModelDirectoryUri(root.uri);
    const createDirectory = () => {
      const dir = new Directory(dirUri);
      dir.create({ intermediates: true, idempotent: true });
      const after = checkPath(dirUri);
      if (after.exists && !after.isDirectory) {
        void logWarn('Whisper model directory blocked after create', {
          scope: 'speech',
          force: true,
          extra: {
            uri: dirUri,
            exists: String(Boolean(after.exists)),
            isDirectory: String(Boolean(after.isDirectory)),
            size: String(after.size ?? 0),
          },
        });
        throw new Error(`Whisper model directory is not a directory after create: ${dirUri}`);
      }
      return dir.uri;
    };
    try {
      const info = checkPath(dirUri);
      if (info.exists && !info.isDirectory) {
        deleteWhisperDirectoryBlockingFile(dirUri, 'pre-create');
      }
      return createDirectory();
    } catch (error) {
      if (deleteWhisperDirectoryBlockingFile(dirUri, 'create-failed')) {
        try {
          return createDirectory();
        } catch (retryError) {
          void logWarn('Whisper model directory recreate failed', {
            scope: 'speech',
            force: true,
            extra: {
              uri: dirUri,
              error: retryError instanceof Error ? retryError.message : String(retryError),
            },
          });
        }
      } else {
        void logWarn('Whisper model directory create failed', {
          scope: 'speech',
          force: true,
          extra: {
            uri: dirUri,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }
  return null;
};

const buildWhisperModelCandidates = (
  modelId: string | undefined,
  modelPath?: string,
  includeRoot: boolean = true,
  includeCache: boolean = true
): string[] => {
  const candidates: string[] = [];
  if (modelPath) {
    const normalized = normalizeFilePath(modelPath);
    candidates.push(normalized.uri);
    if (normalized.uri !== modelPath) {
      candidates.push(modelPath);
    }
  }
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  if (fileName) {
    const appendCandidates = (base?: string | null) => {
      if (!base) return;
      const normalizedBase = base.endsWith('/') ? base : `${base}/`;
      candidates.push(buildWhisperModelFileUri(normalizedBase, fileName));
      if (includeRoot) {
        candidates.push(`${normalizedBase}${fileName}`);
      }
    };
    appendCandidates(Paths.document?.uri ?? null);
    if (includeCache) {
      appendCandidates(Paths.cache?.uri ?? null);
    }
  }
  return candidates;
};

export const resolveWhisperModelPathForConfig = (
  modelId: string | undefined,
  modelPath?: string
): WhisperModelResolved => {
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  const candidates = buildWhisperModelCandidates(modelId, modelPath, true, true);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeFilePath(candidate);
    const info = checkFile(normalized.uri);
    if (info.exists) {
      return { path: normalized.path, uri: normalized.uri, exists: true, size: info.size };
    }
  }

  const fallback = modelPath ? normalizeFilePath(modelPath) : normalizeFilePath(fileName ?? '');
  return { path: fallback.path, uri: fallback.uri, exists: false, size: 0 };
};

export const ensureWhisperModelPathForConfig = (
  modelId: string | undefined,
  modelPath?: string
): WhisperModelResolved => {
  const resolved = resolveWhisperModelPathForConfig(modelId, modelPath);
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  if (!fileName) return resolved;

  const preferredDir = ensureWhisperModelDirectory();
  const preferredUri = preferredDir ? `${preferredDir.endsWith('/') ? preferredDir : `${preferredDir}/`}${fileName}` : null;

  if (preferredUri) {
    const preferredNormalized = normalizeFilePath(preferredUri);
    const preferredInfo = checkFile(preferredNormalized.uri);
    if (preferredInfo.exists) {
      return {
        path: preferredNormalized.path,
        uri: preferredNormalized.uri,
        exists: true,
        size: preferredInfo.size,
      };
    }
    if (resolved.exists) {
      try {
        const source = new File(resolved.uri);
        const destination = new File(preferredNormalized.uri);
        if (!destination.exists) {
          source.copy(destination);
        }
        const destInfo = checkFile(preferredNormalized.uri);
        if (destInfo.exists) {
          return {
            path: preferredNormalized.path,
            uri: preferredNormalized.uri,
            exists: true,
            size: destInfo.size,
          };
        }
      } catch {
        // Ignore copy errors and fall back to resolved below.
      }
    }
  }

  if (resolved.exists) return resolved;

  const candidates = buildWhisperModelCandidates(modelId, modelPath, true, true);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeFilePath(candidate);
    const info = checkFile(normalized.uri);
    if (!info.exists) continue;
    return { path: normalized.path, uri: normalized.uri, exists: true, size: info.size };
  }

  void logWarn('Whisper model missing', {
    scope: 'speech',
    force: true,
    extra: buildWhisperDiagnostics(modelId, modelPath, resolved, candidates),
  });

  if (preferredUri) {
    const preferredNormalized = normalizeFilePath(preferredUri);
    return { path: preferredNormalized.path, uri: preferredNormalized.uri, exists: false, size: 0 };
  }

  return resolved;
};

export const resolveWhisperModelPathForConfigAsync = async (
  modelId: string | undefined,
  modelPath?: string
): Promise<WhisperModelResolved> => {
  const resolved = resolveWhisperModelPathForConfig(modelId, modelPath);
  if (resolved.exists) return resolved;

  const candidates = buildWhisperModelCandidates(modelId, modelPath, true, true);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeFilePath(candidate);
    const nativeInfo = await checkNativeFile(normalized);
    if (nativeInfo.exists) {
      return { path: normalized.path, uri: normalized.uri, exists: true, size: nativeInfo.size };
    }
  }

  return resolved;
};

export const ensureWhisperModelPathForConfigAsync = async (
  modelId: string | undefined,
  modelPath?: string
): Promise<WhisperModelResolved> => {
  const resolved = await resolveWhisperModelPathForConfigAsync(modelId, modelPath);
  const fileName = modelId ? WHISPER_MODEL_FILES[modelId] : undefined;
  if (!fileName) return resolved;

  const preferredDir = ensureWhisperModelDirectory();
  const preferredUri = preferredDir ? `${preferredDir.endsWith('/') ? preferredDir : `${preferredDir}/`}${fileName}` : null;

  if (preferredUri) {
    const preferredNormalized = normalizeFilePath(preferredUri);
    const preferredInfo = checkFile(preferredNormalized.uri);
    if (preferredInfo.exists) {
      return {
        path: preferredNormalized.path,
        uri: preferredNormalized.uri,
        exists: true,
        size: preferredInfo.size,
      };
    }
    const preferredNativeInfo = await checkNativeFile(preferredNormalized);
    if (preferredNativeInfo.exists) {
      return {
        path: preferredNormalized.path,
        uri: preferredNormalized.uri,
        exists: true,
        size: preferredNativeInfo.size,
      };
    }
  }

  if (resolved.exists) return resolved;

  const candidates = buildWhisperModelCandidates(modelId, modelPath, true, true);
  void logWarn('Whisper model missing', {
    scope: 'speech',
    force: true,
    extra: buildWhisperDiagnostics(modelId, modelPath, resolved, candidates),
  });

  if (preferredUri) {
    const preferredNormalized = normalizeFilePath(preferredUri);
    return { path: preferredNormalized.path, uri: preferredNormalized.uri, exists: false, size: 0 };
  }

  return resolved;
};

const enableWhisperNativeLogging = async (): Promise<void> => {
  if (whisperNativeLogEnabled) return;
  if (!__DEV__) {
    // Avoid enabling JNI log callbacks in release builds.
    whisperNativeLogEnabled = true;
    return;
  }
  try {
    const whisper = getWhisperModule();
    if (typeof whisper.toggleNativeLog === 'function') {
      await whisper.toggleNativeLog(true);
    }
    if (typeof whisper.addNativeLogListener === 'function') {
      whisper.addNativeLogListener((level: string, text: string) => {
        void logWarn('Whisper native', {
          scope: 'speech',
          extra: { level, text },
        });
      });
    }
    whisperNativeLogEnabled = true;
  } catch (error) {
    void logWarn('Failed to enable Whisper native logs', {
      scope: 'speech',
      force: true,
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
  }
};

const getWhisperContext = async (modelPath: string, modelId?: string) => {
  await enableWhisperNativeLogging();
  const resolved = await ensureWhisperModelPathForConfigAsync(modelId, modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  if (resolved.size > 0 && resolved.size < MIN_WHISPER_MODEL_BYTES) {
    throw new Error(`Offline model file is too small (${resolved.size} bytes)`);
  }
  if (whisperContextCache?.modelPath === resolved.path) {
    return whisperContextCache.context;
  }
  const { initWhisper } = getWhisperModule();
  const initOptions: { filePath: string; useGpu?: boolean; useFlashAttn?: boolean } = {
    filePath: resolved.path,
    useFlashAttn: false,
  };
  if (Platform.OS === 'android') {
    initOptions.useGpu = false;
  }
  try {
    const context = await initWhisper(initOptions);
    whisperContextCache = { modelPath: resolved.path, context };
    return context;
  } catch (error) {
    const withScheme = resolved.uri;
    if (withScheme !== resolved.path) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      void logWarn('Whisper context init failed, retrying with file uri', {
        scope: 'speech',
        force: true,
        extra: {
          platform: Platform.OS,
          modelId: modelId ?? '',
          modelPath: resolved.path,
          modelUri: withScheme,
          modelSize: String(resolved.size),
          error: primaryMessage,
        },
      });
      try {
        const context = await initWhisper({ ...initOptions, filePath: withScheme });
        whisperContextCache = { modelPath: withScheme, context };
        return context;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        void logWarn('Whisper context init failed', {
          scope: 'speech',
          force: true,
          extra: {
            platform: Platform.OS,
            modelId: modelId ?? '',
            modelPath: resolved.path,
            modelUri: withScheme,
            modelSize: String(resolved.size),
            error: message,
          },
        });
        throw new Error(`Whisper init failed (${message}) at ${resolved.path} (${resolved.size} bytes)`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    void logWarn('Whisper context init failed', {
      scope: 'speech',
      force: true,
      extra: {
        platform: Platform.OS,
        modelId: modelId ?? '',
        modelPath: resolved.path,
        modelSize: String(resolved.size),
        error: message,
      },
    });
    throw new Error(`Whisper init failed (${message}) at ${resolved.path} (${resolved.size} bytes)`);
  }
};

const extractWhisperText = (result: unknown): string => {
  const direct = (result as { result?: unknown })?.result;
  if (typeof direct === 'string') return direct;
  if (direct && typeof (direct as { text?: unknown }).text === 'string') {
    return (direct as { text: string }).text;
  }
  if (typeof (result as { text?: unknown }).text === 'string') {
    return (result as { text: string }).text;
  }
  if (typeof (result as { transcript?: unknown }).transcript === 'string') {
    return (result as { transcript: string }).transcript;
  }
  const segments = (result as { segments?: Array<{ text?: string }> }).segments;
  if (Array.isArray(segments)) {
    const joined = segments.map((segment) => segment?.text ?? '').join(' ').trim();
    if (joined) return joined;
  }
  return '';
};

type WavPcmMetadata = {
  valid: boolean;
  reason?: string;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  dataBytes?: number;
  durationMs?: number;
  headerRiffWave: boolean;
};

const getAudioFileExtensionFromUri = (uri: string): string => {
  const withoutQuery = uri.split('?')[0]?.split('#')[0] ?? '';
  const fileName = withoutQuery.split('/').pop() ?? '';
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
};

const getUriScheme = (uri: string): string => {
  const index = uri.indexOf(':');
  if (index > 0) return uri.slice(0, index);
  if (uri.startsWith('/')) return 'file';
  return 'unknown';
};

const readAscii = (bytes: Uint8Array, offset: number, length: number): string => {
  let value = '';
  for (let i = 0; i < length; i += 1) {
    value += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return value;
};

const readUInt16LE = (bytes: Uint8Array, offset: number): number => (
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
);

const readUInt32LE = (bytes: Uint8Array, offset: number): number => (
  ((bytes[offset] ?? 0)
    | ((bytes[offset + 1] ?? 0) << 8)
    | ((bytes[offset + 2] ?? 0) << 16)
    | ((bytes[offset + 3] ?? 0) << 24)) >>> 0
);

const inspectWavPcm = (bytes: Uint8Array): WavPcmMetadata => {
  if (bytes.byteLength < 44) {
    return { valid: false, reason: 'too_short', headerRiffWave: false };
  }

  const headerRiffWave = readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WAVE';
  if (!headerRiffWave) {
    return { valid: false, reason: 'not_riff_wave', headerRiffWave };
  }

  let offset = 12;
  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let dataBytes: number | undefined;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = readUInt32LE(bytes, offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + chunkSize > bytes.byteLength) {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = readUInt16LE(bytes, chunkDataOffset);
      channels = readUInt16LE(bytes, chunkDataOffset + 2);
      sampleRate = readUInt32LE(bytes, chunkDataOffset + 4);
      bitsPerSample = readUInt16LE(bytes, chunkDataOffset + 14);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  const bytesPerSecond = sampleRate && channels && bitsPerSample
    ? sampleRate * channels * (bitsPerSample / 8)
    : 0;
  const durationMs = dataBytes && bytesPerSecond > 0 ? Math.round((dataBytes / bytesPerSecond) * 1000) : 0;
  const base = {
    audioFormat,
    bitsPerSample,
    channels,
    dataBytes,
    durationMs,
    headerRiffWave,
    sampleRate,
  };

  if (audioFormat !== 1) return { ...base, valid: false, reason: 'not_pcm' };
  if (channels !== LOCAL_WHISPER_CHANNELS) return { ...base, valid: false, reason: 'unsupported_channels' };
  if (sampleRate !== LOCAL_WHISPER_SAMPLE_RATE) return { ...base, valid: false, reason: 'unsupported_sample_rate' };
  if (bitsPerSample !== LOCAL_WHISPER_BITS_PER_SAMPLE) return { ...base, valid: false, reason: 'unsupported_bits_per_sample' };
  if (!dataBytes || dataBytes <= 0) return { ...base, valid: false, reason: 'empty_data' };
  if (durationMs < LOCAL_WHISPER_MIN_DURATION_MS) return { ...base, valid: false, reason: 'too_short_duration' };

  return { ...base, valid: true };
};

const buildLocalAsrLogContext = (captured: CapturedAudio, metadata: WavPcmMetadata | null, bytes: number, fallbackReason?: string) => ({
  bits_per_sample: String(metadata?.bitsPerSample ?? ''),
  capture_mode: captured.source,
  channels: String(metadata?.channels ?? ''),
  duration_ms: String(metadata?.durationMs ?? 0),
  extension: captured.extension ?? getAudioFileExtensionFromUri(captured.uri),
  fallback_reason: fallbackReason ?? '',
  file_size: String(bytes),
  header_riff_wave: String(metadata?.headerRiffWave === true),
  platform: captured.platform,
  sample_rate: String(metadata?.sampleRate ?? ''),
  sniffed_format: metadata?.headerRiffWave ? 'wav' : 'unknown',
  uri_scheme: getUriScheme(captured.uri),
});

export const prepareAudioForLocalWhisper = async (captured: CapturedAudio): Promise<LocalWhisperAudio | null> => {
  const normalizedUri = normalizeAudioUriForFileRead(captured.uri);
  let bytes: Uint8Array;
  try {
    bytes = await new File(normalizedUri).bytes();
  } catch (error) {
    await logWarn('ASR_INPUT_REJECTED_UNSUPPORTED_FORMAT', {
      scope: 'speech',
      force: true,
      extra: {
        ...buildLocalAsrLogContext(captured, null, 0, 'read_failed'),
        error: error instanceof Error ? error.message : String(error),
        local_whisper_called: 'false',
        reject_reason: 'read_failed',
      },
    });
    return null;
  }

  const metadata = inspectWavPcm(bytes);
  if (!metadata.valid) {
    await logWarn('ASR_INPUT_REJECTED_UNSUPPORTED_FORMAT', {
      scope: 'speech',
      force: true,
      extra: {
        ...buildLocalAsrLogContext(captured, metadata, bytes.byteLength, metadata.reason),
        local_whisper_called: 'false',
        reject_reason: metadata.reason ?? 'unsupported_format',
      },
    });
    return null;
  }

  await logInfo('ASR_INPUT_ACCEPTED_LOCAL_WHISPER', {
    scope: 'speech',
    force: true,
    extra: {
      ...buildLocalAsrLogContext(captured, metadata, bytes.byteLength),
      local_whisper_called: 'false',
    },
  });

  return {
    uri: normalizeAudioUri(captured.uri),
    format: 'wav-pcm',
    sampleRate: metadata.sampleRate ?? LOCAL_WHISPER_SAMPLE_RATE,
    channels: metadata.channels ?? LOCAL_WHISPER_CHANNELS,
    bitsPerSample: metadata.bitsPerSample ?? LOCAL_WHISPER_BITS_PER_SAMPLE,
    bytes: bytes.byteLength,
    durationMs: metadata.durationMs ?? 0,
  };
};

export const startWhisperRealtimeCapture = async (
  audioOutputPath: string,
  config: SpeechToTextConfig
): Promise<WhisperRealtimeHandle> => {
  if (isExpoGo()) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  const whisperRealtime = getWhisperRealtimeModule();
  if (!whisperRealtime) {
    throw new Error('Whisper realtime transcription requires native audio stream modules.');
  }
  const RNFS = await getRNFSModuleAsync();
  if (!RNFS) {
    throw new Error('react-native-fs is unavailable. Use a dev build or production build with native modules.');
  }
  const resolved = await ensureWhisperModelPathForConfigAsync(config.model, config.modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  const context = await getWhisperContext(resolved.path, config.model);
  const language = resolveLanguage(config.language);
  const effectiveLanguage = config.model?.endsWith('.en') && language === 'auto' ? 'en' : language;
  const transcribeOptions = buildWhisperTranscribeOptions(effectiveLanguage);
  const options: Record<string, unknown> = {
    audioOutputPath,
    audioSliceSec: WHISPER_REALTIME_SLICE_SEC,
    audioStreamConfig: {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      bufferSize: WHISPER_REALTIME_BUFFER_SIZE,
      audioSource: 6,
    },
    transcribeOptions: Object.keys(transcribeOptions).length ? transcribeOptions : undefined,
    promptPreviousSlices: false,
  };

  const audioStream = new whisperRealtime.AudioPcmStreamAdapter();
  // Android's file transcription path decodes WAV only. Use the realtime helper
  // there as a PCM/WAV recorder, then transcribe the generated WAV after stop.
  const enableRealtimeTranscript = Platform.OS !== 'android';
  const transcriptBySlice = new Map<number, string>();
  let completed = false;
  let hasActivated = false;
  let resolveResult: (value: SpeechToTextResult) => void = () => {};
  const result = new Promise<SpeechToTextResult>((resolve) => {
    resolveResult = resolve;
  });

  const finalize = () => {
    if (completed) return;
    completed = true;
    if (!enableRealtimeTranscript) {
      resolveResult({ transcript: '' });
      return;
    }
    const sorted = [...transcriptBySlice.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value.trim())
      .filter(Boolean);
    const text = sorted.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) {
      void logWarn('Whisper returned empty transcript', {
        scope: 'speech',
        force: true,
        extra: {
          uri: audioOutputPath,
          modelPath: resolved.path,
          language: effectiveLanguage,
        },
      });
    }
    resolveResult({ transcript: text });
  };

  const realtime = new whisperRealtime.RealtimeTranscriber(
    { whisperContext: context, audioStream, fs: RNFS },
    options,
    {
      onBeginTranscribe: enableRealtimeTranscript ? undefined : async () => false,
      onTranscribe: enableRealtimeTranscript
        ? (event: WhisperRealtimeEventLike) => {
          if (completed) return;
          const nextText = extractWhisperText(event.data ?? {}).trim();
          if (!nextText) return;
          const normalized = nextText.replace(/\s+/g, ' ').trim();
          if (!normalized) return;
          const sliceIndex = typeof event.sliceIndex === 'number' ? event.sliceIndex : 0;
          const prev = transcriptBySlice.get(sliceIndex) ?? '';
          if (!prev || normalized.length > prev.length) {
            transcriptBySlice.set(sliceIndex, normalized);
          }
        }
        : undefined,
      onError: (error: string) => {
        if (completed) return;
        completed = true;
        void logWarn('Whisper realtime transcription failed', {
          scope: 'speech',
          force: true,
          extra: {
            platform: Platform.OS,
            error,
          },
        });
        resolveResult({ transcript: '' });
      },
      onStatusChange: (isActive: boolean) => {
        if (completed) return;
        if (isActive) {
          hasActivated = true;
          return;
        }
        if (hasActivated) {
          finalize();
        }
      },
    }
  );

  try {
    await realtime.start();
  } catch (error) {
    try {
      await realtime.release();
    } catch {
      // Ignore cleanup failures after a failed start.
    }
    throw error;
  }

  const stop = async () => {
    try {
      await realtime.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void logWarn('Failed to stop whisper recording', {
        scope: 'speech',
        extra: { error: message },
      });
    } finally {
      try {
        await realtime.release();
      } catch {
        // Ignore release failures.
      }
      finalize();
    }
  };

  return { stop, result, hasRealtimeTranscript: enableRealtimeTranscript };
};

export const preloadWhisperContext = async (config: {
  model?: string;
  modelPath?: string;
}): Promise<void> => {
  if (isExpoGo()) return;
  const resolved = await ensureWhisperModelPathForConfigAsync(config.model, config.modelPath);
  if (!resolved.exists) return;
  await getWhisperContext(resolved.path, config.model);
};

export const transcribeLocalWhisper = async (input: LocalWhisperAudio, config: SpeechToTextConfig) => {
  if (isExpoGo()) {
    throw new Error('On-device Whisper requires a dev build or production build (not Expo Go).');
  }
  const resolved = await ensureWhisperModelPathForConfigAsync(config.model, config.modelPath);
  if (!resolved.exists) {
    throw new Error(`Offline model not found at ${resolved.path}`);
  }
  const context = await getWhisperContext(resolved.path, config.model);
  const language = resolveLanguage(config.language);
  const effectiveLanguage = config.model?.endsWith('.en') && language === 'auto' ? 'en' : language;
  const options = buildWhisperTranscribeOptions(effectiveLanguage);
  const audioUri = input.uri;
  const normalizedUri = audioUri.startsWith('file://')
    ? audioUri.replace(/^file:\/\//, '')
    : audioUri.startsWith('file:/')
      ? audioUri.replace(/^file:\//, '/')
      : audioUri;
  let result: unknown;
  try {
    result = await context.transcribe(normalizedUri, options).promise;
  } catch (error) {
    if (normalizedUri !== audioUri) {
      const primaryMessage = error instanceof Error ? error.message : String(error);
      void logWarn('Whisper transcription path failed, retrying with file uri', {
        scope: 'speech',
        force: true,
        extra: {
          platform: Platform.OS,
          modelPath: resolved.path,
          language: effectiveLanguage,
          error: primaryMessage,
        },
      });
      try {
        result = await context.transcribe(audioUri, options).promise;
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : String(retryError);
        void logWarn('Whisper transcription failed', {
          scope: 'speech',
          force: true,
          extra: {
            platform: Platform.OS,
            modelPath: resolved.path,
            language: effectiveLanguage,
            error: message,
          },
        });
        throw retryError;
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      void logWarn('Whisper transcription failed', {
        scope: 'speech',
        force: true,
        extra: {
          platform: Platform.OS,
          modelPath: resolved.path,
          language: effectiveLanguage,
          error: message,
        },
      });
      throw error;
    }
  }
  let text = extractWhisperText(result).trim();
  if (!text && normalizedUri !== audioUri) {
    try {
      const retry = await context.transcribe(audioUri, options).promise;
      text = extractWhisperText(retry).trim();
    } catch {
      // Ignore retry errors after a successful primary transcription.
    }
  }
  if (!text) {
    void logWarn('Whisper returned empty transcript', {
      scope: 'speech',
      force: true,
      extra: {
        uri: audioUri,
        modelPath: resolved.path,
        language: effectiveLanguage,
      },
    });
  }
  return text;
};

export async function processAudioCapture(
  audioUri: string,
  config: SpeechToTextConfig
): Promise<SpeechToTextResult> {
  assertSpeechProviderAllowedForRuntime(config.provider, config.isFossBuild);
  const mode = config.mode ?? 'smart_parse';
  if (config.provider === 'whisper') {
    const localInput = await prepareAudioForLocalWhisper({
      uri: audioUri,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      source: 'expo-recorder',
      extension: getAudioFileExtensionFromUri(audioUri),
    });
    if (!localInput) {
      throw new Error(LOCAL_WHISPER_UNSUPPORTED_AUDIO_ERROR);
    }
    const transcript = await transcribeLocalWhisper(localInput, config);
    return { transcript };
  }
  if (config.provider === 'gemini') {
    if (mode === 'transcribe_only') {
      const prompt = buildTranscriptionPrompt(resolveLanguage(config.language));
      return requestGemini(audioUri, config, prompt);
    }
    return requestGemini(audioUri, config);
  }

  const transcript = await transcribeOpenAI(audioUri, config);
  if (mode === 'transcribe_only') {
    return { transcript };
  }
  try {
    const parsed = await parseWithOpenAI(transcript, config);
    return {
      ...parsed,
      transcript: parsed.transcript || transcript,
    };
  } catch (error) {
    try {
      const parsed = await parseWithOpenAI(transcript, config, 'gpt-4o-mini');
      return {
        ...parsed,
        transcript: parsed.transcript || transcript,
      };
    } catch (retryError) {
      void logWarn('OpenAI smart parse failed, falling back to transcript', {
        scope: 'speech',
        extra: { error: retryError instanceof Error ? retryError.message : String(retryError) },
      });
      return { transcript };
    }
  }
}
