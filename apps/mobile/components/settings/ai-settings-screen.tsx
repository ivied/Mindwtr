import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { Alert, KeyboardAvoidingView, Modal, NativeModules, Platform, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    DEFAULT_ANTHROPIC_THINKING_BUDGET,
    DEFAULT_GEMINI_THINKING_BUDGET,
    DEFAULT_REASONING_EFFORT,
    formatOpenAIExtraBodyParams,
    getCopilotModelOptions,
    getDefaultAIConfig,
    getDefaultCopilotModel,
    getModelOptions,
    parseOpenAIExtraBodyParamsInput,
    type AIProviderId,
    type AIReasoningEffort,
    useTaskStore,
} from '@mindwtr/core';

import { loadAIKey, saveAIKey } from '@/lib/ai-config';
import { useToast } from '@/contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError, logSettingsWarn } from '@/lib/settings-utils';

import { AiSettingsAssistantCard } from './ai-settings-assistant-card';
import { AiSettingsSpeechCard } from './ai-settings-speech-card';
import {
    downloadWhisperModelFile,
    isWhisperModelFileReady,
    isWhisperModelSafeDeleteTarget,
    resolveWhisperModelDownloadUrl,
    resolveWhisperNativeFsModule,
    resolveWhisperNativeHashModule,
    verifyWhisperModelFileHash,
    type WhisperModelNativeFs,
    type WhisperModelNativeHashFs,
    type WhisperModelPathInfo,
} from './ai-settings-whisper-model';
import {
    AI_PROVIDER_CONSENT_KEY,
    DEFAULT_WHISPER_MODEL,
    FOSS_LOCAL_LLM_COPILOT_OPTIONS,
    FOSS_LOCAL_LLM_MODEL_OPTIONS,
    MobileExtraConfig,
    WHISPER_MODEL_BASE_URL,
    WHISPER_MODELS,
} from './settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

type RNFSModule = typeof import('react-native-fs');
let rnfsModuleCache: unknown | null | undefined;
let rnfsHashModuleCache: WhisperModelNativeHashFs | null | undefined;
let rnfsDownloadModuleCache: WhisperModelNativeFs | null | undefined;

const buildWhisperModelDirectoryUri = (rootUri: string): string => {
    const normalized = rootUri.endsWith('/') ? rootUri : `${rootUri}/`;
    return `${normalized}whisper-models`;
};

const hasRNFSNativeModule = (): boolean => Boolean(
    (NativeModules as Record<string, unknown> | undefined)?.RNFSManager
);

const getRNFSModule = (): unknown | null => {
    if (rnfsModuleCache !== undefined) return rnfsModuleCache;
    if (!hasRNFSNativeModule()) {
        rnfsModuleCache = null;
        return null;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        rnfsModuleCache = require('react-native-fs') as RNFSModule;
        return rnfsModuleCache;
    } catch {
        rnfsModuleCache = null;
        return null;
    }
};

const getRNFSHashModule = (): WhisperModelNativeHashFs | null => {
    if (rnfsHashModuleCache !== undefined) return rnfsHashModuleCache;
    rnfsHashModuleCache = resolveWhisperNativeHashModule(getRNFSModule());
    return rnfsHashModuleCache;
};

const getRNFSDownloadModule = (): WhisperModelNativeFs | null => {
    if (rnfsDownloadModuleCache !== undefined) return rnfsDownloadModuleCache;
    rnfsDownloadModuleCache = resolveWhisperNativeFsModule(getRNFSModule());
    return rnfsDownloadModuleCache;
};

