import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  createAIProvider,
  DEFAULT_PROJECT_COLOR,
  getQuickAddProjectInitialProps,
  getUsedTaskTokens,
  isSelectableProjectForTaskAssignment,
  parseQuickAdd,
  normalizeClockTimeInput,
  resolveDefaultNewTaskAreaId,
  shallow,
  splitQuickAddBulkLines,
  tFallback,
  type AIProviderId,
  type Project,
  type Task,
  type TimeEstimate,
  useTaskStore,
} from '@mindwtr/core';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { useLanguage } from '../contexts/language-context';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError } from '../lib/app-log';
import { openTaskScreen } from '@/lib/task-meta-navigation';

type CaptureSearchParams = {
  initialProps?: string;
  initialValue?: string;
  project?: string;
  returnTo?: string;
  text?: string;
  title?: string;
};

const URL_INITIAL_TASK_STATUSES = new Set<Task['status']>(['inbox', 'next', 'waiting', 'someday', 'reference']);
const BULK_PREVIEW_LINE_LIMIT = 5;

const firstSearchParam = (value: string | string[] | undefined): string => {
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
};

const decodeSearchParam = (value: string | string[] | undefined): string => {
  const raw = firstSearchParam(value);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const sanitizeCaptureReturnToParam = (value: string | string[] | undefined): string | null => {
  const decoded = decodeSearchParam(value).trim();
  if (!decoded || !decoded.startsWith('/') || decoded.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  if (/[\u0000-\u001F\u007F]/.test(decoded)) return null;
  return decoded;
};

const getCreatedTaskId = (result: unknown): string | null => {
  if (!result || typeof result !== 'object') return null;
  const maybeId = (result as { id?: unknown }).id;
  return typeof maybeId === 'string' && maybeId.trim() ? maybeId : null;
};

const parseInitialPropsJson = (value: string | string[] | undefined): Record<string, unknown> => {
  const decoded = decodeSearchParam(value);
  if (!decoded) return {};
  try {
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const normalizeInitialTokenList = (value: unknown, prefix?: '@' | '#'): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const next: string[] = [];
  value.forEach((item) => {
    if (typeof item !== 'string') return;
    const trimmed = item.trim();
    if (!trimmed) return;
    const normalized = prefix && !trimmed.startsWith(prefix) ? `${prefix}${trimmed}` : trimmed;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    next.push(normalized);
  });
  return next.length > 0 ? next : undefined;
};

const sanitizeInitialPropsParam = (
  value: string | string[] | undefined,
  projects: Project[],
  areas: Array<{ id: string; deletedAt?: string | null }>,
): Partial<Task> => {
  const parsed = parseInitialPropsJson(value);
  const next: Partial<Task> = {};

  if (typeof parsed.description === 'string' && parsed.description.trim()) {
    next.description = parsed.description;
  }

  const tags = normalizeInitialTokenList(parsed.tags, '#');
  if (tags) next.tags = tags;

  const contexts = normalizeInitialTokenList(parsed.contexts, '@');
  if (contexts) next.contexts = contexts;

  const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : '';
  if (URL_INITIAL_TASK_STATUSES.has(status as Task['status'])) {
    next.status = status as Task['status'];
  }

  const projectId = typeof parsed.projectId === 'string' ? parsed.projectId.trim() : '';
  if (projectId && projects.some((project) => project.id === projectId && isSelectableProjectForTaskAssignment(project))) {
    next.projectId = projectId;
  }

  const areaId = typeof parsed.areaId === 'string' ? parsed.areaId.trim() : '';
  if (!next.projectId && areaId && areas.some((area) => area.id === areaId && !area.deletedAt)) {
    next.areaId = areaId;
  }

  return next;
};

export default function CaptureScreen() {
  const params = useLocalSearchParams<CaptureSearchParams>();
  const router = useRouter();
  const { addProject, addTask, addTasks, projects, tasks, settings, areas } = useTaskStore((state) => ({
    addProject: state.addProject,
    addTask: state.addTask,
    addTasks: state.addTasks,
    projects: state.projects,
    tasks: state.tasks,
    settings: state.settings,
    areas: state.areas,
  }), shallow);
  const tc = useThemeColors();
  const { showToast } = useToast();
  const { t } = useLanguage();
  const initialText = (
    decodeSearchParam(params.initialValue)
    || decodeSearchParam(params.text)
    || decodeSearchParam(params.title)
  );
  const initialProps = React.useMemo(
    () => sanitizeInitialPropsParam(params.initialProps, projects, areas),
    [areas, params.initialProps, projects]
  );
  const defaultNewTaskAreaId = resolveDefaultNewTaskAreaId(settings, areas);
  const returnTo = React.useMemo(
    () => sanitizeCaptureReturnToParam(params.returnTo),
    [params.returnTo]
  );
  const initialDescription = String(initialProps.description ?? '');
  const initialProjectTitle = decodeSearchParam(params.project).trim();
  const [value, setValue] = useState(initialText);
  const [descriptionValue, setDescriptionValue] = useState(initialDescription);
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null>(null);
  const [copilotApplied, setCopilotApplied] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotEstimate, setCopilotEstimate] = useState<TimeEstimate | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const copilotMountedRef = useRef(true);
  const copilotAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 120);
  }, []);

  useEffect(() => {
    setValue(initialText);
    setDescriptionValue(initialDescription);
  }, [initialDescription, initialText]);

  useEffect(() => {
    const showListener = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hideListener = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    return () => {
      showListener.remove();
      hideListener.remove();
    };
  }, []);

  const aiEnabled = settings.ai?.enabled === true;
  const aiProvider = (settings.ai?.provider ?? 'openai') as AIProviderId;
  const keyRequired = isAIKeyRequired(settings);
  const timeEstimatesEnabled = settings.features?.timeEstimates !== false;

  useEffect(() => {
    loadAIKey(aiProvider).then(setAiKey).catch((error) => {
      void logError(error, { scope: 'ai', extra: { message: 'Failed to load AI key' } });
      showToast({
        title: t('ai.errorTitle'),
        message: t('ai.disabledBody'),
        tone: 'warning',
        durationMs: 4200,
      });
    });
  }, [aiProvider, showToast, t]);

  const contextOptions = React.useMemo(() => {
    return getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' });
  }, [tasks]);
  const tagOptions = React.useMemo(() => {
    return getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' });
  }, [tasks]);
  const quickAddParseOptions = React.useMemo(
    () => ({
      knownContexts: contextOptions,
      knownTags: tagOptions,
      defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || undefined,
      preserveText: settings.quickAddAutoClean !== true,
    }),
    [contextOptions, tagOptions, settings.gtd?.defaultScheduleTime, settings.quickAddAutoClean]
  );

  useEffect(() => {
    if (!aiEnabled || (keyRequired && !aiKey)) {
      setCopilotSuggestion(null);
      return;
    }
    const title = value.trim();
    if (title.length < 4) {
      setCopilotSuggestion(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        if (copilotAbortRef.current) copilotAbortRef.current.abort();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        copilotAbortRef.current = abortController;
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
        const suggestion = await provider.predictMetadata(
          { title, contexts: contextOptions, tags: tagOptions },
          abortController ? { signal: abortController.signal } : undefined
        );
        if (cancelled || !copilotMountedRef.current) return;
        if (!suggestion.context && (!timeEstimatesEnabled || !suggestion.timeEstimate) && !suggestion.tags?.length) {
          setCopilotSuggestion(null);
        } else {
          setCopilotSuggestion(suggestion);
        }
      } catch {
        if (!cancelled) {
          setCopilotSuggestion(null);
        }
      } finally {
        if (cancelled) return;
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      if (copilotAbortRef.current) {
        copilotAbortRef.current.abort();
        copilotAbortRef.current = null;
      }
    };
  }, [
    aiEnabled,
    aiKey,
    aiProvider,
    contextOptions,
    keyRequired,
    settings,
    settings.ai?.copilotModel,
    settings.ai?.thinkingBudget,
    tagOptions,
    timeEstimatesEnabled,
    value,
  ]);

  useEffect(() => {
    copilotMountedRef.current = true;
    return () => {
      copilotMountedRef.current = false;
      if (copilotAbortRef.current) {
        copilotAbortRef.current.abort();
        copilotAbortRef.current = null;
      }
    };
  }, []);

  const handleInputChange = (text: string) => {
    setValue(text);
    setCopilotApplied(false);
    setCopilotContext(undefined);
    setCopilotEstimate(undefined);
    setCopilotTags([]);
  };

  const placeholderColor = tc.secondaryText;

  const closeCapture = React.useCallback(() => {
    if (returnTo) {
      router.replace(returnTo as never);
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/inbox');
    }
  }, [returnTo, router]);

  const handleCancel = () => {
    closeCapture();
  };

  const formatBulkConfirmTitle = (count: number) => (
    tFallback(t, 'quickAdd.bulkConfirmTitle', 'Create {{count}} tasks?')
      .replace('{{count}}', String(count))
  );

  const formatBulkConfirmMessage = (lines: string[]) => {
    const preview = lines.slice(0, BULK_PREVIEW_LINE_LIMIT).join('\n');
    const remaining = Math.max(0, lines.length - BULK_PREVIEW_LINE_LIMIT);
    const suffix = remaining > 0
      ? `\n${tFallback(t, 'quickAdd.bulkMoreLines', '+{{count}} more').replace('{{count}}', String(remaining))}`
      : '';
    return `${preview}${suffix}`;
  };

  const buildTaskInputFromInput = async (inputValue: string): Promise<{ title: string; initialProps: Partial<Task> } | null> => {
    if (!inputValue.trim()) return null;
    const { title, props, projectTitle, invalidDateCommands, detectedDate } = parseQuickAdd(
      inputValue,
      projects,
      new Date(),
      areas,
      quickAddParseOptions
    );
    if (
      props.projectId
      && !projects.some((project) => project.id === props.projectId && isSelectableProjectForTaskAssignment(project))
    ) {
      delete props.projectId;
    }
    if (invalidDateCommands && invalidDateCommands.length > 0) {
      showToast({
        title: t('common.notice'),
        message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
        tone: 'warning',
        durationMs: 4200,
      });
      return null;
    }
    const shouldApplyDetectedDate = Boolean(detectedDate?.date && !props.dueDate);
    const finalTitle = shouldApplyDetectedDate && detectedDate ? detectedDate.titleWithoutDate : (title || inputValue);
    if (!finalTitle.trim()) return null;
    const taskProps: Partial<Task> = { status: 'inbox', ...initialProps, ...props };
    if (!taskProps.status) taskProps.status = 'inbox';
    if (shouldApplyDetectedDate && detectedDate) {
      taskProps.dueDate = detectedDate.date;
    }
    const requestedProjectTitle = !taskProps.projectId ? (projectTitle || initialProjectTitle) : '';
    if (requestedProjectTitle) {
      const inactiveProject = projects.find((project) => (
        (
          project.id === requestedProjectTitle
          || project.title.toLowerCase() === requestedProjectTitle.toLowerCase()
        )
        && !isSelectableProjectForTaskAssignment(project)
      ));
      if (inactiveProject) {
        taskProps.projectId = undefined;
      } else {
        const matchedProject = projects.find((project) => (
          isSelectableProjectForTaskAssignment(project)
          && (
            project.id === requestedProjectTitle
            || project.title.toLowerCase() === requestedProjectTitle.toLowerCase()
          )
        ));
        if (matchedProject) {
          taskProps.projectId = matchedProject.id;
        } else {
          const created = await addProject(
            requestedProjectTitle,
            DEFAULT_PROJECT_COLOR,
            getQuickAddProjectInitialProps(taskProps, defaultNewTaskAreaId),
          );
          if (!created) return null;
          taskProps.projectId = created.id;
        }
      }
    }
    if (taskProps.projectId) {
      taskProps.areaId = undefined;
    }
    const description = descriptionValue.trim();
    const parsedDescription = typeof taskProps.description === 'string' ? taskProps.description.trim() : '';
    if (description) {
      taskProps.description = parsedDescription && parsedDescription !== description
        ? `${description}\n${parsedDescription}`
        : description;
    }
    if (copilotContext) {
      const nextContexts = Array.from(new Set([...(taskProps.contexts ?? []), copilotContext]));
      taskProps.contexts = nextContexts;
    }
    if (timeEstimatesEnabled && copilotEstimate && !taskProps.timeEstimate) {
      taskProps.timeEstimate = copilotEstimate;
    }
    if (copilotTags.length) {
      const nextTags = Array.from(new Set([...(taskProps.tags ?? []), ...copilotTags]));
      taskProps.tags = nextTags;
    }
    return { title: finalTitle, initialProps: taskProps };
  };

  const createTaskFromInput = async (
    inputValue: string,
    { openAfterSave = false }: { openAfterSave?: boolean } = {},
  ): Promise<boolean> => {
    const taskInput = await buildTaskInputFromInput(inputValue);
    if (!taskInput) return false;
    const addTaskResult = await addTask(taskInput.title, taskInput.initialProps);
    if (addTaskResult && typeof addTaskResult === 'object' && addTaskResult.success === false) return false;
    const createdTaskId = getCreatedTaskId(addTaskResult);
    if (openAfterSave && createdTaskId) {
      openTaskScreen(createdTaskId, taskInput.initialProps.projectId, 'task');
      return false;
    }
    return true;
  };

  const createBulkTasks = async (lines: string[]) => {
    const taskInputs: Array<{ title: string; initialProps: Partial<Task> }> = [];
    for (const line of lines) {
      const taskInput = await buildTaskInputFromInput(line);
      if (!taskInput) return;
      taskInputs.push(taskInput);
    }
    const result = await addTasks(taskInputs);
    if (result && typeof result === 'object' && result.success === false) return;
    closeCapture();
  };

  const handleSave = async ({ openAfterSave = false }: { openAfterSave?: boolean } = {}) => {
    if (!value.trim()) return;
    const bulkLines = splitQuickAddBulkLines(value);
    if (bulkLines.length > 1) {
      Alert.alert(
        formatBulkConfirmTitle(bulkLines.length),
        formatBulkConfirmMessage(bulkLines),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: tFallback(t, 'quickAdd.bulkConfirmCreate', 'Create tasks'),
            onPress: () => {
              void createBulkTasks(bulkLines);
            },
          },
        ],
      );
      return;
    }
    const shouldClose = await createTaskFromInput(value, { openAfterSave });
    if (shouldClose) closeCapture();
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: tc.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: tc.text }]}>{t('nav.addTask')}</Text>
            <View style={styles.headerActions}>
              {keyboardVisible && (
                <TouchableOpacity
                  onPress={Keyboard.dismiss}
                  style={[styles.dismissKeyboardButton, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.done')}
                >
                  <Text style={[styles.dismissKeyboardText, { color: tc.text }]}>{t('common.done')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => setShowHelp((prev) => !prev)}
                style={[styles.helpToggle, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
              >
                <Text style={[styles.helpToggleText, { color: tc.secondaryText }]}>?</Text>
              </TouchableOpacity>
            </View>
          </View>
          <TextInput
            ref={inputRef}
            style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            placeholder={t('quickAdd.example')}
            placeholderTextColor={placeholderColor}
            value={value}
            onChangeText={handleInputChange}
            onSubmitEditing={() => {
              void handleSave();
            }}
            returnKeyType="done"
            multiline
          />
          {(initialDescription.trim().length > 0 || descriptionValue.trim().length > 0) && (
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: tc.secondaryText }]}>{t('taskEdit.descriptionLabel')}</Text>
              <TextInput
                style={[styles.descriptionInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                placeholder={t('taskEdit.descriptionPlaceholder')}
                placeholderTextColor={placeholderColor}
                value={descriptionValue}
                onChangeText={setDescriptionValue}
                multiline
              />
            </View>
          )}
          {copilotSuggestion && !copilotApplied && (
            <TouchableOpacity
              style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
              onPress={() => {
                setCopilotContext(copilotSuggestion.context);
                if (timeEstimatesEnabled) setCopilotEstimate(copilotSuggestion.timeEstimate);
                setCopilotTags(copilotSuggestion.tags ?? []);
                setCopilotApplied(true);
              }}
            >
              <Text style={[styles.copilotText, { color: tc.text }]}>
                ✨ {t('copilot.suggested')}{' '}
                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                {timeEstimatesEnabled && copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
                {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
              </Text>
              <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
                {t('copilot.applyHint')}
              </Text>
            </TouchableOpacity>
          )}
          {copilotApplied && (
            <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.inputBg }]}>
              <Text style={[styles.copilotText, { color: tc.text }]}>
                ✅ {t('copilot.applied')}{' '}
                {copilotContext ? `${copilotContext} ` : ''}
                {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                {copilotTags.length ? copilotTags.join(' ') : ''}
              </Text>
            </View>
          )}
          {showHelp && (
            <Text style={[styles.help, { color: tc.secondaryText }]}>{t('quickAdd.help')}</Text>
          )}
          <View style={styles.actions}>
            <TouchableOpacity onPress={handleCancel} style={[styles.button, styles.cancel, { backgroundColor: tc.inputBg }]}>
              <Text style={{ color: tc.text }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                void handleSave({ openAfterSave: true });
              }}
              style={[styles.button, styles.editAfterSave, { borderColor: tc.border }]}
            >
                                <Text style={{ color: tc.text }}>{t('quickAdd.saveAndEdit')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                void handleSave();
              }}
              style={[styles.button, styles.save]}
            >
              <Text style={styles.saveText}>{t('common.save')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: 16,
    justifyContent: 'center',
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
  },
  dismissKeyboardButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dismissKeyboardText: {
    fontSize: 12,
    fontWeight: '600',
  },
  helpToggle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpToggleText: {
    fontSize: 14,
    fontWeight: '700',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    minHeight: 80,
  },
  help: {
    fontSize: 12,
  },
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  descriptionInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 70,
  },
  copilotPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-start',
    gap: 2,
  },
  copilotText: {
    fontSize: 12,
    fontWeight: '600',
  },
  copilotHint: {
    fontSize: 11,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  cancel: {},
  save: {
    backgroundColor: '#3B82F6',
  },
  editAfterSave: {
    borderWidth: 1,
  },
  saveText: {
    color: '#fff',
    fontWeight: '600',
  },
});
