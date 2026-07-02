import { useCallback, useEffect, useState } from 'react';
import type { AIProviderId, AIReasoningEffort, AiSettings, AppData, AudioCaptureMode, AudioFieldStrategy } from '@mindwtr/core';
import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getCopilotModelOptions,
    getModelOptions,
} from '@mindwtr/core';
import { exists, remove, size } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';
import { loadAIKey, saveAIKey } from '../../../lib/ai-config';
import { reportError } from '../../../lib/report-error';
import { logWarn } from '../../../lib/app-log';
import { markSettingsOpenTrace, measureSettingsOpenStep } from '../../../lib/settings-open-diagnostics';
import { useUiStore } from '../../../store/ui-store';
import {
    DEFAULT_PARAKEET_MODEL,
    DEFAULT_WHISPER_MODEL,
    GEMINI_SPEECH_MODELS,
    OPENAI_SPEECH_MODELS,
    PARAKEET_MODELS,
    PARAKEET_MODEL_INSTALL_DIR,
    PARAKEET_REQUIRED_FILES,
    WHISPER_MODELS,
} from '../../../lib/speech-models';

type UseAiSettingsOptions = {
    isTauri: boolean;
    settings: AppData['settings'] | undefined;
    updateSettings: (next: Partial<AppData['settings']>) => Promise<void>;
    showSaved: () => void;
    enabled?: boolean;
};

type AiSettingsUpdate = Partial<AiSettings>;
type SpeechSettings = NonNullable<AiSettings['speechToText']>;
type SpeechSettingsUpdate = Partial<SpeechSettings>;
type SpeechProvider = NonNullable<SpeechSettings['provider']>;
type SpeechDownloadProgress = {
    stage: string;
    loaded: number;
    total?: number | null;
    percent?: number | null;
};