const toNativeHashPath = (uri: string): string => {
    if (uri.startsWith('file://')) return uri.replace(/^file:\/\//u, '');
    if (uri.startsWith('file:/')) return uri.replace(/^file:\//u, '/');
    return uri;
};

const hashWhisperModelFile = async (uri: string): Promise<string> => {
    const rnfs = getRNFSHashModule();
    if (!rnfs) {
        throw new Error('Whisper model hashing is unavailable in this build. Use a dev build or production build.');
    }
    return rnfs.hash(toNativeHashPath(uri), 'sha256');
};

const getWhisperNativePathInfo = async (uri: string): Promise<WhisperModelPathInfo | null> => {
    const rnfs = getRNFSDownloadModule();
    if (!rnfs || typeof rnfs.stat !== 'function') {
        return null;
    }
    const nativePath = toNativeHashPath(uri);
    try {
        const stat = await rnfs.stat(nativePath);
        const isDirectory = typeof stat.isDirectory === 'function' ? stat.isDirectory() : false;
        const isFile = typeof stat.isFile === 'function' ? stat.isFile() : !isDirectory;
        const size = typeof stat.size === 'number' && Number.isFinite(stat.size) ? stat.size : 0;
        return {
            exists: Boolean(isFile || isDirectory),
            isDirectory,
            size,
        };
    } catch {
        return null;
    }
};


export function AISettingsScreen() {
    const tc = useThemeColors();
    const { showToast } = useToast();
    const { tr, t } = useSettingsLocalization();
    const scrollContentStyleWithKeyboard = useSettingsScrollContent(140);
    const { settings, updateSettings } = useTaskStore();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const isExpoGo = Constants.appOwnership === 'expo';
    const [aiApiKey, setAiApiKey] = useState('');
    const [speechApiKey, setSpeechApiKey] = useState('');
    const [whisperDownloadState, setWhisperDownloadState] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle');
    const [whisperDownloadError, setWhisperDownloadError] = useState('');
    const [whisperNativePathInfo, setWhisperNativePathInfo] = useState<{ uri: string; info: WhisperModelPathInfo } | null>(null);
    const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
    const [speechOpen, setSpeechOpen] = useState(false);
    const [modelPicker, setModelPicker] = useState<null | 'model' | 'copilot' | 'speech'>(null);
    const [openAIExtraParamsDraft, setOpenAIExtraParamsDraft] = useState(() =>
        formatOpenAIExtraBodyParams(settings.ai?.openAIExtraBodyParams)
    );
    const [openAIExtraParamsError, setOpenAIExtraParamsError] = useState('');

    const aiProvider = (isFossBuild ? 'openai' : (settings.ai?.provider ?? 'openai')) as AIProviderId;
    const aiEnabled = settings.ai?.enabled === true;
    const aiModelOptions = isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS : getModelOptions(aiProvider);
    const aiModel = settings.ai?.model ?? (isFossBuild ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : getDefaultAIConfig(aiProvider).model);
    const aiBaseUrl = settings.ai?.baseUrl ?? '';
    const aiOpenAIExtraBodyParams = settings.ai?.openAIExtraBodyParams;
    const aiReasoningEffort = (settings.ai?.reasoningEffort ?? DEFAULT_REASONING_EFFORT) as AIReasoningEffort;
    const aiThinkingBudget = settings.ai?.thinkingBudget ?? getDefaultAIConfig(aiProvider).thinkingBudget ?? 0;
    const aiCopilotOptions = isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS : getCopilotModelOptions(aiProvider);
    const aiCopilotModel = settings.ai?.copilotModel ?? (isFossBuild ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(aiProvider));
    const anthropicThinkingEnabled = aiProvider === 'anthropic' && aiThinkingBudget > 0;
    const speechSettings = settings.ai?.speechToText ?? {};
    const speechEnabled = speechSettings.enabled === true;
    const configuredSpeechProvider = isFossBuild ? 'whisper' : (speechSettings.provider ?? 'gemini');
    const speechProvider = (configuredSpeechProvider === 'parakeet' ? 'whisper' : configuredSpeechProvider) as 'openai' | 'gemini' | 'whisper';
    const speechModel = speechSettings.model ?? (
        speechProvider === 'openai'
            ? 'gpt-4o-transcribe'
            : speechProvider === 'gemini'
                ? 'gemini-2.5-flash'
                : DEFAULT_WHISPER_MODEL
    );
    const speechLanguage = speechSettings.language ?? 'auto';
    const speechMode = speechSettings.mode ?? 'smart_parse';
    const speechFieldStrategy = speechSettings.fieldStrategy ?? 'smart';
    const speechModelOptions = isFossBuild
        ? WHISPER_MODELS.map((model) => model.id)
        : speechProvider === 'openai'
            ? ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1']
            : speechProvider === 'gemini'
                ? ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash']
                : WHISPER_MODELS.map((model) => model.id);

    const updateAISettings = useCallback((next: Partial<NonNullable<typeof settings.ai>>) => {
        updateSettings({ ai: { ...(settings.ai ?? {}), ...next } }).catch(logSettingsError);
    }, [settings.ai, updateSettings]);

    useEffect(() => {
        setOpenAIExtraParamsDraft(formatOpenAIExtraBodyParams(aiOpenAIExtraBodyParams));
        setOpenAIExtraParamsError('');
    }, [aiOpenAIExtraBodyParams]);

    const getAIProviderLabel = (provider: AIProviderId): string => (
        isFossBuild && provider === 'openai'
            ? tr('settings.aiMobile.localCustomOpenaiCompatible')
            : provider === 'openai'
                ? t('settings.aiProviderOpenAI')
                : provider === 'gemini'
                    ? t('settings.aiProviderGemini')
                    : t('settings.aiProviderAnthropic')
    );

    const getAIProviderPolicyUrl = (provider: AIProviderId): string => (
        isFossBuild && provider === 'openai'
            ? ''
            : provider === 'openai'
                ? 'https://openai.com/policies/privacy-policy'
                : provider === 'gemini'
                    ? 'https://policies.google.com/privacy'
                    : 'https://www.anthropic.com/privacy'
    );

    const loadAIProviderConsent = async (): Promise<Record<string, boolean>> => {
        try {
            const raw = await AsyncStorage.getItem(AI_PROVIDER_CONSENT_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            const entries = Object.entries(parsed as Record<string, unknown>)
                .map(([provider, value]) => [provider, value === true] as const);
            return Object.fromEntries(entries);
        } catch (error) {
            logSettingsWarn('Failed to load AI consent state', error);
            return {};
        }
    };

    const saveAIProviderConsent = async (provider: AIProviderId): Promise<void> => {
        try {
            const consentMap = await loadAIProviderConsent();
            consentMap[provider] = true;
            await AsyncStorage.setItem(AI_PROVIDER_CONSENT_KEY, JSON.stringify(consentMap));
        } catch (error) {
            logSettingsWarn('Failed to save AI consent state', error);
        }
    };

    const requestAIProviderConsent = async (provider: AIProviderId): Promise<boolean> => {
        const consentMap = await loadAIProviderConsent();
        if (consentMap[provider]) return true;

        const providerLabel = getAIProviderLabel(provider);
        const policyUrl = getAIProviderPolicyUrl(provider);
        const title = tr('settings.aiMobile.enableAiFeatures');
        const message = isFossBuild && provider === 'openai'
            ? tr('settings.aiMobile.toUseAiAssistantYourTaskTextAndOptionalNotes')
            : tr('settings.aiMobile.aiAssistantPrivacyPromptForProvider', { provider: providerLabel, privacyUrl: policyUrl });

        return await new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            Alert.alert(
                title,
                message,
                [
                    {
                        text: tr('common.cancel'),
                        style: 'cancel',
                        onPress: () => finish(false),
                    },
                    {
                        text: tr('settings.aiConsentAgree'),
                        onPress: () => {
                            void saveAIProviderConsent(provider);
                            finish(true);
                        },
                    },
                ],
                { cancelable: true, onDismiss: () => finish(false) }
            );
        });
    };

    const applyAIProviderDefaults = useCallback((provider: AIProviderId) => {
        const defaults = getDefaultAIConfig(provider);
        updateAISettings({
            provider,
            model: isFossBuild && provider === 'openai' ? FOSS_LOCAL_LLM_MODEL_OPTIONS[0] : defaults.model,
            copilotModel: isFossBuild && provider === 'openai' ? FOSS_LOCAL_LLM_COPILOT_OPTIONS[0] : getDefaultCopilotModel(provider),
            reasoningEffort: defaults.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
            thinkingBudget: defaults.thinkingBudget
                ?? (provider === 'gemini'
                    ? DEFAULT_GEMINI_THINKING_BUDGET
                    : provider === 'anthropic'
                        ? DEFAULT_ANTHROPIC_THINKING_BUDGET
                        : 0),
        });
    }, [isFossBuild, updateAISettings]);

    const updateSpeechSettings = (
        next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>
    ) => {
        updateAISettings({ speechToText: { ...(settings.ai?.speechToText ?? {}), ...next } });
    };

    useEffect(() => {
        if (!isFossBuild) return;
        const configuredProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;
        if (configuredProvider !== 'openai') {
            applyAIProviderDefaults('openai');
        }
    }, [applyAIProviderDefaults, isFossBuild, settings.ai?.provider]);

    useEffect(() => {
        if (!isFossBuild) return;
        const configuredProvider = settings.ai?.speechToText?.provider ?? 'whisper';
        const configuredModel = settings.ai?.speechToText?.model;
        const modelIsValidWhisper = typeof configuredModel === 'string'
            && WHISPER_MODELS.some((entry) => entry.id === configuredModel);
        if (configuredProvider !== 'whisper' || !modelIsValidWhisper) {
            updateSpeechSettings({
                provider: 'whisper',
                model: modelIsValidWhisper ? configuredModel : DEFAULT_WHISPER_MODEL,
            });
        }
    }, [isFossBuild, settings.ai?.speechToText?.model, settings.ai?.speechToText?.provider]);

    useEffect(() => {
        loadAIKey(aiProvider).then(setAiApiKey).catch(logSettingsError);
    }, [aiProvider]);

    useEffect(() => {
        if (speechProvider === 'whisper') {
            setSpeechApiKey('');
            return;
        }
        loadAIKey(speechProvider).then(setSpeechApiKey).catch(logSettingsError);
    }, [speechProvider]);

    const handleAIProviderChange = (provider: AIProviderId) => {
        if (provider === aiProvider) return;
        void (async () => {
            if (aiEnabled) {
                const consented = await requestAIProviderConsent(provider);
                if (!consented) return;
            }
            applyAIProviderDefaults(provider);
        })();
    };

    const handleAIEnabledToggle = (value: boolean) => {
        if (!value) {
            updateAISettings({ enabled: false });
            return;
        }
        void (async () => {
            const consented = await requestAIProviderConsent(aiProvider);
            if (!consented) return;
            updateAISettings({ enabled: true });
        })();
    };

    const handleAiApiKeyChange = useCallback((value: string) => {
        setAiApiKey(value);
        saveAIKey(aiProvider, value).catch(logSettingsError);
    }, [aiProvider]);

    const handleOpenAIExtraBodyParamsSave = useCallback(() => {
        const result = parseOpenAIExtraBodyParamsInput(openAIExtraParamsDraft);
        if (!result.ok) {
            const message = t('settings.aiExtraBodyParamsInvalid');
            setOpenAIExtraParamsError(message);
            showToast({
                title: t('settings.aiExtraBodyParams'),
                message,
                tone: 'warning',
                durationMs: 4200,
            });
            return;
        }
        setOpenAIExtraParamsError('');
        setOpenAIExtraParamsDraft(formatOpenAIExtraBodyParams(result.value));
        updateAISettings({ openAIExtraBodyParams: result.value });
    }, [openAIExtraParamsDraft, showToast, t, updateAISettings]);

    const handleAnthropicThinkingEnabledChange = useCallback((value: boolean) => {
        updateAISettings({
            thinkingBudget: value ? (DEFAULT_ANTHROPIC_THINKING_BUDGET || 1024) : 0,
        });
    }, [updateAISettings]);

    const getWhisperDirectories = () => {
        const candidates: Directory[] = [];
        try {
            candidates.push(new Directory(buildWhisperModelDirectoryUri(Paths.document.uri)));
        } catch (error) {
            logSettingsWarn('Whisper document directory unavailable', error);
        }
        try {
            candidates.push(new Directory(buildWhisperModelDirectoryUri(Paths.cache.uri)));
        } catch (error) {
            logSettingsWarn('Whisper cache directory unavailable', error);
        }
        return candidates;
    };

    const getWhisperDirectory = () => {
        const candidates = getWhisperDirectories();
        return candidates.length ? candidates[0] : null;
    };

    const normalizeWhisperPath = (uri: string) => {
        if (uri.startsWith('file://')) return uri;
        if (uri.startsWith('file:/')) {
            const stripped = uri.replace(/^file:\//, '/');
            return `file://${stripped}`;
        }
        if (uri.startsWith('/')) {
            return `file://${uri}`;
        }
        return uri;
    };

    const safePathInfo = (uri: string) => {
        const normalized = normalizeWhisperPath(uri);
        let pathInfo: ReturnType<typeof Paths.info> | null = null;
        try {
            pathInfo = Paths.info(normalized);
        } catch (error) {
            logSettingsWarn('Whisper path info failed', error);
        }
        try {
            const file = new File(normalized);
            if (file.exists) {
                const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0
                    ? file.size
                    : (pathInfo && 'size' in pathInfo && typeof pathInfo.size === 'number' ? pathInfo.size : undefined);
                return { exists: true, isDirectory: false, size };
            }
        } catch {
        }
        try {
            const dir = new Directory(normalized);
            if (dir.exists) {
                return { exists: true, isDirectory: true, size: 0 };
            }
        } catch {
        }
        return pathInfo ?? null;
    };

    const normalizeWhisperDirectoryUri = (uri: string) => normalizeWhisperPath(uri).replace(/\/+$/u, '');

    const isKnownWhisperDirectoryTarget = (uri: string) => {
        const normalized = normalizeWhisperDirectoryUri(uri);
        return getWhisperDirectories().some((directory) => normalizeWhisperDirectoryUri(directory.uri) === normalized);
    };

    const unlinkWhisperPathWithNativeFs = async (uri: string) => {
        const rnfs = getRNFSModule() as { unlink?: (path: string) => Promise<void> } | null;
        if (typeof rnfs?.unlink !== 'function') return false;
        await rnfs.unlink(toNativeHashPath(uri));
        return true;
    };

    const cleanupWhisperDirectoryBlockingFile = async (uri: string, _reason: string) => {
        const normalized = normalizeWhisperDirectoryUri(uri);
        if (!isKnownWhisperDirectoryTarget(normalized)) {
            logSettingsWarn('Refusing to repair unsafe Whisper model directory target', new Error(normalized));
            return false;
        }
        const expoInfo = safePathInfo(normalized);
        const nativeInfo = expoInfo?.exists && expoInfo.isDirectory === true
            ? null
            : await getWhisperNativePathInfo(normalized);
        const exists = Boolean(expoInfo?.exists || nativeInfo?.exists);
        const isDirectory = expoInfo?.isDirectory === true || nativeInfo?.isDirectory === true;
        if (!exists || isDirectory) return false;
        let deleted = false;
        try {
            new File(normalized).delete();
            deleted = true;
        } catch (error) {
            logSettingsWarn('Whisper model directory file cleanup with Expo failed', error);
        }
        if (!deleted) {
            try {
                deleted = await unlinkWhisperPathWithNativeFs(normalized);
            } catch (error) {
                logSettingsWarn('Whisper model directory file cleanup with native fs failed', error);
            }
        }
        const afterExpo = safePathInfo(normalized);
        const afterNative = afterExpo?.exists && afterExpo.isDirectory === true
            ? null
            : await getWhisperNativePathInfo(normalized);
        const repaired = !afterExpo?.exists && !afterNative?.exists
            || afterExpo?.isDirectory === true
            || afterNative?.isDirectory === true;
        return repaired;
    };

    const ensureWhisperDownloadDirectory = async (directory: Directory) => {
        const createDirectory = () => directory.create({ intermediates: true, idempotent: true });
        const info = safePathInfo(directory.uri);
        if (info?.exists && info.isDirectory === false) {
            await cleanupWhisperDirectoryBlockingFile(directory.uri, 'pre-create');
        }
        try {
            createDirectory();
        } catch (error) {
            const repaired = await cleanupWhisperDirectoryBlockingFile(directory.uri, 'create-failed');
            if (!repaired) throw error;
            createDirectory();
        }
        const afterInfo = safePathInfo(directory.uri);
        const afterNativeInfo = afterInfo?.isDirectory === true ? null : await getWhisperNativePathInfo(directory.uri);
        const ready = afterInfo?.isDirectory === true || afterNativeInfo?.isDirectory === true;
        if (!ready) {
            throw new Error(`Whisper model directory is blocked by a file: ${normalizeWhisperDirectoryUri(directory.uri)}`);
        }
    };

    const resolveWhisperModelPath = (modelId: string) => {
        const model = WHISPER_MODELS.find((entry) => entry.id === modelId);
        if (!model) return undefined;
        const base = getWhisperDirectory();
        if (!base) return undefined;
        const baseUri = base.uri.endsWith('/') ? base.uri : `${base.uri}/`;
        return new File(`${baseUri}${model.fileName}`).uri;
    };

    const findExistingWhisperModelPath = (modelId: string) => {
        const model = WHISPER_MODELS.find((entry) => entry.id === modelId);
        if (!model) return undefined;
        const fileName = model.fileName;
        const candidates: string[] = [];
        const appendCandidates = (base?: string | null) => {
            if (!base) return;
            const normalized = base.endsWith('/') ? base : `${base}/`;
            candidates.push(`${normalized}whisper-models/${fileName}`);
            candidates.push(`${normalized}${fileName}`);
        };
        appendCandidates(Paths.document?.uri ?? null);
        appendCandidates(Paths.cache?.uri ?? null);
        for (const candidate of candidates) {
            try {
                const info = safePathInfo(candidate);
                if (isWhisperModelFileReady(model, info)) {
                    return candidate;
                }
            } catch {
            }
        }
        return undefined;
    };

    const isWhisperModelFilePath = (uri?: string) => {
        if (!uri) return false;
        const baseName = Paths.basename(uri);
        return Boolean(baseName && baseName.endsWith('.bin'));
    };

    const getWhisperTargetUris = (fileName: string) => getWhisperDirectories().map((directory) => {
        const dirUri = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
        return `${dirUri}${fileName}`;
    });

    const isSafeWhisperModelTarget = (uri: string, model: (typeof WHISPER_MODELS)[number]) => isWhisperModelSafeDeleteTarget({
        uri: normalizeWhisperPath(uri),
        fileName: model.fileName,
        allowedUris: getWhisperTargetUris(model.fileName).map(normalizeWhisperPath),
    });

    const getWhisperPathInfoSize = (info: unknown): number => {
        if (!info || typeof info !== 'object') return 0;
        const size = (info as { size?: unknown }).size;
        return typeof size === 'number' ? size : 0;
    };

    const getWhisperReadiness = (model: (typeof WHISPER_MODELS)[number], uri: string) => {
        const info = safePathInfo(uri);
        return {
            info,
            ready: isWhisperModelFileReady(model, info),
        };
    };

    const applyWhisperModel = (modelId: string) => {
        updateSpeechSettings({ model: modelId, offlineModelPath: resolveWhisperModelPath(modelId) });
    };

    const handleSpeechProviderChange = useCallback((provider: 'openai' | 'gemini' | 'whisper') => {
        updateSpeechSettings({
            provider,
            model: provider === 'openai'
                ? 'gpt-4o-transcribe'
                : provider === 'gemini'
                    ? 'gemini-2.5-flash'
                    : DEFAULT_WHISPER_MODEL,
            offlineModelPath: provider === 'whisper'
                ? resolveWhisperModelPath(DEFAULT_WHISPER_MODEL)
                : undefined,
        });
    }, [updateSpeechSettings]);

    const handleSpeechApiKeyChange = useCallback((value: string) => {
        setSpeechApiKey(value);
        if (speechProvider === 'whisper') return;
        saveAIKey(speechProvider, value).catch(logSettingsError);
    }, [speechProvider]);

    const handleSpeechLanguageChange = useCallback((value: string) => {
        const trimmed = value.trim();
        updateSpeechSettings({ language: trimmed ? trimmed : 'auto' });
    }, [updateSpeechSettings]);

    useEffect(() => {
        if (speechProvider !== 'whisper') return;
        const storedPath = speechSettings.offlineModelPath;
        if (!storedPath) return;
        const info = safePathInfo(storedPath);
        if (info?.exists && info.isDirectory) {
            const resolved = resolveWhisperModelPath(speechModel);
            updateSpeechSettings({ offlineModelPath: resolved });
            return;
        }
        if (!info?.exists || info.isDirectory) {
            const existing = findExistingWhisperModelPath(speechModel);
            if (existing && existing !== storedPath) {
                updateSpeechSettings({ offlineModelPath: existing });
                return;
            }
        }
        if (!isWhisperModelFilePath(storedPath)) {
            const resolved = resolveWhisperModelPath(speechModel);
            if (resolved && resolved !== storedPath) {
                updateSpeechSettings({ offlineModelPath: resolved });
            }
        }
    }, [speechModel, speechProvider, speechSettings.offlineModelPath]);

    const selectedWhisperModel = WHISPER_MODELS.find((model) => model.id === speechModel) ?? WHISPER_MODELS[0];
    const whisperModelPath = speechProvider === 'whisper'
        ? (speechSettings.offlineModelPath ?? resolveWhisperModelPath(speechModel))
        : undefined;

    useEffect(() => {
        let cancelled = false;
        const normalizedPath = whisperModelPath ? normalizeWhisperPath(whisperModelPath) : '';
        if (speechProvider !== 'whisper' || !normalizedPath || !selectedWhisperModel) {
            setWhisperNativePathInfo(null);
            return () => {
                cancelled = true;
            };
        }
        const expoInfo = safePathInfo(normalizedPath);
        if (isWhisperModelFileReady(selectedWhisperModel, expoInfo)) {
            setWhisperNativePathInfo(null);
            return () => {
                cancelled = true;
            };
        }
        void getWhisperNativePathInfo(normalizedPath).then((info) => {
            if (cancelled) return;
            setWhisperNativePathInfo(info ? { uri: normalizedPath, info } : null);
        });
        return () => {
            cancelled = true;
        };
    }, [speechModel, speechProvider, whisperModelPath, selectedWhisperModel]);

    let whisperDownloaded = false;
    let whisperSizeLabel = '';
    if (whisperModelPath && selectedWhisperModel) {
        const normalizedPath = normalizeWhisperPath(whisperModelPath);
        const { info, ready } = getWhisperReadiness(selectedWhisperModel, normalizedPath);
        const nativeInfo = whisperNativePathInfo?.uri === normalizedPath ? whisperNativePathInfo.info : null;
        const nativeReady = isWhisperModelFileReady(selectedWhisperModel, nativeInfo);
        whisperDownloaded = ready || nativeReady;
        const size = getWhisperPathInfoSize(ready ? info : (nativeInfo ?? info));
        if (whisperDownloaded && size > 0) {
            whisperSizeLabel = `${(size / (1024 * 1024)).toFixed(1)} MB`;
        }
    }


    const handleDownloadWhisperModel = async () => {
        if (!selectedWhisperModel) return;

        if (isExpoGo) {
            const message = tr('settings.aiMobile.whisperDownloadsRequireADevBuildOrProductionBuildNot');
            setWhisperDownloadError(message);
            setWhisperDownloadState('error');
            showToast({
                title: t('settings.speechOfflineDownloadError'),
                message,
                tone: 'warning',
                durationMs: 5200,
            });
            return;
        }
        setWhisperDownloadError('');
        setWhisperDownloadState('downloading');
        const clearSuccess = () => {
            setTimeout(() => setWhisperDownloadState('idle'), 2000);
        };
        try {
            const directories = getWhisperDirectories();
            if (!directories.length) {
                throw new Error('Whisper storage unavailable');
            }
            const fileName = selectedWhisperModel.fileName;
            if (!fileName) {
                throw new Error('Whisper model filename missing');
            }
            const url = `${WHISPER_MODEL_BASE_URL}/${fileName}`;
            let lastError: Error | null = null;
            for (const directory of directories) {
                try {
                    await ensureWhisperDownloadDirectory(directory);
                    const dirUri = directory.uri.endsWith('/') ? directory.uri : `${directory.uri}/`;
                    const targetFile = new File(`${dirUri}${fileName}`);
                    const conflictInfo = safePathInfo(targetFile.uri);
                    const safeTarget = isSafeWhisperModelTarget(targetFile.uri, selectedWhisperModel);
                    if (conflictInfo?.exists && conflictInfo.isDirectory) {
                        throw new Error(tr('settings.aiMobile.offlineModelPathIsFolder', { path: targetFile.uri }));
                    }
                    if (!safeTarget) {
                        throw new Error(tr('settings.aiMobile.offlineModelPathIsUnsafe', { path: targetFile.uri }));
                    }
                    const existingInfo = safePathInfo(targetFile.uri);
                    const existingNativeInfo = existingInfo?.exists ? null : await getWhisperNativePathInfo(targetFile.uri);
                    const existingReady = isWhisperModelFileReady(selectedWhisperModel, existingInfo)
                        || isWhisperModelFileReady(selectedWhisperModel, existingNativeInfo);
                    if ((existingInfo?.exists && existingInfo.isDirectory === false) || existingNativeInfo?.exists) {
                        if (existingReady) {
                            try {
                                await verifyWhisperModelFileHash(selectedWhisperModel, targetFile.uri, hashWhisperModelFile);
                                updateSpeechSettings({ offlineModelPath: targetFile.uri, model: selectedWhisperModel.id });
                                setWhisperNativePathInfo(existingNativeInfo ? { uri: normalizeWhisperPath(targetFile.uri), info: existingNativeInfo } : null);
                                setWhisperDownloadState('success');
                                clearSuccess();
                                return;
                            } catch (error) {
                                logSettingsWarn('Whisper existing model hash verification failed', error);
                            }
                        }
                        try {
                            targetFile.delete();
                        } catch (error) {
                            logSettingsWarn('Whisper incomplete file cleanup failed', error);
                        }
                    }
                    try {
                        const nativeDownloadModule = getRNFSDownloadModule();
                        const downloadResult = await downloadWhisperModelFile({
                            url,
                            targetFile,
                            nativeFs: nativeDownloadModule,
                            resolveDownloadUrl: resolveWhisperModelDownloadUrl,
                            expoDownloadFile: async (downloadUrl, destination, options) => {
                                await File.downloadFileAsync(downloadUrl, destination, options);
                                return destination;
                            },
                        });
                        const { file, bytesWritten } = downloadResult;
                        const downloadedInfo = safePathInfo(file.uri);
                        const nativeDownloadedInfo = await getWhisperNativePathInfo(file.uri);
                        const expoReady = isWhisperModelFileReady(selectedWhisperModel, downloadedInfo, bytesWritten);
                        const nativeReady = isWhisperModelFileReady(selectedWhisperModel, nativeDownloadedInfo, bytesWritten);
                        const ready = expoReady || nativeReady;
                        if (!ready) {
                            try {
                                file.delete();
                            } catch (error) {
                                logSettingsWarn('Whisper incomplete download cleanup failed', error);
                            }
                            throw new Error('Downloaded Whisper model file looks incomplete. Please retry on Wi-Fi.');
                        }
                        try {
                            await verifyWhisperModelFileHash(selectedWhisperModel, file.uri, hashWhisperModelFile);
                        } catch (error) {
                            try {
                                file.delete();
                            } catch (cleanupError) {
                                logSettingsWarn('Whisper failed integrity cleanup failed', cleanupError);
                            }
                            throw error;
                        }
                        updateSpeechSettings({ offlineModelPath: file.uri, model: selectedWhisperModel.id });
                        setWhisperNativePathInfo(nativeDownloadedInfo ? { uri: normalizeWhisperPath(file.uri), info: nativeDownloadedInfo } : null);
                    } catch (downloadError) {
                        const fallbackMessage = tr('settings.aiMobile.downloadFailedPleaseRetryOnWiFiLargeModelsCannot');
                        throw new Error(downloadError instanceof Error
                            ? `${fallbackMessage}
${downloadError.message}`
                            : fallbackMessage);
                    }
                    setWhisperDownloadState('success');
                    clearSuccess();
                    return;
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                    logSettingsWarn('Whisper model download failed', error);
                }
            }
            throw lastError ?? new Error('Whisper storage unavailable');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setWhisperDownloadError(message);
            setWhisperDownloadState('error');
            logSettingsWarn('Whisper model download failed', error);
            showToast({
                title: t('settings.speechOfflineDownloadError'),
                message,
                tone: 'warning',
                durationMs: 5200,
            });
        }
    };

    const handleDeleteWhisperModel = () => {
        try {
            if (whisperModelPath && selectedWhisperModel) {
                const info = safePathInfo(whisperModelPath);
                if (info?.exists && info.isDirectory === false && isSafeWhisperModelTarget(whisperModelPath, selectedWhisperModel)) {
                    const file = new File(normalizeWhisperPath(whisperModelPath));
                    file.delete();
                } else if (info?.exists) {
                    logSettingsWarn('Refusing to delete unsafe Whisper model target', new Error(whisperModelPath));
                }
            }
            updateSpeechSettings({ offlineModelPath: undefined });
        } catch (error) {
            logSettingsWarn('Whisper model delete failed', error);
            showToast({
                title: t('settings.speechOfflineDeleteError'),
                message: t('settings.speechOfflineDeleteErrorBody'),
                tone: 'warning',
                durationMs: 4200,
            });
        }
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.ai')} />
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
                style={{ flex: 1 }}
            >
                <ScrollView
                    style={styles.scrollView}
                    keyboardShouldPersistTaps="handled"
                    contentContainerStyle={scrollContentStyleWithKeyboard}
                >
                    <AiSettingsAssistantCard
                        aiApiKey={aiApiKey}
                        aiAssistantOpen={aiAssistantOpen}
                        aiBaseUrl={aiBaseUrl}
                        aiCopilotModel={aiCopilotModel}
                        aiCopilotOptions={aiCopilotOptions}
                        aiEnabled={aiEnabled}
                        aiExtraBodyParamsDraft={openAIExtraParamsDraft}
                        aiExtraBodyParamsError={openAIExtraParamsError}
                        aiModel={aiModel}
                        aiModelOptions={aiModelOptions}
                        aiProvider={aiProvider}
                        aiReasoningEffort={aiReasoningEffort}
                        aiThinkingBudget={aiThinkingBudget}
                        anthropicThinkingEnabled={anthropicThinkingEnabled}
                        getAIProviderLabel={getAIProviderLabel}
                        isFossBuild={isFossBuild}
                        tr={tr}
                        onAiApiKeyChange={handleAiApiKeyChange}
                        onAiBaseUrlChange={(value) => updateAISettings({ baseUrl: value })}
                        onAiCopilotModelChange={(value) => updateAISettings({ copilotModel: value })}
                        onAiEnabledChange={handleAIEnabledToggle}
                        onAiExtraBodyParamsDraftChange={setOpenAIExtraParamsDraft}
                        onAiExtraBodyParamsSave={handleOpenAIExtraBodyParamsSave}
                        onAiModelChange={(value) => updateAISettings({ model: value })}
                        onAiProviderChange={handleAIProviderChange}
                        onAiReasoningEffortChange={(value) => updateAISettings({ reasoningEffort: value })}
                        onAiThinkingBudgetChange={(value) => updateAISettings({ thinkingBudget: value })}
                        onAnthropicThinkingEnabledChange={handleAnthropicThinkingEnabledChange}
                        onModelPickerChange={setModelPicker}
                        onToggleOpen={() => setAiAssistantOpen((prev) => !prev)}
                        t={t}
                        tc={tc}
                    />

                    <AiSettingsSpeechCard
                        isExpoGo={isExpoGo}
                        isFossBuild={isFossBuild}
                        tr={tr}
                        onDeleteWhisperModel={handleDeleteWhisperModel}
                        onDownloadWhisperModel={() => void handleDownloadWhisperModel()}
                        onOpenModelPicker={() => setModelPicker('speech')}
                        onSpeechApiKeyChange={handleSpeechApiKeyChange}
                        onSpeechEnabledChange={(value) => updateSpeechSettings({ enabled: value })}
                        onSpeechFieldStrategyChange={(value) => updateSpeechSettings({ fieldStrategy: value })}
                        onSpeechLanguageChange={handleSpeechLanguageChange}
                        onSpeechModeChange={(value) => updateSpeechSettings({ mode: value })}
                        onSpeechProviderChange={handleSpeechProviderChange}
                        onToggleOpen={() => setSpeechOpen((prev) => !prev)}
                        speechApiKey={speechApiKey}
                        speechEnabled={speechEnabled}
                        speechFieldStrategy={speechFieldStrategy}
                        speechLanguage={speechLanguage}
                        speechMode={speechMode}
                        speechModel={speechModel}
                        speechOpen={speechOpen}
                        speechProvider={speechProvider}
                        t={t}
                        tc={tc}
                        whisperDownloadError={whisperDownloadError}
                        whisperDownloadState={whisperDownloadState}
                        whisperDownloaded={whisperDownloaded}
                        whisperSizeLabel={whisperSizeLabel}
                    />

                    <Modal
                        transparent
                        visible={modelPicker !== null}
                        animationType="fade"
                        onRequestClose={() => setModelPicker(null)}
                    >
                        <Pressable style={styles.pickerOverlay} onPress={() => setModelPicker(null)}>
                            <View
                                style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onStartShouldSetResponder={() => true}
                            >
                                <Text style={[styles.pickerTitle, { color: tc.text }]}>
                                    {modelPicker === 'model'
                                        ? t('settings.aiModel')
                                        : modelPicker === 'copilot'
                                            ? t('settings.aiCopilotModel')
                                            : t('settings.speechModel')}
                                </Text>
                                <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
                                    {(modelPicker === 'model'
                                        ? aiModelOptions
                                        : modelPicker === 'copilot'
                                            ? aiCopilotOptions
                                            : speechModelOptions).map((option) => {
                                        const selected = modelPicker === 'model'
                                            ? aiModel === option
                                            : modelPicker === 'copilot'
                                                ? aiCopilotModel === option
                                                : speechModel === option;
                                        return (
                                            <TouchableOpacity
                                                key={option}
                                                style={[
                                                    styles.pickerOption,
                                                    { borderColor: tc.border, backgroundColor: selected ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    if (modelPicker === 'model') {
                                                        updateAISettings({ model: option });
                                                    } else if (modelPicker === 'copilot') {
                                                        updateAISettings({ copilotModel: option });
                                                    } else if (speechProvider === 'whisper') {
                                                        applyWhisperModel(option);
                                                    } else {
                                                        updateSpeechSettings({ model: option });
                                                    }
                                                    setModelPicker(null);
                                                }}
                                            >
                                                <Text style={[styles.pickerOptionText, { color: selected ? tc.tint : tc.text }]}>
                                                    {option}
                                                </Text>
                                                {selected && <Text style={{ color: tc.tint, fontSize: 18 }}>✓</Text>}
                                            </TouchableOpacity>
                                        );
                                    })}
                                </ScrollView>
                            </View>
                        </Pressable>
                    </Modal>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}
