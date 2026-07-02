import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import {
    shallow,
    useTaskStore,
    buildTaskUpdatesFromSpeechResult,
    flushPendingSave,
    findSelectableProjectByTitleAndArea,
    getQuickAddProjectInitialProps,
    parseQuickAdd,
    normalizeClockTimeInput,
    normalizeFocusTaskLimit,
    getDefaultTaskAreaMode,
    resolveDefaultNewTaskAreaId,
    AREA_FILTER_ALL,
    AREA_FILTER_NONE,
    resolveAreaFilter,
    safeFormatDate,
    generateUUID,
    splitQuickAddBulkLines,
    DEFAULT_PROJECT_COLOR,
    formatFocusTaskLimitText,
    tFallback,
    type Area,
    type Attachment,
    type Project,
    type QuickAddResult,
    type Task,
} from '@mindwtr/core';
import { BaseDirectory, mkdir, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { dataDir, join } from '@tauri-apps/api/path';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { isFlatpakRuntime, isTauriRuntime } from '../lib/runtime';
import { reportError } from '../lib/report-error';
import { logWarn } from '../lib/app-log';
import { loadAIKey } from '../lib/ai-config';
import { encodeWav, resampleAudio } from '../lib/audio-utils';
import { appendAudioChunkWithLimit, getMaxAudioSamples, MAX_AUDIO_RECORDING_SECONDS } from '../lib/audio-capture-buffer';
import { getPreferredDesktopAudioCaptureBackend } from '../lib/audio-capture-backend';
import { processAudioCapture, type SpeechToTextResult } from '../lib/speech-to-text';
import { DEFAULT_PARAKEET_MODEL, DEFAULT_WHISPER_MODEL } from '../lib/speech-models';
import { dispatchNavigateEvent } from '../lib/navigation-events';
import { ModalPortal } from './ModalPortal';
import { useUiStore } from '../store/ui-store';
import {
    QUICK_ADD_NATIVE_TARGET_MAIN,
    QUICK_ADD_NATIVE_TARGET_WINDOW,
    shouldHandleQuickAddNativeEvent,
} from '../lib/quick-add-native-event';
import { QUICK_ADD_MAIN_WINDOW_LABEL, QUICK_ADD_SAVED_EVENT } from '../lib/quick-add-saved-event';
import { TaskInput } from './Task/TaskInput';
import { AreaSelector } from './ui/AreaSelector';
import { FocusStarIcon } from './FocusStarIcon';

const AUDIO_CAPTURE_DIR = 'mindwtr/audio-captures';
const QUICK_ADD_IMAGE_CAPTURE_DIR = 'mindwtr/quick-add-images';
const TARGET_SAMPLE_RATE = 16_000;

type PastedImageAttachment = {
    attachment: Attachment;
    relativePath: string;
};

type QuickAddModalProps = {
    standaloneWindow?: boolean;
};

type QuickAddOpenDetail = {
    initialProps?: Partial<Task>;
    initialValue?: string;
    captureMode?: 'text' | 'audio';
};

type ParsedQuickAddTask = {
    input: string;
    parsed: QuickAddResult;
};

function getCreatedTaskId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const maybeId = (result as { id?: unknown }).id;
    return typeof maybeId === 'string' && maybeId.trim() ? maybeId : null;
}

function getClipboardImageFiles(data: DataTransfer | null): File[] {
    if (!data) return [];
    const files: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
    }
    for (const file of Array.from(data.files ?? [])) {
        if (!file.type.toLowerCase().startsWith('image/')) continue;
        if (files.includes(file)) continue;
        files.push(file);
    }
    return files;
}

function getImageExtension(file: File): string {
    const mime = file.type.toLowerCase();
    if (mime === 'image/png') return 'png';
    if (mime === 'image/jpeg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    if (mime === 'image/gif') return 'gif';
    if (mime === 'image/bmp') return 'bmp';
    if (mime === 'image/svg+xml') return 'svg';
    if (mime === 'image/heic') return 'heic';
    if (mime === 'image/heif') return 'heif';
    const nameMatch = file.name.match(/\.([a-z0-9]{2,5})$/i);
    if (nameMatch?.[1]) return nameMatch[1].toLowerCase() === 'jpeg' ? 'jpg' : nameMatch[1].toLowerCase();
    return 'png';
}

function mergeQuickAddAttachments(...groups: Array<Attachment[] | undefined>): Attachment[] | undefined {
    const attachments = groups.flatMap((group) => group ?? []);
    return attachments.length > 0 ? attachments : undefined;
}

async function readClipboardFileBytes(file: File): Promise<Uint8Array> {
    if (typeof file.arrayBuffer === 'function') {
        return new Uint8Array(await file.arrayBuffer());
    }
    return new Uint8Array(await new Response(file).arrayBuffer());
}

async function readTextFile(file: File): Promise<string> {
    if (typeof file.text === 'function') {
        return file.text();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
        reader.readAsText(file);
    });
}

