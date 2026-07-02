import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  Platform,
  TextInput,
  useWindowDimensions,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

import {
  DEFAULT_AREA_COLOR,
  DEFAULT_PROJECT_COLOR,
  formatFocusTaskLimitText,
  getDefaultTaskAreaMode,
  getQuickAddProjectInitialProps,
  getUsedTaskTokens,
  hasTimeComponent,
  isSelectableProjectForTaskAssignment,
  parseQuickAdd,
  normalizeClockTimeInput,
  normalizeFocusTaskLimit,
  resolveDefaultNewTaskAreaId,
  safeFormatDate,
  safeParseDate,
  shallow,
  splitQuickAddBulkLines,
  tFallback,
  type Task,
  type TaskPriority,
  useTaskStore,
} from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useThemeTokens } from '@/hooks/use-theme-tokens';
import { useToast } from '@/contexts/toast-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAndroidKeyboardInset } from '../lib/use-android-keyboard-inset';
import { logError, logWarn } from '../lib/app-log';
import { openTaskScreen } from '@/lib/task-meta-navigation';
import {
  buildCaptureExtra,
  normalizeContextToken,
  parseContextQueryTokens,
} from './quick-capture-sheet.utils';
import { QuickCaptureSheetBody } from './quick-capture-sheet/QuickCaptureSheetBody';
import { QuickCaptureSheetPickers } from './quick-capture-sheet/QuickCaptureSheetPickers';
import { useQuickCaptureAudio } from './use-quick-capture-audio';
import { useAndroidQuickCaptureExpand } from './quick-capture-sheet/useAndroidQuickCaptureExpand';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ANDROID_OPTIONS_EXPAND_FALLBACK_MS = 500;
const BULK_PREVIEW_LINE_LIMIT = 5;

const logCaptureWarn = (message: string, error?: unknown) => {
  void logWarn(message, { scope: 'capture', extra: buildCaptureExtra(undefined, error) });
};

const logCaptureError = (message: string, error?: unknown) => {
  const err = error instanceof Error ? error : new Error(message);
  void logError(err, { scope: 'capture', extra: buildCaptureExtra(message, error) });
};

const resolveInitialContextTokens = (contexts?: string[]): string[] => (
  Array.from(
    new Set(
      (contexts ?? [])
        .map((item) => normalizeContextToken(String(item || '')))
        .filter(Boolean)
    )
  )
);

const getCreatedTaskId = (result: unknown): string | null => {
  if (!result || typeof result !== 'object') return null;
  const maybeId = (result as { id?: unknown }).id;
  return typeof maybeId === 'string' && maybeId.trim() ? maybeId : null;
};