export function useAiSettings({ isTauri, settings, updateSettings, showSaved, enabled = true }: UseAiSettingsOptions) {
    const [aiApiKey, setAiApiKey] = useState('');
    const [speechApiKey, setSpeechApiKey] = useState('');
    const [speechDownloadState, setSpeechDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [speechDownloadError, setSpeechDownloadError] = useState<string | null>(null);
    const [speechOfflinePath, setSpeechOfflinePath] = useState<string | null>(null);
    const [speechOfflineSize, setSpeechOfflineSize] = useState<number | null>(null);
    const [speechOfflineReadyState, setSpeechOfflineReadyState] = useState(false);
    const [speechDownloadProgress, setSpeechDownloadProgress] = useState<SpeechDownloadProgress | null>(null);
    const showToast = useUiStore((state) => state.showToast);

    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const aiEnabled = settings?.ai?.enabled === true;
    const aiDefaults = getDefaultAIConfig(aiProvider);
    const aiModel = settings?.ai?.model ?? aiDefaults.model;
    const aiBaseUrl = settings?.ai?.baseUrl ?? '';
    const aiOpenAIExtraBodyParams = settings?.ai?.openAIExtraBodyParams;
    const aiReasoningEffort = (settings?.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort;
    const aiThinkingBudget = settings?.ai?.thinkingBudget ?? aiDefaults.thinkingBudget ?? DEFAULT_GEMINI_THINKING_BUDGET;
    const anthropicThinkingEnabled = aiProvider === 'anthropic' && aiThinkingBudget > 0;
    const aiModelOptions = getModelOptions(aiProvider);
    const aiCopilotModel = settings?.ai?.copilotModel ?? getDefaultCopilotModel(aiProvider);
    const aiCopilotOptions = getCopilotModelOptions(aiProvider);

    const speechSettings = settings?.ai?.speechToText ?? {};
    const speechProvider = speechSettings.provider ?? 'gemini';
    const speechEnabled = speechSettings.enabled === true;
    const speechModel = speechSettings.model ?? (
        speechProvider === 'openai'
            ? OPENAI_SPEECH_MODELS[0]
            : speechProvider === 'gemini'
                ? GEMINI_SPEECH_MODELS[0]
                : speechProvider === 'parakeet'
                    ? DEFAULT_PARAKEET_MODEL
                    : DEFAULT_WHISPER_MODEL
    );
    const speechLanguage = speechSettings.language ?? '';
    const speechMode = (speechSettings.mode ?? 'smart_parse') as AudioCaptureMode;
    const speechFieldStrategy = (speechSettings.fieldStrategy ?? 'smart') as AudioFieldStrategy;
    const speechModelOptions = speechProvider === 'openai'
        ? OPENAI_SPEECH_MODELS
        : speechProvider === 'gemini'
            ? GEMINI_SPEECH_MODELS
            : speechProvider === 'parakeet'
                ? PARAKEET_MODELS.map((model) => model.id)
                : WHISPER_MODELS.map((model) => model.id);

    const selectedLocalSpeechModelSize = speechProvider === 'whisper'
        ? WHISPER_MODELS.find((model) => model.id === speechModel)?.sizeBytes ?? null
        : speechProvider === 'parakeet'
            ? PARAKEET_MODELS.find((model) => model.id === speechModel)?.sizeBytes ?? null
            : null;

    const updateAISettings = useCallback((next: AiSettingsUpdate) => {
        updateSettings({ ai: { ...(settings?.ai ?? {}), ...next } })
            .then(showSaved)
            .catch((error) => reportError('Failed to update AI settings', error));
    }, [settings?.ai, showSaved, updateSettings]);

    const updateSpeechSettings = useCallback((next: SpeechSettingsUpdate) => {
        updateSettings({
            ai: {
                ...(settings?.ai ?? {}),
                speechToText: { ...(settings?.ai?.speechToText ?? {}), ...next },
            },
        })
            .then(showSaved)
            .catch((error) => reportError('Failed to update speech settings', error));
    }, [settings?.ai, showSaved, updateSettings]);

    const handleAIProviderChange = useCallback((provider: AIProviderId) => {
        updateAISettings({
            provider,
            model: getDefaultAIConfig(provider).model,
            copilotModel: getDefaultCopilotModel(provider),
            thinkingBudget: getDefaultAIConfig(provider).thinkingBudget,
        });
    }, [updateAISettings]);

    const handleToggleAnthropicThinking = useCallback(() => {
        updateAISettings({
            thinkingBudget: anthropicThinkingEnabled ? 0 : (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024),
        });
    }, [anthropicThinkingEnabled, updateAISettings]);

    const handleAiApiKeyChange = useCallback((value: string) => {
        setAiApiKey(value);
        saveAIKey(aiProvider, value).catch((error) => reportError('Failed to save AI key', error));
    }, [aiProvider, enabled]);

    const handleSpeechProviderChange = useCallback((provider: SpeechProvider) => {
        const nextModel = provider === 'openai'
            ? OPENAI_SPEECH_MODELS[0]
            : provider === 'gemini'
                ? GEMINI_SPEECH_MODELS[0]
                : provider === 'parakeet'
                    ? DEFAULT_PARAKEET_MODEL
                    : DEFAULT_WHISPER_MODEL;
        const currentProvider = speechSettings.provider ?? 'gemini';
        updateSpeechSettings({
            provider,
            model: nextModel,
            offlineModelPath: provider === currentProvider && (provider === 'whisper' || provider === 'parakeet')
                ? speechSettings.offlineModelPath
                : undefined,
        });
    }, [speechSettings.offlineModelPath, speechSettings.provider, updateSpeechSettings]);

    const handleSpeechApiKeyChange = useCallback((value: string) => {
        setSpeechApiKey(value);
        if (speechProvider !== 'whisper' && speechProvider !== 'parakeet') {
            saveAIKey(speechProvider as AIProviderId, value).catch((error) => reportError('Failed to save speech API key', error));
        }
    }, [speechProvider, enabled]);

    const resolveWhisperPath = useCallback(async (modelId: string) => {
        if (!isTauri) return null;
        const entry = WHISPER_MODELS.find((model) => model.id === modelId);
        if (!entry) return null;
        const base = await dataDir();
        return await join(base, 'mindwtr', 'whisper-models', entry.fileName);
    }, [isTauri]);

    const resolveParakeetPath = useCallback(async () => {
        if (!isTauri) return null;
        const base = await dataDir();
        return await join(base, 'mindwtr', PARAKEET_MODEL_INSTALL_DIR);
    }, [isTauri]);

    const checkParakeetModelReady = useCallback(async (modelPath: string) => {
        for (const fileName of PARAKEET_REQUIRED_FILES) {
            const filePath = await join(modelPath, fileName);
            if (!await exists(filePath)) return false;
        }
        return true;
    }, []);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        markSettingsOpenTrace('ai-settings-load-provider-key', { provider: aiProvider });
        measureSettingsOpenStep(`ai-load-key:${aiProvider}`, () => loadAIKey(aiProvider))
            .then((key) => {
                if (active) setAiApiKey(key);
            })
            .catch(() => {
                if (active) setAiApiKey('');
            });
        return () => {
            active = false;
        };
    }, [aiProvider]);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        if (speechProvider === 'whisper' || speechProvider === 'parakeet') {
            setSpeechApiKey('');
            return () => {
                active = false;
            };
        }
        markSettingsOpenTrace('ai-settings-load-speech-key', { provider: speechProvider });
        measureSettingsOpenStep(`ai-load-speech-key:${speechProvider}`, () => loadAIKey(speechProvider as AIProviderId))
            .then((key) => {
                if (active) setSpeechApiKey(key);
            })
            .catch(() => {
                if (active) setSpeechApiKey('');
            });
        return () => {
            active = false;
        };
    }, [speechProvider]);

    useEffect(() => {
        if (!enabled || !isTauri) {
            setSpeechDownloadProgress(null);
            return;
        }
        let active = true;
        let unlisteners: Array<() => void> = [];
        import('@tauri-apps/api/event')
            .then(async ({ listen }) => {
                const handleProgress = (event: { payload: SpeechDownloadProgress }) => {
                    if (active) setSpeechDownloadProgress(event.payload);
                };
                return await Promise.all([
                    listen<SpeechDownloadProgress>('parakeet-model-download-progress', handleProgress),
                    listen<SpeechDownloadProgress>('whisper-model-download-progress', handleProgress),
                ]);
            })
            .then((dispose) => {
                if (active) {
                    unlisteners = dispose;
                } else {
                    dispose.forEach((unlisten) => unlisten());
                }
            })
            .catch((error) => reportError('Failed to subscribe to offline model download progress', error));
        return () => {
            active = false;
            unlisteners.forEach((unlisten) => unlisten());
        };
    }, [enabled, isTauri]);

    useEffect(() => {
        let active = true;
        if (!enabled) {
            return () => {
                active = false;
            };
        }
        if (speechProvider === 'parakeet') {
            const load = async () => {
                setSpeechOfflineSize(null);
                if (!isTauri) {
                    setSpeechOfflinePath(speechSettings.offlineModelPath ?? null);
                    setSpeechOfflineReadyState(false);
                    return;
                }
                markSettingsOpenTrace('ai-settings-load-parakeet-state', { model: speechModel });
                const resolved = speechSettings.offlineModelPath || await measureSettingsOpenStep(
                    `ai-resolve-parakeet-path:${speechModel}`,
                    resolveParakeetPath
                );
                if (!active) return;
                setSpeechOfflinePath(resolved);
                if (!resolved) {
                    setSpeechOfflineReadyState(false);
                    return;
                }
                const ready = await measureSettingsOpenStep(
                    `ai-check-parakeet-files:${speechModel}`,
                    () => checkParakeetModelReady(resolved)
                );
                if (!active) return;
                setSpeechOfflineReadyState(ready);
                setSpeechOfflineSize(ready ? selectedLocalSpeechModelSize : null);
                if (ready && !speechSettings.offlineModelPath) {
                    updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                }
            };
            load().catch(() => {
                if (active) {
                    setSpeechOfflineReadyState(false);
                    setSpeechOfflineSize(null);
                }
            });
            return () => {
                active = false;
            };
        }
        if (!isTauri || speechProvider !== 'whisper') {
            setSpeechOfflinePath(null);
            setSpeechOfflineSize(null);
            setSpeechOfflineReadyState(false);
            return () => {
                active = false;
            };
        }
        const load = async () => {
            markSettingsOpenTrace('ai-settings-load-whisper-state', { model: speechModel });
            const resolved = speechSettings.offlineModelPath || await measureSettingsOpenStep(
                `ai-resolve-whisper-path:${speechModel}`,
                () => resolveWhisperPath(speechModel)
            );
            if (!active) return;
            setSpeechOfflinePath(resolved);
            if (!resolved) {
                setSpeechOfflineSize(null);
                setSpeechOfflineReadyState(false);
                return;
            }
            try {
                const present = await measureSettingsOpenStep(
                    `ai-check-whisper-exists:${speechModel}`,
                    () => exists(resolved)
                );
                if (!present) {
                    setSpeechOfflineSize(null);
                    setSpeechOfflineReadyState(false);
                    return;
                }
                if (!speechSettings.offlineModelPath) {
                    updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                }
                const fileSize = await measureSettingsOpenStep(
                    `ai-read-whisper-size:${speechModel}`,
                    () => size(resolved)
                );
                if (active) {
                    setSpeechOfflineSize(fileSize);
                    setSpeechOfflineReadyState(true);
                }
            } catch {
                if (active) {
                    setSpeechOfflineSize(null);
                    setSpeechOfflineReadyState(false);
                }
            }
        };
        load().catch(() => {
            if (active) {
                setSpeechOfflineSize(null);
                setSpeechOfflineReadyState(false);
            }
        });
        return () => {
            active = false;
        };
    }, [
        checkParakeetModelReady,
        enabled,
        isTauri,
        resolveParakeetPath,
        resolveWhisperPath,
        selectedLocalSpeechModelSize,
        speechModel,
        speechProvider,
        speechSettings.offlineModelPath,
        updateSpeechSettings,
    ]);

    const handleDownloadWhisperModel = useCallback(async () => {
        if (!isTauri) return;
        setSpeechDownloadError(null);
        setSpeechDownloadProgress(null);
        setSpeechDownloadState('downloading');
        try {
            if (speechProvider === 'parakeet') {
                const { invoke } = await import('@tauri-apps/api/core');
                const resolved = await invoke<string>('download_parakeet_model', { model: speechModel });
                setSpeechOfflinePath(resolved);
                setSpeechOfflineSize(selectedLocalSpeechModelSize);
                setSpeechOfflineReadyState(true);
                updateSpeechSettings({ offlineModelPath: resolved, model: speechModel });
                setSpeechDownloadProgress(null);
                setSpeechDownloadState('success');
                setTimeout(() => setSpeechDownloadState('idle'), 2000);
                return;
            }

            const entry = WHISPER_MODELS.find((model) => model.id === speechModel);
            if (!entry) return;
            const { invoke } = await import('@tauri-apps/api/core');
            const resolved = await invoke<string>('download_whisper_model', { model: entry.id });
            const fileSize = resolved ? await size(resolved).catch(() => selectedLocalSpeechModelSize) : null;
            setSpeechOfflineSize(fileSize);
            setSpeechOfflinePath(resolved);
            setSpeechOfflineReadyState(Boolean(resolved));
            updateSpeechSettings({ offlineModelPath: resolved ?? undefined, model: entry.id });
            setSpeechDownloadProgress(null);
            setSpeechDownloadState('success');
            setTimeout(() => setSpeechDownloadState('idle'), 2000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setSpeechDownloadError(message);
            setSpeechDownloadProgress(null);
            setSpeechDownloadState('error');
            showToast(`Offline model download failed: ${message}`, 'error', 6000);
        }
    }, [isTauri, selectedLocalSpeechModelSize, showToast, speechModel, speechProvider, updateSpeechSettings]);

    const handleDeleteWhisperModel = useCallback(async () => {
        const currentPath = speechOfflinePath || speechSettings.offlineModelPath;
        if (!currentPath) {
            updateSpeechSettings({ offlineModelPath: undefined });
            setSpeechOfflineReadyState(false);
            return;
        }
        try {
            if (speechProvider === 'parakeet') {
                await remove(currentPath, { recursive: true });
            } else {
                await remove(currentPath);
            }
            setSpeechOfflineSize(null);
            setSpeechOfflineReadyState(false);
            if (speechProvider === 'parakeet') {
                setSpeechOfflinePath(await resolveParakeetPath());
            } else {
                setSpeechOfflinePath(null);
            }
            updateSpeechSettings({ offlineModelPath: undefined });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void logWarn('Offline model delete failed', {
                scope: 'ai',
                extra: { error: message },
            });
            setSpeechDownloadError(message);
            setSpeechDownloadProgress(null);
            setSpeechDownloadState('error');
            showToast(`Offline model delete failed: ${message}`, 'error', 6000);
        }
    }, [resolveParakeetPath, showToast, speechOfflinePath, speechProvider, speechSettings.offlineModelPath, updateSpeechSettings]);

    return {
        aiEnabled,
        aiProvider,
        aiModel,
        aiBaseUrl,
        aiOpenAIExtraBodyParams,
        aiModelOptions,
        aiCopilotModel,
        aiCopilotOptions,
        aiReasoningEffort,
        aiThinkingBudget,
        anthropicThinkingEnabled,
        aiApiKey,
        speechEnabled,
        speechProvider,
        speechModel,
        speechModelOptions,
        speechLanguage,
        speechMode,
        speechFieldStrategy,
        speechApiKey,
        speechOfflineReady: speechOfflineReadyState,
        speechOfflineModelPath: speechOfflinePath ?? speechSettings.offlineModelPath ?? '',
        speechOfflineEstimatedSize: selectedLocalSpeechModelSize,
        speechOfflineSize,
        speechDownloadState,
        speechDownloadError,
        speechDownloadProgress,
        onUpdateAISettings: updateAISettings,
        onUpdateSpeechSettings: updateSpeechSettings,
        onProviderChange: handleAIProviderChange,
        onSpeechProviderChange: handleSpeechProviderChange,
        onToggleAnthropicThinking: handleToggleAnthropicThinking,
        onAiApiKeyChange: handleAiApiKeyChange,
        onSpeechApiKeyChange: handleSpeechApiKeyChange,
        onDownloadWhisperModel: handleDownloadWhisperModel,
        onDeleteWhisperModel: handleDeleteWhisperModel,
    };
}