export function QuickAddModal({ standaloneWindow = false }: QuickAddModalProps) {
    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const { addTask, addProject, projects, areas, settings, setHighlightTask } = useTaskStore(
        (state) => ({
            addTask: state.addTask,
            addProject: state.addProject,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            setHighlightTask: state.setHighlightTask,
        }),
        shallow
    );
    const setProjectView = useUiStore((state) => state.setProjectView);
    const setEditingTaskId = useUiStore((state) => state.setEditingTaskId);
    const showToast = useUiStore((state) => state.showToast);
    const derivedState = getDerivedState();
    const { allContexts, allTags } = derivedState;
    const suggestionTokens = useMemo(
        () => Array.from(new Set([...allContexts, ...allTags])).sort(),
        [allContexts, allTags]
    );
    const { t } = useLanguage();
    const [isOpen, setIsOpen] = useState(false);
    const [value, setValue] = useState('');
    const [selectedAreaId, setSelectedAreaId] = useState('');
    const [initialProps, setInitialProps] = useState<Partial<Task> | null>(null);
    const [focusNewTask, setFocusNewTask] = useState(false);
    const [forcedCaptureMode, setForcedCaptureMode] = useState<'text' | 'audio' | null>(null);
    const [captureMode, setCaptureMode] = useState<'text' | 'audio'>(
        settings?.gtd?.defaultCaptureMethod === 'audio' ? 'audio' : 'text'
    );
    const [isRecording, setIsRecording] = useState(false);
    const [recordingBusy, setRecordingBusy] = useState(false);
    const [recordingError, setRecordingError] = useState<string | null>(null);
    const [recordingBackend, setRecordingBackend] = useState<'web' | 'native' | null>(null);
    const [pastedImageAttachments, setPastedImageAttachments] = useState<PastedImageAttachment[]>([]);
    const [pastedImageError, setPastedImageError] = useState<string | null>(null);
    const [pastingImageCount, setPastingImageCount] = useState(0);
    const [bulkQuickAddLines, setBulkQuickAddLines] = useState<string[] | null>(null);
    const [bulkQuickAddError, setBulkQuickAddError] = useState<string | null>(null);
    const lastActiveElementRef = useRef<HTMLElement | null>(null);
    const modalRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const audioStreamRef = useRef<MediaStream | null>(null);
    const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const audioChunksRef = useRef<Float32Array[]>([]);
    const audioSampleCountRef = useRef(0);
    const audioDurationLimitHitRef = useRef(false);
    const inputSampleRateRef = useRef<number>(16_000);
    const isOpenRef = useRef(false);
    const openRequestInFlightRef = useRef(false);
    const standaloneDataRefreshRef = useRef<Promise<void> | null>(null);
    const pastedImageAttachmentsRef = useRef<PastedImageAttachment[]>([]);
    const sortedAreas = useMemo(() => [...areas].filter((area) => !area.deletedAt).sort((a, b) => a.order - b.order), [areas]);
    const defaultAreaMode = getDefaultTaskAreaMode(settings);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, sortedAreas),
        [settings?.filters?.areaId, sortedAreas],
    );
    const activeAreaId = resolvedAreaFilter !== AREA_FILTER_ALL && resolvedAreaFilter !== AREA_FILTER_NONE
        ? resolvedAreaFilter
        : undefined;
    const defaultAreaId = defaultAreaMode === 'active'
        ? activeAreaId ?? ''
        : resolveDefaultNewTaskAreaId(settings, sortedAreas) ?? '';
    const quickAddParseOptions = useMemo(
        () => ({
            knownContexts: allContexts,
            knownTags: allTags,
            defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || undefined,
            preserveText: settings.quickAddAutoClean !== true,
        }),
        [allContexts, allTags, settings.gtd?.defaultScheduleTime, settings.quickAddAutoClean],
    );
    const parsedInput = useMemo(
        () => parseQuickAdd(value, projects, new Date(), areas, quickAddParseOptions),
        [value, projects, areas, quickAddParseOptions],
    );
    const hasProjectOverride = Boolean(initialProps?.projectId || parsedInput.props.projectId || parsedInput.projectTitle);
    const showAreaSelector = !hasProjectOverride;
    const isPastingImage = pastingImageCount > 0;
    const pastedAttachments = useMemo(
        () => pastedImageAttachments.map((item) => item.attachment),
        [pastedImageAttachments],
    );
    const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
    const canFocusNewTask = focusNewTask || derivedState.focusedCount < focusTaskLimit;
    const focusDisabled = !focusNewTask && !canFocusNewTask;
    const addFocusLabel = tFallback(t, 'agenda.addToFocus', "Add to today's focus");
    const removeFocusLabel = tFallback(t, 'agenda.removeFromFocus', 'Remove from focus');
    const focusLimitLabel = formatFocusTaskLimitText(
        tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus items'),
        focusTaskLimit,
    );
    const focusLabel = focusNewTask
        ? removeFocusLabel
        : (focusDisabled ? focusLimitLabel : addFocusLabel);

    useEffect(() => {
        pastedImageAttachmentsRef.current = pastedImageAttachments;
    }, [pastedImageAttachments]);

    const cleanupPastedImageAttachments = useCallback((attachments: PastedImageAttachment[]) => {
        attachments.forEach(({ relativePath }) => {
            remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                void logWarn('Pasted image cleanup failed', {
                    scope: 'attachment',
                    extra: { error: error instanceof Error ? error.message : String(error) },
                });
            });
        });
    }, []);

    const resetPastedImageAttachments = useCallback((cleanup: boolean) => {
        const current = pastedImageAttachmentsRef.current;
        if (cleanup && current.length > 0) {
            cleanupPastedImageAttachments(current);
        }
        pastedImageAttachmentsRef.current = [];
        setPastedImageAttachments([]);
        setPastedImageError(null);
        setPastingImageCount(0);
    }, [cleanupPastedImageAttachments]);

    useEffect(() => () => {
        cleanupPastedImageAttachments(pastedImageAttachmentsRef.current);
        pastedImageAttachmentsRef.current = [];
    }, [cleanupPastedImageAttachments]);

    const refreshStandaloneData = useCallback(async () => {
        if (!standaloneWindow) return;
        if (!standaloneDataRefreshRef.current) {
            standaloneDataRefreshRef.current = useTaskStore.getState()
                .fetchData({ silent: true })
                .finally(() => {
                    standaloneDataRefreshRef.current = null;
                });
        }
        await standaloneDataRefreshRef.current;
    }, [standaloneWindow]);

    useEffect(() => {
        isOpenRef.current = isOpen;
        if (!isOpen) {
            openRequestInFlightRef.current = false;
        }
    }, [isOpen]);

    const openQuickAdd = useCallback(async (detail?: QuickAddOpenDetail) => {
        if (isOpenRef.current || openRequestInFlightRef.current) return false;
        openRequestInFlightRef.current = true;
        try {
            setInitialProps(detail?.initialProps ?? null);
            setFocusNewTask(Boolean(detail?.initialProps?.isFocusedToday));
            setValue(detail?.initialValue ?? '');
            setForcedCaptureMode(detail?.captureMode ?? null);
            setBulkQuickAddLines(null);
            setBulkQuickAddError(null);
            resetPastedImageAttachments(true);
            isOpenRef.current = true;
            setIsOpen(true);
            if (standaloneWindow) {
                void refreshStandaloneData().catch((error) => reportError('Failed to refresh quick add data', error));
            }
            return true;
        } catch (error) {
            openRequestInFlightRef.current = false;
            throw error;
        }
    }, [refreshStandaloneData]);

    useEffect(() => {
        if (!isTauriRuntime()) return;

        let unlisten: (() => void) | undefined;
        const nativeTarget = standaloneWindow ? QUICK_ADD_NATIVE_TARGET_WINDOW : QUICK_ADD_NATIVE_TARGET_MAIN;
        const openFromTauri = async () => {
            await openQuickAdd();
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke<boolean>('consume_quick_add_pending', { target: nativeTarget });
            } catch (e) {
                reportError('Failed to open quick add', e);
            }
        };

        const setup = async () => {
            const [{ listen }, { invoke }] = await Promise.all([
                import('@tauri-apps/api/event'),
                import('@tauri-apps/api/core'),
            ]);

            unlisten = await listen('quick-add', (event) => {
                if (!shouldHandleQuickAddNativeEvent(event.payload, nativeTarget)) return;
                openFromTauri().catch((error) => reportError('Failed to open quick add', error));
            });

            const pending = await invoke<boolean>('consume_quick_add_pending', { target: nativeTarget });
            if (pending) {
                await openQuickAdd();
            }
        };

        setup().catch((error) => reportError('Failed to initialize quick add', error));

        return () => {
            if (unlisten) unlisten();
        };
    }, [openQuickAdd, standaloneWindow]);

    useEffect(() => {
        const handler: EventListener = (event) => {
            const detail = (event as CustomEvent<QuickAddOpenDetail>).detail;
            openQuickAdd(detail).catch((error) => reportError('Failed to open quick add', error));
        };
        window.addEventListener('mindwtr:quick-add', handler);
        return () => window.removeEventListener('mindwtr:quick-add', handler);
    }, [openQuickAdd]);

    useEffect(() => {
        if (!isOpen) return;
        lastActiveElementRef.current = document.activeElement as HTMLElement | null;
        if (!value) setValue('');
    }, [isOpen, value]);

    useEffect(() => {
        if (!isOpen) return;
        const nextArea = initialProps?.areaId ?? (initialProps?.projectId ? '' : defaultAreaId);
        setSelectedAreaId(nextArea ?? '');
    }, [defaultAreaId, initialProps?.areaId, initialProps?.projectId, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        if (parsedInput.props.areaId) {
            setSelectedAreaId(parsedInput.props.areaId);
        }
    }, [isOpen, parsedInput.props.areaId]);


    useEffect(() => {
        if (!isOpen) return;
        const nextMode = forcedCaptureMode ?? (settings?.gtd?.defaultCaptureMethod === 'audio' ? 'audio' : 'text');
        setCaptureMode(nextMode);
        setRecordingError(null);
    }, [forcedCaptureMode, isOpen, settings?.gtd?.defaultCaptureMethod]);

    const applySpeechResult = useCallback(async (taskId: string, result: SpeechToTextResult) => {
        const {
            tasks: currentTasks,
            projects: currentProjects,
            addProject: addProjectNow,
            updateTask: updateTaskNow,
            settings: currentSettings,
        } = useTaskStore.getState();
        const existing = currentTasks.find((task) => task.id === taskId);
        if (!existing) return;

        const { updates, suggestedProjectTitle } = buildTaskUpdatesFromSpeechResult(existing, result, currentSettings);
        if (suggestedProjectTitle && !existing.projectId) {
            const targetAreaId = updates.areaId ?? existing.areaId;
            const match = findSelectableProjectByTitleAndArea(currentProjects, suggestedProjectTitle, targetAreaId);
            if (match) {
                updates.projectId = match.id;
            } else {
                const created = await addProjectNow(
                    suggestedProjectTitle,
                    DEFAULT_PROJECT_COLOR,
                    targetAreaId ? { areaId: targetAreaId } : undefined
                );
                if (!created) return;
                updates.projectId = created.id;
            }
        }

        if (Object.keys(updates).length) {
            await updateTaskNow(taskId, updates);
        }
    }, []);

    const hideStandaloneWindow = useCallback(() => {
        if (!standaloneWindow || !isTauriRuntime()) return;
        import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('hide_quick_add_window'))
            .catch((error) => reportError('Failed to hide quick add window', error));
    }, [standaloneWindow]);

    const notifyStandaloneTaskSaved = useCallback(async () => {
        if (!standaloneWindow || !isTauriRuntime()) return;
        try {
            const { emitTo } = await import('@tauri-apps/api/event');
            await emitTo(QUICK_ADD_MAIN_WINDOW_LABEL, QUICK_ADD_SAVED_EVENT, { savedAt: new Date().toISOString() });
        } catch (error) {
            reportError('Failed to notify main window after quick add save', error);
        }
    }, [standaloneWindow]);

    const close = useCallback((options?: { keepPastedImages?: boolean }) => {
        isOpenRef.current = false;
        openRequestInFlightRef.current = false;
        setIsOpen(false);
        setInitialProps(null);
        setFocusNewTask(false);
        setValue('');
        setSelectedAreaId('');
        setForcedCaptureMode(null);
        setBulkQuickAddLines(null);
        setBulkQuickAddError(null);
        resetPastedImageAttachments(!options?.keepPastedImages);
        lastActiveElementRef.current?.focus();
        hideStandaloneWindow();
    }, [hideStandaloneWindow, resetPastedImageAttachments]);

    const createPastedImageAttachment = useCallback(async (file: File): Promise<PastedImageAttachment> => {
        const now = new Date();
        const nowIso = now.toISOString();
        const displayTitle = `${tFallback(t, 'quickAdd.pastedImageTitle', 'Screenshot')} ${safeFormatDate(now, 'Pp')}`;
        const fileName = `mindwtr-paste-${safeFormatDate(now, 'yyyyMMdd-HHmmss')}-${generateUUID().slice(0, 8)}.${getImageExtension(file)}`;
        await mkdir(QUICK_ADD_IMAGE_CAPTURE_DIR, { baseDir: BaseDirectory.Data, recursive: true });
        const relativePath = `${QUICK_ADD_IMAGE_CAPTURE_DIR}/${fileName}`;
        const bytes = await readClipboardFileBytes(file);
        await writeFile(relativePath, bytes, { baseDir: BaseDirectory.Data });
        const baseDir = await dataDir();
        const absolutePath = await join(baseDir, QUICK_ADD_IMAGE_CAPTURE_DIR, fileName);
        return {
            relativePath,
            attachment: {
                id: generateUUID(),
                kind: 'file',
                title: displayTitle,
                uri: absolutePath,
                mimeType: file.type || `image/${getImageExtension(file)}`,
                size: file.size,
                createdAt: nowIso,
                updatedAt: nowIso,
            },
        };
    }, [t]);

    const handleQuickAddPaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
        const imageFiles = getClipboardImageFiles(event.clipboardData);
        if (imageFiles.length > 0) {
            event.preventDefault();
            setPastedImageError(null);
            imageFiles.forEach((file) => {
                setPastingImageCount((count) => count + 1);
                void createPastedImageAttachment(file)
                    .then((pastedAttachment) => {
                        if (!isOpenRef.current) {
                            cleanupPastedImageAttachments([pastedAttachment]);
                            return;
                        }
                        setPastedImageAttachments((current) => {
                            const next = [...current, pastedAttachment];
                            pastedImageAttachmentsRef.current = next;
                            return next;
                        });
                    })
                    .catch((error) => {
                        reportError('Failed to attach pasted image', error);
                        setPastedImageError(tFallback(t, 'quickAdd.pastedImageError', 'Could not attach pasted image.'));
                    })
                    .finally(() => {
                        setPastingImageCount((count) => Math.max(0, count - 1));
                    });
            });
            return;
        }

        const pastedText = event.clipboardData?.getData('text/plain') ?? '';
        const lines = splitQuickAddBulkLines(pastedText);
        if (lines.length <= 1) return;
        event.preventDefault();
        setBulkQuickAddLines(lines);
        setBulkQuickAddError(null);
    }, [cleanupPastedImageAttachments, createPastedImageAttachment, t]);

    const handleTextFileImport = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const text = await readTextFile(file);
            const lines = splitQuickAddBulkLines(text);
            setBulkQuickAddError(null);
            if (lines.length > 1) {
                setBulkQuickAddLines(lines);
            } else if (lines.length === 1) {
                setValue(lines[0]);
            }
        } catch (error) {
            reportError('Failed to import quick add text file', error);
            setBulkQuickAddError(tFallback(t, 'quickAdd.bulkImportError', 'Could not read that text file.'));
        }
    }, [t]);

    const startRecording = useCallback(async () => {
        if (recordingBusy || isRecording) return;
        setRecordingError(null);
        try {
            const preferredBackend = getPreferredDesktopAudioCaptureBackend({
                isTauriRuntime: isTauriRuntime(),
                isFlatpakRuntime: isFlatpakRuntime(),
            });

            if (preferredBackend === 'native') {
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('start_audio_recording');
                    setRecordingBackend('native');
                    setIsRecording(true);
                    return;
                } catch (error) {
                    void logWarn('Native audio recording failed, falling back to web capture', {
                        scope: 'audio',
                        extra: {
                            error: error instanceof Error ? error.message : String(error),
                            preferredBackend,
                        },
                    });
                }
            }
            if (!navigator.mediaDevices?.getUserMedia) {
                setRecordingError(t('quickAdd.audioErrorBody'));
                return;
            }
            if (navigator.mediaDevices.enumerateDevices) {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const hasInput = devices.some((device) => device.kind === 'audioinput');
                if (!hasInput) {
                    setRecordingError(`${t('quickAdd.audioErrorBody')} (No microphone detected)`);
                    return;
                }
            }
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const AudioContextConstructor =
                window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AudioContextConstructor) {
                throw new Error('AudioContext unavailable');
            }
            const context = new AudioContextConstructor();
            await context.resume();
            const source = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            const zeroGain = context.createGain();
            zeroGain.gain.value = 0;
            audioChunksRef.current = [];
            audioSampleCountRef.current = 0;
            audioDurationLimitHitRef.current = false;
            inputSampleRateRef.current = context.sampleRate;
            processor.onaudioprocess = (event) => {
                if (audioDurationLimitHitRef.current) return;
                const channel = event.inputBuffer.getChannelData(0);
                const result = appendAudioChunkWithLimit({
                    chunks: audioChunksRef.current,
                    chunk: channel,
                    maxSamples: getMaxAudioSamples(inputSampleRateRef.current),
                    sampleCount: audioSampleCountRef.current,
                });
                audioSampleCountRef.current = result.sampleCount;
                audioDurationLimitHitRef.current = result.limitHit;
            };
            source.connect(processor);
            processor.connect(zeroGain);
            zeroGain.connect(context.destination);
            audioContextRef.current = context;
            audioStreamRef.current = stream;
            audioSourceRef.current = source;
            audioProcessorRef.current = processor;
            setRecordingBackend('web');
            setIsRecording(true);
        } catch (error) {
            reportError('Audio recording failed', error);
            const message = error instanceof Error ? error.message : String(error);
            setRecordingError(`${t('quickAdd.audioErrorBody')} (${message})`);
        }
    }, [isRecording, recordingBusy, t]);

    const stopRecording = useCallback(async ({ saveTask }: { saveTask: boolean }) => {
        if (recordingBusy) return;
        if (!isRecording) return;
        setRecordingBusy(true);
        setIsRecording(false);
        try {
            type NativeResult = {
                path: string;
                relativePath: string;
                sampleRate: number;
                channels: number;
                size: number;
            };

            let wavBytes: Uint8Array | null = null;
            let fileName: string;
            let relativePath: string;
            let absolutePath: string;
            let audioByteSize: number | undefined;

            const now = new Date();
            if (recordingBackend === 'native' && isTauriRuntime()) {
                const { invoke } = await import('@tauri-apps/api/core');
                const result = await invoke<NativeResult>('stop_audio_recording');
                relativePath = result.relativePath;
                absolutePath = result.path;
                const parts = absolutePath.split(/[\\/]/);
                fileName = parts[parts.length - 1] || 'mindwtr-audio.wav';
                audioByteSize = result.size;
            } else {
                const currentAudioContext = audioContextRef.current;
                if (currentAudioContext?.state === 'running') {
                    // Suspending the graph gives ScriptProcessorNode one stable stop point before teardown.
                    await currentAudioContext.suspend();
                }
                audioProcessorRef.current?.disconnect();
                audioSourceRef.current?.disconnect();
                audioProcessorRef.current = null;
                audioSourceRef.current = null;
                audioStreamRef.current?.getTracks().forEach((track) => track.stop());
                audioStreamRef.current = null;
                if (currentAudioContext && currentAudioContext.state !== 'closed') {
                    await currentAudioContext.close();
                }
                audioContextRef.current = null;

                const chunks = audioChunksRef.current;
                audioChunksRef.current = [];
                audioSampleCountRef.current = 0;
                audioDurationLimitHitRef.current = false;
                if (!saveTask) return;
                if (!chunks.length) {
                    throw new Error('No audio data captured');
                }

                const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                const buffer = new Float32Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    buffer.set(chunk, offset);
                    offset += chunk.length;
                }
                const resampled = resampleAudio(buffer, inputSampleRateRef.current, TARGET_SAMPLE_RATE);
                wavBytes = encodeWav(resampled, TARGET_SAMPLE_RATE);
                audioByteSize = wavBytes.length;

                const timestamp = safeFormatDate(now, 'yyyyMMdd-HHmmss');
                fileName = `mindwtr-audio-${timestamp}.wav`;
                await mkdir(AUDIO_CAPTURE_DIR, { baseDir: BaseDirectory.Data, recursive: true });
                relativePath = `${AUDIO_CAPTURE_DIR}/${fileName}`;
                await writeFile(relativePath, wavBytes, { baseDir: BaseDirectory.Data });
                const baseDir = await dataDir();
                absolutePath = await join(baseDir, AUDIO_CAPTURE_DIR, fileName);
            }

            if (!saveTask) {
                remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                    void logWarn('Audio cleanup failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                });
                return;
            }

            const nowIso = now.toISOString();
            const displayTitle = `${t('quickAdd.audioNoteTitle')} ${safeFormatDate(now, 'Pp')}`;
            const speech = settings.ai?.speechToText;
            const provider = speech?.provider ?? 'gemini';
            const model = speech?.model ?? (
                provider === 'openai' ? 'gpt-4o-transcribe'
                    : provider === 'gemini' ? 'gemini-2.5-flash'
                        : provider === 'parakeet' ? DEFAULT_PARAKEET_MODEL
                            : DEFAULT_WHISPER_MODEL
            );
            const apiSpeechProvider = provider === 'openai' || provider === 'gemini' ? provider : null;
            const apiKey = apiSpeechProvider ? await loadAIKey(apiSpeechProvider).catch(() => '') : '';
            const modelPath = apiSpeechProvider ? undefined : speech?.offlineModelPath;
            const speechReady = speech?.enabled
                ? apiSpeechProvider
                    ? Boolean(apiKey)
                    : Boolean(modelPath)
                : false;
            const saveAudioAttachments = settings.gtd?.saveAudioAttachments !== false || !speechReady;

            const attachment: Attachment | null = saveAudioAttachments
                ? {
                    id: generateUUID(),
                    kind: 'file',
                    title: displayTitle,
                    uri: absolutePath,
                    mimeType: 'audio/wav',
                    size: audioByteSize,
                    createdAt: nowIso,
                    updatedAt: nowIso,
                }
                : null;

            const attachments = [...(initialProps?.attachments ?? [])];
            if (attachment) attachments.push(attachment);
            const props: Partial<Task> = {
                status: 'inbox',
                ...initialProps,
                attachments,
            };
            if (!props.status) props.status = 'inbox';

            if (standaloneWindow) {
                await refreshStandaloneData().catch((error) => reportError('Failed to refresh quick add data', error));
            }
            const addTaskResult = await addTask(displayTitle, props);
            if (addTaskResult.success && standaloneWindow) {
                await flushPendingSave().catch((error) => reportError('Failed to save quick add task', error));
                await notifyStandaloneTaskSaved();
            }
            close();

            if (!addTaskResult.success || !addTaskResult.id) return;
            const taskId = addTaskResult.id;

            const runSpeech = async (bytes: Uint8Array) => {
                const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
                    ? Intl.DateTimeFormat().resolvedOptions().timeZone
                    : undefined;
                void processAudioCapture(
                    { bytes, mimeType: 'audio/wav', name: fileName, path: absolutePath },
                    {
                        provider,
                        apiKey,
                        model,
                        modelPath,
                        language: speech?.language,
                        mode: speech?.mode ?? 'smart_parse',
                        fieldStrategy: speech?.fieldStrategy ?? 'smart',
                        parseModel: provider === 'openai' && settings.ai?.provider === 'openai' ? settings.ai?.model : undefined,
                        now: new Date(),
                        timeZone,
                    }
                )
                    .then((result) => applySpeechResult(taskId, result))
                    .catch((error) => void logWarn('Speech-to-text failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    }))
                    .finally(() => {
                        if (!saveAudioAttachments) {
                            remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                                void logWarn('Audio cleanup failed', {
                                    scope: 'audio',
                                    extra: { error: error instanceof Error ? error.message : String(error) },
                                });
                            });
                        }
                    });
            };

            if (speechReady) {
                if (wavBytes) {
                    void runSpeech(wavBytes);
                } else {
                    void readFile(relativePath, { baseDir: BaseDirectory.Data })
                        .then((bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
                        .then((bytes) => runSpeech(bytes))
                        .catch((error) => {
                            void logWarn('Failed to load audio for transcription', {
                                scope: 'audio',
                                extra: { error: error instanceof Error ? error.message : String(error) },
                            });
                            if (!saveAudioAttachments) {
                                remove(relativePath, { baseDir: BaseDirectory.Data }).catch((cleanupError) => {
                                    void logWarn('Audio cleanup failed', {
                                        scope: 'audio',
                                        extra: {
                                            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                                        },
                                    });
                                });
                            }
                        });
                }
            } else if (!saveAudioAttachments) {
                remove(relativePath, { baseDir: BaseDirectory.Data }).catch((error) => {
                    void logWarn('Audio cleanup failed', {
                        scope: 'audio',
                        extra: { error: error instanceof Error ? error.message : String(error) },
                    });
                });
            }
        } catch (error) {
            reportError('Failed to save recording', error);
            const message = error instanceof Error ? error.message : String(error);
            setRecordingError(`${t('quickAdd.audioErrorBody')} (${message})`);
        } finally {
            setRecordingBusy(false);
            setRecordingBackend(null);
        }
    }, [
        addTask,
        applySpeechResult,
        close,
        initialProps,
        isRecording,
        recordingBusy,
        recordingBackend,
        refreshStandaloneData,
        notifyStandaloneTaskSaved,
        standaloneWindow,
        settings.ai?.model,
        settings.ai?.provider,
        settings.ai?.speechToText,
        settings.gtd?.saveAudioAttachments,
        t,
    ]);

    useEffect(() => {
        if (!isRecording) return undefined;
        const timeout = window.setTimeout(() => {
            void stopRecording({ saveTask: true });
        }, MAX_AUDIO_RECORDING_SECONDS * 1000);
        return () => window.clearTimeout(timeout);
    }, [isRecording, stopRecording]);

    const handleClose = () => {
        if (isRecording && !recordingBusy) {
            void stopRecording({ saveTask: false });
        }
        close();
    };

    const openCreatedTaskForEditing = useCallback((taskId: string, props: Partial<Task>) => {
        setHighlightTask(taskId);
        setEditingTaskId(taskId);
        if (props.projectId) {
            setProjectView({ selectedProjectId: props.projectId });
            dispatchNavigateEvent('projects');
            return;
        }
        switch (props.status) {
            case 'next':
                dispatchNavigateEvent('next');
                return;
            case 'waiting':
                dispatchNavigateEvent('waiting');
                return;
            case 'someday':
                dispatchNavigateEvent('someday');
                return;
            case 'reference':
                dispatchNavigateEvent('reference');
                return;
            case 'done':
                dispatchNavigateEvent('done');
                return;
            default:
                dispatchNavigateEvent('inbox');
        }
    }, [setEditingTaskId, setHighlightTask, setProjectView]);

    const createTaskFromParsedQuickAdd = useCallback(async ({
        currentAreas,
        currentProjects,
        extraAttachments,
        input,
        parsed,
    }: {
        currentAreas: Area[];
        currentProjects: Project[];
        extraAttachments?: Attachment[];
        input: string;
        parsed: QuickAddResult;
    }) => {
        const { title, props, projectTitle, detectedDate } = parsed;
        const baseProps: Partial<Task> = { ...initialProps, ...props };
        const mergedAttachments = mergeQuickAddAttachments(
            initialProps?.attachments,
            props.attachments,
            extraAttachments,
        );
        if (mergedAttachments) {
            baseProps.attachments = mergedAttachments;
        }
        if (focusNewTask && canFocusNewTask) {
            baseProps.isFocusedToday = true;
        }
        const shouldApplyDetectedDate = Boolean(detectedDate?.date && !baseProps.dueDate);
        if (shouldApplyDetectedDate && detectedDate) {
            baseProps.dueDate = detectedDate.date;
        }
        const finalTitle = shouldApplyDetectedDate && detectedDate
            ? detectedDate.titleWithoutDate
            : (title || input.trim() || extraAttachments?.[0]?.title || tFallback(t, 'quickAdd.pastedImageTitle', 'Screenshot'));
        if (!finalTitle.trim()) return { success: false, currentProjects, currentAreas };
        const hasProjectAssignment = Boolean(baseProps.projectId || projectTitle);
        if (!hasProjectAssignment) {
            baseProps.areaId = props.areaId || selectedAreaId || undefined;
        }
        let projectId = baseProps.projectId;
        let nextProjects = currentProjects;
        if (!projectId && projectTitle) {
            const existing = currentProjects.find((project) => (
                project.status !== 'archived'
                && project.title.toLowerCase() === projectTitle.toLowerCase()
            ));
            if (existing) {
                projectId = existing.id;
            } else {
                const created = await addProject(
                    projectTitle,
                    DEFAULT_PROJECT_COLOR,
                    getQuickAddProjectInitialProps(baseProps, selectedAreaId)
                );
                if (!created) return { success: false, currentProjects, currentAreas };
                projectId = created.id;
                nextProjects = [...currentProjects, created];
            }
        }
        const mergedProps: Partial<Task> = { status: 'inbox', ...baseProps, projectId };
        if (projectId) mergedProps.areaId = undefined;
        if (!baseProps.status) mergedProps.status = 'inbox';
        const addTaskResult = await addTask(finalTitle, mergedProps);
        if (!addTaskResult.success) return { success: false, currentProjects: nextProjects, currentAreas };
        return {
            success: true,
            createdTaskId: getCreatedTaskId(addTaskResult),
            props: mergedProps,
            currentAreas,
            currentProjects: nextProjects,
        };
    }, [addProject, addTask, canFocusNewTask, focusNewTask, initialProps, selectedAreaId, t]);

    useEffect(() => {
        if (!isOpen) return;
        const handler = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            handleClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [handleClose, isOpen]);

    const saveTask = async ({ openAfterSave = false }: { openAfterSave?: boolean } = {}) => {
        if (isPastingImage) return;
        const hasPastedAttachments = pastedAttachments.length > 0;
        if (!value.trim() && !hasPastedAttachments) return;
        let currentProjects = projects;
        let currentAreas = areas;
        if (standaloneWindow) {
            await refreshStandaloneData().catch((error) => reportError('Failed to refresh quick add data', error));
            const currentState = useTaskStore.getState();
            currentProjects = currentState.projects;
            currentAreas = currentState.areas;
        }
        const parsed = parseQuickAdd(value, currentProjects, new Date(), currentAreas, quickAddParseOptions);
        if (parsed.invalidDateCommands && parsed.invalidDateCommands.length > 0) {
            return;
        }
        const result = await createTaskFromParsedQuickAdd({
            currentAreas,
            currentProjects,
            extraAttachments: pastedAttachments,
            input: value,
            parsed,
        });
        if (!result.success) return;
        if (standaloneWindow) {
            await flushPendingSave().catch((error) => reportError('Failed to save quick add task', error));
            await notifyStandaloneTaskSaved();
        }
        close({ keepPastedImages: true });
        if (openAfterSave && result.createdTaskId && result.props && !standaloneWindow) {
            openCreatedTaskForEditing(result.createdTaskId, result.props);
        }
    };

    const confirmBulkQuickAdd = async () => {
        if (!bulkQuickAddLines || bulkQuickAddLines.length === 0 || isPastingImage) return;
        let currentProjects = projects;
        let currentAreas = areas;
        if (standaloneWindow) {
            await refreshStandaloneData().catch((error) => reportError('Failed to refresh quick add data', error));
            const currentState = useTaskStore.getState();
            currentProjects = currentState.projects;
            currentAreas = currentState.areas;
        }
        const parsedItems: ParsedQuickAddTask[] = bulkQuickAddLines.map((line) => ({
            input: line,
            parsed: parseQuickAdd(line, currentProjects, new Date(), currentAreas, quickAddParseOptions),
        }));
        const invalid = parsedItems.find((item) => item.parsed.invalidDateCommands?.length);
        if (invalid?.parsed.invalidDateCommands?.length) {
            setBulkQuickAddError(
                `${tFallback(t, 'quickAdd.invalidDateCommand', 'Invalid date command')}: ${invalid.parsed.invalidDateCommands.join(', ')}`
            );
            return;
        }

        for (const item of parsedItems) {
            const result = await createTaskFromParsedQuickAdd({
                currentAreas,
                currentProjects,
                input: item.input,
                parsed: item.parsed,
            });
            if (!result.success) {
                setBulkQuickAddError(tFallback(t, 'quickAdd.bulkCreateError', 'Could not create all tasks.'));
                return;
            }
            currentProjects = result.currentProjects;
            currentAreas = result.currentAreas;
        }

        if (standaloneWindow) {
            await flushPendingSave().catch((error) => reportError('Failed to save quick add tasks', error));
            await notifyStandaloneTaskSaved();
        }
        setBulkQuickAddLines(null);
        setBulkQuickAddError(null);
        close({ keepPastedImages: true });
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        await saveTask();
    };

    const scheduledLabel = initialProps?.startTime
        ? safeFormatDate(initialProps.startTime, 'Pp')
        : null;
    const loadingLabel = tFallback(t, 'common.loading', 'Loading...');
    const audioButtonLabel = recordingBusy
        ? loadingLabel
        : isRecording
            ? t('quickAdd.audioStop')
            : t('quickAdd.audioRecord');
    const audioStatusLabel = recordingBusy
        ? tFallback(t, 'quickAdd.audioProcessing', 'Processing audio capture...')
        : isRecording
            ? t('quickAdd.audioRecording')
            : t('quickAdd.audioCaptureLabel');
    const pastedImageLabel = pastedImageAttachments.length === 1
        ? tFallback(t, 'quickAdd.pastedImageAttached', '1 image attached')
        : tFallback(t, 'quickAdd.pastedImagesAttached', `${pastedImageAttachments.length} images attached`);
    const saveDisabled = isPastingImage || (!value.trim() && pastedImageAttachments.length === 0);
    const bulkTaskCount = bulkQuickAddLines?.length ?? 0;
    const bulkConfirmTitle = tFallback(t, 'quickAdd.bulkConfirmTitle', 'Create {{count}} tasks?')
        .replace('{{count}}', String(bulkTaskCount));
    const bulkPreviewLines = bulkQuickAddLines?.slice(0, 8) ?? [];
    const bulkMoreCount = Math.max(0, bulkTaskCount - bulkPreviewLines.length);

    if (!isOpen) return null;

    return (
        <ModalPortal>
        <div
            className={cn(
                'fixed inset-0 flex items-start justify-center z-50',
                standaloneWindow ? 'bg-transparent px-3 pt-4' : 'bg-black/50 pt-[20vh]',
            )}
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={handleClose}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (event.currentTarget !== event.target) return;
                event.preventDefault();
                handleClose();
            }}
        >
            <div
                ref={modalRef}
                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-visible flex flex-col"
                role="dialog"
                aria-modal="true"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key !== 'Tab') return;
                    const container = modalRef.current;
                    if (!container) return;
                    const focusable = Array.from(
                        container.querySelectorAll<HTMLElement>(
                            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                        )
                    ).filter((el) => !el.hasAttribute('disabled'));
                    if (focusable.length === 0) return;
                    const first = focusable[0];
                    const last = focusable[focusable.length - 1];
                    if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        first.focus();
                    } else if (event.shiftKey && document.activeElement === first) {
                        event.preventDefault();
                        last.focus();
                    }
                }}
            >
                <div className="px-4 py-3 border-b flex items-center justify-between">
                    <h3 className="font-semibold">{t('nav.addTask')}</h3>
                    <button onClick={handleClose} className="text-sm text-muted-foreground hover:text-foreground">Esc</button>
                </div>
                <div className="px-4 pt-4">
                    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
                        <button
                            type="button"
                            onClick={() => setCaptureMode('text')}
                            className={cn(
                                'px-3 py-1 text-xs rounded-md transition-colors',
                                captureMode === 'text' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('settings.captureDefaultText')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setCaptureMode('audio')}
                            className={cn(
                                'px-3 py-1 text-xs rounded-md transition-colors',
                                captureMode === 'audio' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {t('settings.captureDefaultAudio')}
                        </button>
                    </div>
                </div>
                {captureMode === 'text' ? (
                    <form onSubmit={handleSubmit} className="p-4 space-y-2">
                        <TaskInput
                            value={value}
                            autoFocus={captureMode === 'text'}
                            projects={projects}
                            contexts={suggestionTokens}
                            areas={areas}
                            onCreateProject={async (title) => {
                                const created = await addProject(
                                    title,
                                    DEFAULT_PROJECT_COLOR,
                                    getQuickAddProjectInitialProps({}, selectedAreaId)
                                );
                                return created?.id ?? null;
                            }}
                            onChange={(next) => setValue(next)}
                            onPaste={handleQuickAddPaste}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    handleClose();
                                }
                            }}
                            placeholder={t('nav.addTask')}
                            className={cn(
                                "w-full bg-card border border-border rounded-lg py-3 px-4 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-all",
                            )}
                        />
                        {isPastingImage ? (
                            <p className="text-xs text-muted-foreground">
                                {tFallback(t, 'quickAdd.pastedImageSaving', 'Attaching image...')}
                            </p>
                        ) : null}
                        {pastedImageAttachments.length > 0 ? (
                            <p className="text-xs text-muted-foreground">{pastedImageLabel}</p>
                        ) : null}
                        {pastedImageError ? (
                            <p className="text-xs text-destructive">{pastedImageError}</p>
                        ) : null}
                        {bulkQuickAddError && !bulkQuickAddLines ? (
                            <p className="text-xs text-destructive">{bulkQuickAddError}</p>
                        ) : null}
                        {showAreaSelector && (
                            <div className="flex flex-col gap-1">
                                <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.areaLabel')}</label>
                                <AreaSelector
                                    areas={sortedAreas}
                                    value={selectedAreaId}
                                    onChange={setSelectedAreaId}
                                    placeholder={t('taskEdit.noAreaOption')}
                                    noAreaLabel={t('taskEdit.noAreaOption')}
                                    searchPlaceholder={t('areas.search')}
                                    noMatchesLabel={t('common.noMatches')}
                                    createAreaLabel={t('areas.create')}
                                    className="w-full"
                                />
                            </div>
                        )}
                        {/* "Add to today's focus" is a task property, so it joins the property
                            stack as a labeled field-style toggle (peer of Area) rather than an
                            orphaned chip or a control jammed beside the title input. On = filled
                            amber star, matching how focused tasks render in the list. */}
                        <button
                            type="button"
                            onClick={() => {
                                if (focusDisabled) {
                                    // Keep the hard focus cap, but explain the block rather
                                    // than presenting a dead disabled control.
                                    showToast(focusLimitLabel, 'info');
                                    return;
                                }
                                setFocusNewTask((current) => !current);
                            }}
                            className={cn(
                                'flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                focusNewTask
                                    ? 'border-amber-400/70 bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-300 dark:hover:bg-amber-500/30'
                                    : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                            )}
                            aria-label={focusLabel}
                            aria-pressed={focusNewTask}
                            title={focusLabel}
                        >
                            <FocusStarIcon filled={focusNewTask} className="h-4 w-4 shrink-0" />
                            <span className="truncate">{focusLabel}</span>
                        </button>
                        <p className="text-xs text-muted-foreground">{t('quickAdd.help')}</p>
                        {parsedInput.invalidDateCommands && parsedInput.invalidDateCommands.length > 0 ? (
                            <p className="text-xs text-destructive">
                                {t('quickAdd.invalidDateCommand')}: {parsedInput.invalidDateCommands.join(', ')}
                            </p>
                        ) : null}
                        {scheduledLabel && (
                            <p className="text-xs text-muted-foreground">
                                {t('calendar.scheduleAction')}: {scheduledLabel}
                            </p>
                        )}
                        <div className="flex justify-end gap-2 pt-1">
                            <input
                                ref={fileInputRef}
                                aria-label={tFallback(t, 'quickAdd.bulkImportTextFileLabel', 'Import text file')}
                                className="sr-only"
                                type="file"
                                accept=".txt,text/plain"
                                onChange={(event) => {
                                    void handleTextFileImport(event);
                                }}
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="px-3 py-1.5 rounded-md text-sm border border-border bg-background hover:bg-muted/60"
                            >
                                {tFallback(t, 'quickAdd.bulkImportTextFile', 'Import .txt')}
                            </button>
                            <button
                                type="button"
                                onClick={handleClose}
                                className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80"
                            >
                                {t('common.cancel')}
                            </button>
                            {!standaloneWindow && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        void saveTask({ openAfterSave: true });
                                    }}
                                    disabled={saveDisabled}
                                    className={cn(
                                        'px-3 py-1.5 rounded-md text-sm border border-border bg-background hover:bg-muted/60',
                                        saveDisabled && 'opacity-50 cursor-not-allowed hover:bg-background',
                                    )}
                                >
                                    {t('quickAdd.saveAndEdit')}
                                </button>
                            )}
                            <button
                                type="submit"
                                disabled={saveDisabled}
                                className={cn(
                                    'px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90',
                                    saveDisabled && 'opacity-50 cursor-not-allowed hover:bg-primary',
                                )}
                            >
                                {t('common.save')}
                            </button>
                        </div>
                    </form>
                ) : (
                    <div className="p-4 space-y-4">
                        <div className="flex flex-col items-center justify-center gap-3">
                            <button
                                type="button"
                                onClick={() => {
                                    if (recordingBusy) return;
                                    if (isRecording) {
                                        void stopRecording({ saveTask: true });
                                    } else {
                                        void startRecording();
                                    }
                                }}
                                className={cn(
                                    'h-16 w-16 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                                    isRecording ? 'bg-red-500 text-white' : 'bg-primary text-primary-foreground',
                                    recordingBusy ? 'opacity-70 cursor-not-allowed' : 'hover:opacity-90'
                                )}
                                aria-label={audioButtonLabel}
                                disabled={recordingBusy}
                            >
                                {audioButtonLabel}
                            </button>
                            <div className="text-xs text-muted-foreground" aria-live="polite">
                                {audioStatusLabel}
                            </div>
                            {recordingBusy ? (
                                <div className="text-xs text-muted-foreground text-center" aria-live="polite">
                                    {tFallback(t, 'quickAdd.audioSavingSpeechToText', 'Saving the recording and applying speech-to-text.')}
                                </div>
                            ) : null}
                            {recordingError ? (
                                <div className="text-xs text-red-500 text-center">{recordingError}</div>
                            ) : null}
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                type="button"
                                onClick={handleClose}
                                className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80"
                            >
                                {t('common.cancel')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
        {bulkQuickAddLines ? (
            <div
                className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[22vh] z-[60]"
                role="dialog"
                aria-modal="true"
                aria-labelledby="quick-add-bulk-title"
                onClick={() => {
                    setBulkQuickAddLines(null);
                    setBulkQuickAddError(null);
                }}
            >
                <div
                    className="w-full max-w-md rounded-xl border bg-popover p-4 text-popover-foreground shadow-2xl"
                    onClick={(event) => event.stopPropagation()}
                >
                    <h4 id="quick-add-bulk-title" className="text-sm font-semibold">
                        {bulkConfirmTitle}
                    </h4>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {tFallback(t, 'quickAdd.bulkConfirmBody', 'Blank lines will be skipped. Each line uses Quick Add syntax.')}
                    </p>
                    <div className="mt-3 max-h-48 overflow-auto rounded-md border border-border bg-card text-sm">
                        {bulkPreviewLines.map((line, index) => (
                            <div key={`${index}:${line}`} className="border-b border-border px-3 py-2 last:border-b-0">
                                {line}
                            </div>
                        ))}
                        {bulkMoreCount > 0 ? (
                            <div className="px-3 py-2 text-xs text-muted-foreground">
                                {tFallback(t, 'quickAdd.bulkMoreLines', '+{{count}} more')
                                    .replace('{{count}}', String(bulkMoreCount))}
                            </div>
                        ) : null}
                    </div>
                    {bulkQuickAddError ? (
                        <p className="mt-2 text-xs text-destructive">{bulkQuickAddError}</p>
                    ) : null}
                    <div className="mt-4 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setBulkQuickAddLines(null);
                                setBulkQuickAddError(null);
                            }}
                            className="px-3 py-1.5 rounded-md text-sm bg-muted hover:bg-muted/80"
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                void confirmBulkQuickAdd();
                            }}
                            className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                            {tFallback(t, 'quickAdd.bulkConfirmCreate', 'Create tasks')}
                        </button>
                    </div>
                </div>
            </div>
        ) : null}
        </ModalPortal>
    );
}