export function QuickCaptureSheet({
  visible,
  openRequestId,
  onClose,
  initialProps,
  initialValue,
  autoRecord,
}: {
  visible: boolean;
  openRequestId?: number;
  onClose: () => void;
  initialProps?: Partial<Task>;
  initialValue?: string;
  autoRecord?: boolean;
}) {
  const { addTask, addTasks, addProject, addArea, updateSettings, projects, settings, areas, getDerivedState } = useTaskStore((state) => ({
    addTask: state.addTask,
    addTasks: state.addTasks,
    addProject: state.addProject,
    addArea: state.addArea,
    updateSettings: state.updateSettings,
    projects: state.projects,
    settings: state.settings,
    areas: state.areas,
    getDerivedState: state.getDerivedState,
  }), shallow);
  const { t } = useLanguage();
  const tc = useThemeColors();
  const tokens = useThemeTokens();
  // Two-tier M3 emphasis: the capture FAB owns the high-emphasis `primary` role
  // (see tab _layout.tsx); secondary primary actions like Save sit one step below
  // it on the canonical `primaryContainer`, preserving the action hierarchy.
  const saveButtonBackgroundColor = tokens.isMaterial && tokens.roles
    ? tokens.roles.primaryContainer
    : tc.tint;
  const saveButtonTextColor = tokens.isMaterial && tokens.roles
    ? tokens.roles.onPrimaryContainer
    : undefined;
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const inputRef = useRef<TextInput>(null);
  const contextInputRef = useRef<TextInput>(null);
  const isSavingRef = useRef(false);
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const { selectedAreaIdForNewTasks } = useMobileAreaFilter();
  const defaultAreaMode = getDefaultTaskAreaMode(settings);
  const defaultAreaId = defaultAreaMode === 'active'
    ? selectedAreaIdForNewTasks ?? null
    : resolveDefaultNewTaskAreaId(settings, areas) ?? null;

  const updateSpeechSettings = useCallback(
    (next: Partial<NonNullable<NonNullable<typeof settings.ai>['speechToText']>>) => {
      updateSettings({
        ai: {
          ...(settings.ai ?? {}),
          speechToText: {
            ...(settings.ai?.speechToText ?? {}),
            ...next,
          },
        },
      }).catch((error) => logCaptureWarn('Failed to update speech settings', error));
    },
    [settings, updateSettings]
  );

  const [value, setValue] = useState('');
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [dueDateHasTime, setDueDateHasTime] = useState(false);
  const [startTime, setStartTime] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showDueTimePicker, setShowDueTimePicker] = useState(false);
  const [startPickerMode, setStartPickerMode] = useState<'date' | 'time' | null>(null);
  const [pendingStartDate, setPendingStartDate] = useState<Date | null>(null);
  const [contextTags, setContextTags] = useState<string[]>([]);
  const [contextOptions, setContextOptions] = useState<string[]>([]);
  const [contextOptionsLoading, setContextOptionsLoading] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextQuery, setContextQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [areaQuery, setAreaQuery] = useState('');
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [showPriorityPicker, setShowPriorityPicker] = useState(false);
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [androidKeyboardAvoidingEnabled, setAndroidKeyboardAvoidingEnabled] = useState(true);
  const androidKeyboardInset = useAndroidKeyboardInset(visible);
  const [addAnother, setAddAnother] = useState(false);
  const [focusNewTask, setFocusNewTask] = useState(false);
  const projectsRef = useRef(projects);
  const contextOptionsLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextOptionsRequestRef = useRef(0);
  const initialFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const canFocusNewTask = focusNewTask || getDerivedState().focusedCount < focusTaskLimit;
  const focusNewTaskDisabledReason = formatFocusTaskLimitText(
    tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus items'),
    focusTaskLimit,
  );

  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const filteredProjects = useMemo(() => {
    if (!showProjectPicker) return [];
    const visibleProjects = projects.filter(isSelectableProjectForTaskAssignment);
    const areaFilteredProjects = selectedAreaId
      ? visibleProjects.filter((project) => project.areaId === selectedAreaId)
      : visibleProjects;
    const query = projectQuery.trim().toLowerCase();
    if (!query) return areaFilteredProjects;
    return areaFilteredProjects.filter((project) => project.title.toLowerCase().includes(query));
  }, [projectQuery, projects, selectedAreaId, showProjectPicker]);

  const clearContextOptionsLoad = useCallback(() => {
    if (!contextOptionsLoadTimerRef.current) return;
    clearTimeout(contextOptionsLoadTimerRef.current);
    contextOptionsLoadTimerRef.current = null;
  }, []);

  const clearInitialFocusTimer = useCallback(() => {
    if (!initialFocusTimerRef.current) return;
    clearTimeout(initialFocusTimerRef.current);
    initialFocusTimerRef.current = null;
  }, []);

  const {
    clearAndroidOptionsExpand,
    collapseAndroidOptions,
    requestAndroidOptionsExpand,
  } = useAndroidQuickCaptureExpand({
    clearInitialFocusTimer,
    fallbackMs: ANDROID_OPTIONS_EXPAND_FALLBACK_MS,
    inputRef,
    setKeyboardAvoidingEnabled: setAndroidKeyboardAvoidingEnabled,
    setOptionsExpanded,
  });

  const loadContextOptions = useCallback(() => {
    clearContextOptionsLoad();
    const requestId = contextOptionsRequestRef.current + 1;
    contextOptionsRequestRef.current = requestId;
    setContextOptionsLoading(true);
    contextOptionsLoadTimerRef.current = setTimeout(() => {
      contextOptionsLoadTimerRef.current = null;
      try {
        const currentTasks = useTaskStore.getState().tasks;
        const nextOptions = Array.from(
          new Set(
            [...getUsedTaskTokens(currentTasks, (task) => task.contexts, { prefix: '@' }), ...resolveInitialContextTokens(initialProps?.contexts)]
              .map((item) => normalizeContextToken(String(item || '')))
              .filter(Boolean)
          )
        );
        if (contextOptionsRequestRef.current === requestId) {
          setContextOptions(nextOptions);
        }
      } catch (error) {
        logCaptureWarn('Failed to load quick capture context suggestions', error);
      } finally {
        if (contextOptionsRequestRef.current === requestId) {
          setContextOptionsLoading(false);
        }
      }
    }, 0);
  }, [clearContextOptionsLoad, initialProps?.contexts]);

  const queryContextTokens = useMemo(() => parseContextQueryTokens(contextQuery), [contextQuery]);

  const filteredContexts = useMemo(() => {
    const query = queryContextTokens[0]?.toLowerCase() ?? '';
    if (!query) return contextOptions;
    return contextOptions.filter((token) => token.toLowerCase().includes(query));
  }, [contextOptions, queryContextTokens]);

  const hasAddableContextTokens = useMemo(() => {
    if (queryContextTokens.length === 0) return false;
    return queryContextTokens.some(
      (token) => !contextTags.some((selected) => selected.toLowerCase() === token.toLowerCase())
    );
  }, [contextTags, queryContextTokens]);

  const addContextFromQuery = useCallback(() => {
    const pendingTokens = parseContextQueryTokens(contextQuery);
    if (pendingTokens.length === 0) return 0;
    const resolvedTokens = pendingTokens.map((token) =>
      contextOptions.find((item) => item.toLowerCase() === token.toLowerCase()) ?? token
    );
    let addedCount = 0;
    setContextTags((prev) => {
      const next = [...prev];
      for (const token of resolvedTokens) {
        const exists = next.some((item) => item.toLowerCase() === token.toLowerCase());
        if (exists) continue;
        next.push(token);
        addedCount += 1;
      }
      return next;
    });
    setContextQuery('');
    return addedCount;
  }, [contextOptions, contextQuery]);

  const handleContextSubmit = useCallback(() => {
    addContextFromQuery();
    requestAnimationFrame(() => {
      contextInputRef.current?.focus();
    });
  }, [addContextFromQuery]);

  const submitProjectQuery = useCallback(async () => {
    const title = projectQuery.trim();
    if (!title) return;
    const match = projects.find((project) => project.title.toLowerCase() === title.toLowerCase());
    if (match) {
      if (!isSelectableProjectForTaskAssignment(match)) return;
      setProjectId(match.id);
      setSelectedAreaId(null);
      setShowProjectPicker(false);
      setProjectQuery('');
      Keyboard.dismiss();
      return;
    }
    const created = await addProject(
      title,
      DEFAULT_PROJECT_COLOR,
      getQuickAddProjectInitialProps({}, selectedAreaId)
    );
    if (!created) return;
    setProjectId(created.id);
    setSelectedAreaId(null);
    setShowProjectPicker(false);
    setProjectQuery('');
    Keyboard.dismiss();
  }, [addProject, projectQuery, projects, selectedAreaId]);

  const submitAreaQuery = useCallback(async () => {
    const name = areaQuery.trim();
    if (!name) return;
    const match = areas.find((area) => !area.deletedAt && area.name.trim().toLowerCase() === name.toLowerCase());
    if (match) {
      setSelectedAreaId(match.id);
      setProjectId(null);
      setShowAreaPicker(false);
      setAreaQuery('');
      Keyboard.dismiss();
      return;
    }
    const created = await addArea(name, { color: DEFAULT_AREA_COLOR });
    if (!created) return;
    setSelectedAreaId(created.id);
    setProjectId(null);
    setShowAreaPicker(false);
    setAreaQuery('');
    Keyboard.dismiss();
  }, [addArea, areaQuery, areas]);

  const hasExactProjectMatch = useMemo(() => {
    if (!showProjectPicker) return false;
    if (!projectQuery.trim()) return false;
    const query = projectQuery.trim().toLowerCase();
    return projects.some((project) => project.title.toLowerCase() === query);
  }, [projectQuery, projects, showProjectPicker]);

  const hasExactAreaMatch = useMemo(() => {
    if (!showAreaPicker) return false;
    const query = areaQuery.trim().toLowerCase();
    if (!query) return false;
    return areas.some((area) => !area.deletedAt && area.name.trim().toLowerCase() === query);
  }, [areaQuery, areas, showAreaPicker]);

  const resetDraftState = useCallback((options?: { keepAddAnother?: boolean; value?: string }) => {
    clearAndroidOptionsExpand();
    setValue(options?.value ?? initialValue ?? '');
    setDueDate(initialProps?.dueDate ? safeParseDate(initialProps.dueDate) : null);
    setDueDateHasTime(Boolean(initialProps?.dueDate && hasTimeComponent(initialProps.dueDate)));
    setStartTime(initialProps?.startTime ? safeParseDate(initialProps.startTime) : null);
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    const initialContextTokens = resolveInitialContextTokens(initialProps?.contexts);
    setContextTags(initialContextTokens);
    setContextOptions(initialContextTokens);
    setContextOptionsLoading(false);
    setContextQuery('');
    setShowContextPicker(false);
    const currentProjects = projectsRef.current;
    const initialProjectId = initialProps?.projectId && currentProjects.some((project) => (
      project.id === initialProps.projectId && isSelectableProjectForTaskAssignment(project)
    ))
      ? initialProps.projectId
      : null;
    setProjectId(initialProjectId);
    setSelectedAreaId(initialProjectId ? null : (initialProps?.areaId ?? defaultAreaId));
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setAreaQuery('');
    setPriority((initialProps?.priority as TaskPriority) ?? null);
    setShowPriorityPicker(false);
    setOptionsExpanded(false);
    setAndroidKeyboardAvoidingEnabled(true);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
    setStartPickerMode(null);
    setPendingStartDate(null);
    setFocusNewTask(Boolean(initialProps?.isFocusedToday));
    setAddAnother(Boolean(options?.keepAddAnother));
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, defaultAreaId, initialProps, initialValue]);

  useEffect(() => () => {
    clearAndroidOptionsExpand();
    clearInitialFocusTimer();
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, clearInitialFocusTimer]);

  useEffect(() => {
    if (!visible) return;
    resetDraftState();
    if (autoRecord) return;
    clearInitialFocusTimer();
    initialFocusTimerRef.current = setTimeout(() => {
      initialFocusTimerRef.current = null;
      inputRef.current?.focus();
    }, 120);
    return clearInitialFocusTimer;
  }, [autoRecord, clearInitialFocusTimer, openRequestId, resetDraftState, visible]);

  useEffect(() => {
    if (prioritiesEnabled) return;
    setPriority(null);
    setShowPriorityPicker(false);
  }, [prioritiesEnabled]);

  const buildTaskPropsForInput = useCallback(async (inputValue: string, fallbackTitle: string, extraProps?: Partial<Task>) => {
    const trimmed = inputValue.trim();
    let finalTitle = trimmed || fallbackTitle;
    let projectTitle: string | undefined;
    let parsedProps: Partial<Task> = {};
    let invalidDateCommands: string[] | undefined;
    let detectedDate:
      | {
          date: string;
          matchedText: string;
          titleWithoutDate: string;
        }
      | undefined;

    if (trimmed) {
      const parsed = parseQuickAdd(trimmed, projects, new Date(), areas, {
        defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || undefined,
        preserveText: settings.quickAddAutoClean !== true,
      });
      finalTitle = parsed.title || trimmed;
      parsedProps = parsed.props;
      if (
        parsedProps.projectId
        && !projects.some((project) => project.id === parsedProps.projectId && isSelectableProjectForTaskAssignment(project))
      ) {
        delete parsedProps.projectId;
      }
      projectTitle = parsed.projectTitle;
      invalidDateCommands = parsed.invalidDateCommands;
      detectedDate = parsed.detectedDate;
    }

    const initialPropsMerged: Partial<Task> = { status: 'inbox', ...initialProps, ...parsedProps, ...extraProps };
    if (
      initialPropsMerged.projectId
      && !projects.some((project) => project.id === initialPropsMerged.projectId && isSelectableProjectForTaskAssignment(project))
    ) {
      delete initialPropsMerged.projectId;
    }
    if (!initialPropsMerged.status) initialPropsMerged.status = 'inbox';
    const shouldApplyDetectedDate = Boolean(detectedDate?.date && !initialPropsMerged.dueDate && !dueDate);
    if (shouldApplyDetectedDate && detectedDate) {
      initialPropsMerged.dueDate = detectedDate.date;
      finalTitle = detectedDate.titleWithoutDate;
    }

    if (!initialPropsMerged.projectId && projectTitle) {
      const existingProject = projects.find((project) => project.title.toLowerCase() === projectTitle.toLowerCase());
      if (existingProject && !isSelectableProjectForTaskAssignment(existingProject)) {
        return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
      }
      const created = await addProject(
        projectTitle,
        DEFAULT_PROJECT_COLOR,
        getQuickAddProjectInitialProps(initialPropsMerged, selectedAreaId)
      );
      if (!created) return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
      initialPropsMerged.projectId = created.id;
    }

    if (projectId) initialPropsMerged.projectId = projectId;
    if (!initialPropsMerged.projectId && !parsedProps.areaId) {
      initialPropsMerged.areaId = selectedAreaId || undefined;
    }
    if (initialPropsMerged.projectId) initialPropsMerged.areaId = undefined;
    if (contextTags.length > 0) {
      initialPropsMerged.contexts = Array.from(new Set([...(initialPropsMerged.contexts ?? []), ...contextTags]));
    }
    if (prioritiesEnabled && priority) initialPropsMerged.priority = priority;
    if (dueDate) {
      const dateOnly = safeFormatDate(dueDate, 'yyyy-MM-dd');
      if (dateOnly) initialPropsMerged.dueDate = dueDateHasTime ? dueDate.toISOString() : dateOnly;
    }
    if (startTime) initialPropsMerged.startTime = startTime.toISOString();
    if (focusNewTask && canFocusNewTask) initialPropsMerged.isFocusedToday = true;

    return { title: finalTitle, props: initialPropsMerged, invalidDateCommands };
  }, [addProject, areas, canFocusNewTask, contextTags, dueDate, dueDateHasTime, focusNewTask, initialProps, prioritiesEnabled, priority, projectId, projects, selectedAreaId, settings.gtd?.defaultScheduleTime, settings.quickAddAutoClean, startTime]);

  const buildTaskProps = useCallback((fallbackTitle: string, extraProps?: Partial<Task>) => (
    buildTaskPropsForInput(value, fallbackTitle, extraProps)
  ), [buildTaskPropsForInput, value]);

  const resetState = useCallback(() => {
    clearAndroidOptionsExpand();
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setValue('');
    setDueDate(null);
    setDueDateHasTime(false);
    setStartTime(null);
    setContextTags([]);
    setContextOptions([]);
    setContextOptionsLoading(false);
    setContextQuery('');
    setShowContextPicker(false);
    setProjectId(null);
    setSelectedAreaId(defaultAreaId);
    setPriority(null);
    setProjectQuery('');
    setShowProjectPicker(false);
    setShowAreaPicker(false);
    setAreaQuery('');
    setShowPriorityPicker(false);
    setOptionsExpanded(false);
    setAndroidKeyboardAvoidingEnabled(true);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
    setStartPickerMode(null);
    setPendingStartDate(null);
    setAddAnother(false);
    setFocusNewTask(false);
  }, [clearAndroidOptionsExpand, clearContextOptionsLoad, defaultAreaId]);

  const finalizeClose = useCallback(() => {
    clearInitialFocusTimer();
    resetState();
    onClose();
  }, [clearInitialFocusTimer, onClose, resetState]);

  const {
    recording,
    recordingBusy,
    recordingReady,
    startRecording,
    stopRecording,
  } = useQuickCaptureAudio({
    addTask,
    autoRecord,
    buildTaskProps,
    handleClose: finalizeClose,
    initialAttachments: initialProps?.attachments,
    onError: logCaptureError,
    onWarn: logCaptureWarn,
    settings,
    t,
    updateSpeechSettings,
    visible,
  });

  const handleClose = useCallback(() => {
    if (recording && !recordingBusy) {
      void stopRecording({ saveTask: false });
    }
    finalizeClose();
  }, [finalizeClose, recording, recordingBusy, stopRecording]);

  const formatBulkConfirmTitle = useCallback((count: number) => (
    tFallback(t, 'quickAdd.bulkConfirmTitle', 'Create {{count}} tasks?')
      .replace('{{count}}', String(count))
  ), [t]);

  const formatBulkConfirmMessage = useCallback((lines: string[]) => {
    const preview = lines.slice(0, BULK_PREVIEW_LINE_LIMIT).join('\n');
    const remaining = Math.max(0, lines.length - BULK_PREVIEW_LINE_LIMIT);
    const suffix = remaining > 0
      ? `\n${tFallback(t, 'quickAdd.bulkMoreLines', '+{{count}} more').replace('{{count}}', String(remaining))}`
      : '';
    return `${preview}${suffix}`;
  }, [t]);

  const createTaskFromInput = useCallback(async (inputValue: string) => {
    const { title, props, invalidDateCommands } = await buildTaskPropsForInput(inputValue, inputValue.trim());
    if (invalidDateCommands && invalidDateCommands.length > 0) {
      showToast({
        title: t('common.notice'),
        message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
        tone: 'warning',
        durationMs: 4200,
      });
      return null;
    }
    if (!title.trim()) return null;

    const addTaskResult = await addTask(title, props);
    if (addTaskResult && typeof addTaskResult === 'object' && addTaskResult.success === false) return null;
    return {
      createdTaskId: getCreatedTaskId(addTaskResult),
      props,
    };
  }, [addTask, buildTaskPropsForInput, showToast, t]);

  const createBulkTasks = useCallback(async (lines: string[]) => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    try {
      const taskInputs: Array<{ title: string; initialProps: Partial<Task> }> = [];
      for (const line of lines) {
        const { title, props, invalidDateCommands } = await buildTaskPropsForInput(line, line.trim());
        if (invalidDateCommands && invalidDateCommands.length > 0) {
          showToast({
            title: t('common.notice'),
            message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
            tone: 'warning',
            durationMs: 4200,
          });
          return;
        }
        if (!title.trim()) return;
        taskInputs.push({ title, initialProps: props });
      }
      const result = await addTasks(taskInputs);
      if (result && typeof result === 'object' && result.success === false) return;
      finalizeClose();
    } finally {
      isSavingRef.current = false;
    }
  }, [addTasks, buildTaskPropsForInput, finalizeClose, showToast, t]);

  const confirmBulkQuickAdd = useCallback((lines: string[]) => {
    Alert.alert(
      formatBulkConfirmTitle(lines.length),
      formatBulkConfirmMessage(lines),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: tFallback(t, 'quickAdd.bulkConfirmCreate', 'Create tasks'),
          onPress: () => {
            void createBulkTasks(lines);
          },
        },
      ],
    );
  }, [createBulkTasks, formatBulkConfirmMessage, formatBulkConfirmTitle, t]);

  const handleSave = useCallback(async ({ openAfterSave = false }: { openAfterSave?: boolean } = {}) => {
    if (!value.trim()) return;
    const bulkLines = splitQuickAddBulkLines(value);
    if (bulkLines.length > 1) {
      confirmBulkQuickAdd(bulkLines);
      return;
    }
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    try {
      const result = await createTaskFromInput(value.trim());
      if (!result) return;

      if (openAfterSave) {
        finalizeClose();
        if (result.createdTaskId) {
          openTaskScreen(result.createdTaskId, result.props.projectId, 'task');
        }
        return;
      }

      if (addAnother) {
        resetDraftState({ keepAddAnother: true, value: '' });
        setTimeout(() => inputRef.current?.focus(), 80);
        return;
      }

      finalizeClose();
    } finally {
      isSavingRef.current = false;
    }
  }, [addAnother, confirmBulkQuickAdd, createTaskFromInput, finalizeClose, resetDraftState, value]);

  const selectedProject = projectId ? projects.find((project) => project.id === projectId) : null;
  const dueLabel = dueDate ? safeFormatDate(dueDate, dueDateHasTime ? 'Pp' : 'P') : t('taskEdit.dueDateLabel');
  const dueTimeLabel = dueDate && dueDateHasTime ? safeFormatDate(dueDate, 'p') : t('calendar.changeTime');
  const contextLabel = contextTags.length === 0
    ? t('taskEdit.contextsLabel')
    : `${contextTags[0].replace(/^@+/, '')}${contextTags.length > 1 ? ` +${contextTags.length - 1}` : ''}`;
  const projectLabel = selectedProject ? selectedProject.title : t('taskEdit.projectLabel');
  const areaLabel = selectedAreaId
    ? areas.find((area) => area.id === selectedAreaId)?.name || t('taskEdit.noAreaOption')
    : t('taskEdit.noAreaOption');
  const priorityLabel = priority ? t(`priority.${priority}`) : t('taskEdit.priorityLabel');
  const sheetMaxHeight = Math.max(260, windowHeight - Math.max(insets.top, 12) - 8);

  const openDueDatePicker = useCallback(() => {
    inputRef.current?.blur();
    Keyboard.dismiss();
    setShowDueTimePicker(false);
    if (Platform.OS === 'ios') {
      setTimeout(() => setShowDatePicker(true), 120);
      return;
    }
    setShowDatePicker(true);
  }, []);

  const openDueTimePicker = useCallback(() => {
    if (!dueDate) return;
    inputRef.current?.blur();
    Keyboard.dismiss();
    setShowDatePicker(false);
    if (Platform.OS === 'ios') {
      setTimeout(() => setShowDueTimePicker(true), 120);
      return;
    }
    setShowDueTimePicker(true);
  }, [dueDate]);

  const handleDueDateChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowDatePicker(false);
      return;
    }
    if (Platform.OS !== 'ios') {
      setShowDatePicker(false);
    }
    if (selectedDate) {
      const next = new Date(selectedDate);
      if (dueDateHasTime && dueDate) {
        next.setHours(dueDate.getHours(), dueDate.getMinutes(), 0, 0);
      } else {
        next.setHours(0, 0, 0, 0);
      }
      setDueDate(next);
    }
  }, [dueDate, dueDateHasTime]);

  const handleDueTimeChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setShowDueTimePicker(false);
      return;
    }
    if (!selectedDate) return;
    if (Platform.OS !== 'ios') {
      setShowDueTimePicker(false);
    }
    const base = dueDate ?? new Date();
    const combined = new Date(base);
    combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
    setDueDate(combined);
    setDueDateHasTime(true);
  }, [dueDate]);

  const resetDueDate = useCallback(() => {
    setDueDate(null);
    setDueDateHasTime(false);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
  }, []);

  const resetDueTime = useCallback(() => {
    setDueDateHasTime(false);
    setShowDueTimePicker(false);
    setDueDate((prev) => {
      if (!prev) return prev;
      const next = new Date(prev);
      next.setHours(0, 0, 0, 0);
      return next;
    });
  }, []);

  const handleQuickDueDateSelect = useCallback((date: Date | null) => {
    if (!date) {
      resetDueDate();
      return;
    }
    const next = new Date(date);
    if (dueDateHasTime && dueDate) {
      next.setHours(dueDate.getHours(), dueDate.getMinutes(), 0, 0);
    } else {
      next.setHours(0, 0, 0, 0);
    }
    setDueDate(next);
    setShowDatePicker(false);
    setShowDueTimePicker(false);
  }, [dueDate, dueDateHasTime, resetDueDate]);

  const handleStartTimeChange = useCallback((event: { type: string }, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setStartPickerMode(null);
      setPendingStartDate(null);
      return;
    }
    if (!selectedDate) return;
    if (Platform.OS === 'ios') {
      setStartTime(selectedDate);
      return;
    }
    if (startPickerMode === 'date') {
      const base = new Date(selectedDate);
      const existing = startTime ?? pendingStartDate;
      if (existing) {
        base.setHours(existing.getHours(), existing.getMinutes(), 0, 0);
      }
      setPendingStartDate(base);
      setStartPickerMode('time');
      return;
    }
    const base = pendingStartDate ?? startTime ?? new Date();
    const combined = new Date(base);
    combined.setHours(selectedDate.getHours(), selectedDate.getMinutes(), 0, 0);
    setStartTime(combined);
    setPendingStartDate(null);
    setStartPickerMode(null);
  }, [pendingStartDate, startPickerMode, startTime]);

  const handleToggleContext = useCallback((token: string) => {
    setContextTags((prev) => {
      const exists = prev.some((item) => item.toLowerCase() === token.toLowerCase());
      if (exists) {
        return prev.filter((item) => item.toLowerCase() !== token.toLowerCase());
      }
      return [...prev, token];
    });
    setContextQuery('');
  }, []);

  const handleRemoveContext = useCallback((token: string) => {
    setContextTags((prev) => prev.filter((item) => item.toLowerCase() !== token.toLowerCase()));
  }, []);

  const handleClearContexts = useCallback(() => {
    setContextTags([]);
    setContextQuery('');
  }, []);

  const handleSelectArea = useCallback((areaId: string | null) => {
    setSelectedAreaId(areaId);
    if (areaId) {
      setProjectId(null);
    }
    setShowAreaPicker(false);
    setAreaQuery('');
  }, []);

  const handleSelectProject = useCallback((nextProjectId: string | null) => {
    setProjectId(nextProjectId);
    if (nextProjectId) {
      setSelectedAreaId(null);
    }
    setShowProjectPicker(false);
  }, []);

  const handleSelectPriority = useCallback((nextPriority: TaskPriority | null) => {
    setPriority(nextPriority);
    setShowPriorityPicker(false);
  }, []);

  const handleToggleRecording = useCallback(() => {
    if (recording) {
      void stopRecording({ saveTask: true });
      return;
    }
    void startRecording();
  }, [recording, startRecording, stopRecording]);

  const handleToggleOptions = useCallback(() => {
    clearAndroidOptionsExpand();
    if (!optionsExpanded) {
      clearInitialFocusTimer();
      if (Platform.OS === 'android') {
        requestAndroidOptionsExpand();
        return;
      }
      inputRef.current?.blur();
      Keyboard.dismiss();
    } else if (Platform.OS === 'android') {
      collapseAndroidOptions();
      return;
    }
    setOptionsExpanded((prev) => !prev);
  }, [clearAndroidOptionsExpand, clearInitialFocusTimer, collapseAndroidOptions, optionsExpanded, requestAndroidOptionsExpand]);

  const openContextPicker = useCallback(() => {
    setShowContextPicker(true);
    loadContextOptions();
  }, [loadContextOptions]);

  const closeContextPicker = useCallback(() => {
    setShowContextPicker(false);
    clearContextOptionsLoad();
    contextOptionsRequestRef.current += 1;
    setContextOptionsLoading(false);
  }, [clearContextOptionsLoad]);

  const handleImportTextFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: 'text/plain',
      });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.uri) return;
      const text = await FileSystem.readAsStringAsync(asset.uri);
      const lines = splitQuickAddBulkLines(text);
      if (lines.length > 1) {
        confirmBulkQuickAdd(lines);
      } else if (lines.length === 1) {
        setValue(lines[0]);
      }
    } catch (error) {
      logCaptureError('Failed to import quick capture text file', error);
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'quickAdd.bulkImportError', 'Could not read that text file.'),
        tone: 'warning',
        durationMs: 4200,
      });
    }
  }, [confirmBulkQuickAdd, showToast, t]);

  const pickerProps = {
    areas,
    areaQuery,
    contextInputRef,
    contextOptionsLoading,
    contextQuery,
    contextTags,
    dueDate,
    filteredContexts,
    filteredProjects,
    hasAddableContextTokens,
    hasExactAreaMatch,
    hasExactProjectMatch,
    onAddContextFromQuery: addContextFromQuery,
    onAreaQueryChange: setAreaQuery,
    onClearContexts: handleClearContexts,
    onCloseAreaPicker: () => {
      setShowAreaPicker(false);
      setAreaQuery('');
    },
    onCloseContextPicker: closeContextPicker,
    onClosePriorityPicker: () => setShowPriorityPicker(false),
    onCloseProjectPicker: () => setShowProjectPicker(false),
    onContextQueryChange: setContextQuery,
    onDueDateChange: handleDueDateChange,
    onDueTimeChange: handleDueTimeChange,
    onProjectQueryChange: setProjectQuery,
    onRemoveContext: handleRemoveContext,
    onSelectArea: handleSelectArea,
    onSelectContext: handleToggleContext,
    onSelectPriority: handleSelectPriority,
    onSelectProject: handleSelectProject,
    onStartTimeChange: handleStartTimeChange,
    onSubmitContextQuery: handleContextSubmit,
    onSubmitAreaQuery: () => {
      void submitAreaQuery();
    },
    onSubmitProjectQuery: () => {
      void submitProjectQuery();
    },
    pendingStartDate,
    prioritiesEnabled,
    priorityOptions: PRIORITY_OPTIONS,
    projectQuery,
    selectedAreaId,
    selectedPriority: priority,
    showAreaPicker,
    showContextPicker,
    showDatePicker,
    showDueTimePicker,
    showPriorityPicker,
    showProjectPicker,
    startPickerMode,
    startTime,
    t,
    tc,
  };

  return (
    <>
      <QuickCaptureSheetBody
        addAnother={addAnother}
        areaLabel={areaLabel}
        contextLabel={contextLabel}
        dueDate={dueDate}
        dueLabel={dueLabel}
        dueTimeLabel={dueTimeLabel}
        handleClose={handleClose}
        handleImportTextFile={handleImportTextFile}
        handleSave={() => {
          void handleSave();
        }}
        focusNewTask={focusNewTask}
        canFocusNewTask={canFocusNewTask}
        focusNewTaskDisabledReason={focusNewTaskDisabledReason}
        handleSaveAndEdit={() => {
          void handleSave({ openAfterSave: true });
        }}
        insetsBottom={insets.bottom}
        inputRef={inputRef}
        keyboardAvoidingEnabled={androidKeyboardAvoidingEnabled}
        androidKeyboardInset={androidKeyboardInset}
        onOpenAreaPicker={() => setShowAreaPicker(true)}
        onOpenContextPicker={openContextPicker}
        onOpenDueDatePicker={openDueDatePicker}
        onOpenDueTimePicker={openDueTimePicker}
        onOpenPriorityPicker={() => setShowPriorityPicker(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onQuickDueDateSelect={handleQuickDueDateSelect}
        onResetArea={() => setSelectedAreaId(null)}
        onResetContexts={handleClearContexts}
        onResetDueDate={resetDueDate}
        onResetDueTime={resetDueTime}
        onResetPriority={() => setPriority(null)}
        onResetProject={() => {
          setProjectId(null);
          setSelectedAreaId(defaultAreaId);
        }}
        onToggleOptions={handleToggleOptions}
        onToggleAddAnother={setAddAnother}
        onToggleFocusNewTask={() => {
          if (!focusNewTask && !canFocusNewTask) {
            // Keep the hard focus cap, but explain the block instead of silently
            // swallowing the tap (mirrors the task-list focus toggle).
            showToast({
              title: tFallback(t, 'digest.focus', 'Focus'),
              message: focusNewTaskDisabledReason,
              tone: 'warning',
            });
            return;
          }
          setFocusNewTask((current) => !current);
        }}
        onToggleRecording={handleToggleRecording}
        onValueChange={setValue}
        optionsExpanded={optionsExpanded}
        prioritiesEnabled={prioritiesEnabled}
        priorityLabel={priorityLabel}
        projectLabel={projectLabel}
        projectSelected={Boolean(selectedProject)}
        recording={Boolean(recording)}
        recordingBusy={recordingBusy}
        recordingReady={recordingReady}
        saveButtonBackgroundColor={saveButtonBackgroundColor}
        saveButtonTextColor={saveButtonTextColor}
        sheetMaxHeight={sheetMaxHeight}
        showDueTime={Boolean(dueDate)}
        t={t}
        tc={tc}
        value={value}
        visible={visible}
      >
        <QuickCaptureSheetPickers {...pickerProps} pickerLayer="overlay" overlayKeyboardInset={androidKeyboardInset} />
      </QuickCaptureSheetBody>
      <QuickCaptureSheetPickers {...pickerProps} pickerLayer="date" />
    </>
  );
}
