import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  SectionList,
  StyleSheet,
  Pressable,
  ScrollView,
  Modal,
  TouchableOpacity,
  TextInput,
  Alert,
  Platform,
  RefreshControl,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useLocalSearchParams } from 'expo-router';
import { BookmarkPlus, Folder, SlidersHorizontal, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  applyFilter,
  buildAdvancedFilterCriteriaChips,
  removeAdvancedFilterCriteriaChip,
  sortFocusNextActions,
  shouldShowTaskForStart,
  getFocusSequentialFirstTaskIds,
  generateUUID,
  getProjectDeadlineBoosts,
  hasActiveFilterCriteria,
  markSavedFilterDeleted,
  normalizeFocusTaskLimit,
  SAVED_FILTER_NO_PROJECT_ID,
  sortTasksBySavedPreference,
  translateWithFallback,
  useTaskStore,
  getAdvancedReviewDate,
  isTaskInActiveProject,
  isDueForReview,
  safeFormatDate,
  safeParseDate,
  safeParseDueDate,
  getTaskMetadataFilterVisibility,
  shallow,
  type Project,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskEnergyLevel,
  type TimeEstimate,
  type FocusGroupBy,
  type FilterCriteria,
  type MultiValueFilterMatchMode,
  type SavedFilter,
  type SortField,
  type ProjectDeadlineBoost,
} from '@mindwtr/core';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { useToast } from '../../../contexts/toast-context';
import { TaskEditModal } from '@/components/task-edit-modal';
import type { TaskEditTab } from '@/components/task-edit/use-task-edit-state';
import { PomodoroPanel } from '@/components/pomodoro-panel';
import {
  formatFocusTimeEstimateLabel,
  getFocusTokenOptions,
  groupFocusTasksByContext,
  groupFocusTasksByTag,
  splitFocusedTasks,
} from '@/lib/focus-screen-utils';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { PullSyncIndicator } from '@/components/PullSyncIndicator';
import { useManualPullSync } from '@/hooks/use-manual-pull-sync';
import { projectMatchesAreaFilter, taskMatchesAreaFilter } from '@mindwtr/core';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
const ALL_TIME_ESTIMATE_OPTIONS: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const DEFAULT_TIME_ESTIMATE_PRESETS: TimeEstimate[] = ['5min', '10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const FOCUS_GROUP_BY_OPTIONS: FocusGroupBy[] = ['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag'];
const FOCUS_SORT_OPTIONS: SortField[] = ['default', 'due', 'start', 'priority', 'created', 'created-desc'];
const NO_PROJECT_FILTER_ID = SAVED_FILTER_NO_PROJECT_ID;
const DEFAULT_FOCUS_SORT_BY: SortField = 'default';

function resolveTaskRouteTab(value?: string | string[]): TaskEditTab {
  const routeValue = Array.isArray(value) ? value[0] : value;
  return routeValue === 'task' ? 'task' : 'view';
}

function getProjectDeadlineBoostLabel(
  boost: ProjectDeadlineBoost | undefined,
  resolveText: (key: string, fallback: string) => string,
): string | undefined {
  if (!boost) return undefined;
  return boost.isOverdue
    ? resolveText('focus.projectOverdue', 'Project overdue')
    : resolveText('focus.projectDueToday', 'Project due today');
}
const FOCUS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:focus:v1';
const FOCUS_LIST_INITIAL_RENDER_COUNT = 12;
const FOCUS_LIST_BATCH_RENDER_COUNT = 12;
const FOCUS_LIST_WINDOW_SIZE = 5;
const FOCUS_LIST_BOTTOM_CLEARANCE = 150;
const DEFAULT_EXPANDED_SECTIONS = {
  focus: true,
  schedule: true,
  next: true,
  reviewDue: true,
  reviewProjects: true,
};

type TaskActionResult = { success?: boolean; error?: unknown } | void;
type FocusExpandedSections = typeof DEFAULT_EXPANDED_SECTIONS;

type FocusFilterChip = {
  id: string;
  label: string;
  onPress?: () => void;
  variant?: 'advanced';
};

type FocusSectionType = 'focus' | 'schedule' | 'next' | 'reviewDue' | 'reviewProjects';

type FocusTaskGroup = {
  id: string;
  title: string;
  tasks: Task[];
  muted?: boolean;
  sortOrder?: number;
};

type FocusListItem =
  | { type: 'task'; task: Task; grouped?: boolean }
  | { type: 'project'; project: Project }
  | { type: 'groupHeader'; id: string; title: string; count: number; muted?: boolean };

type FocusSection = {
  title: string;
  data: FocusListItem[];
  totalCount: number;
  expanded: boolean;
  type: FocusSectionType;
};

const getStartDateOffset = (days: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date;
};

const formatDateOnly = (date: Date): string => safeFormatDate(date, 'yyyy-MM-dd');

const getActionFailureMessage = (result: unknown): string | null => {
  if (!result || typeof result !== 'object') return null;
  const actionResult = result as { error?: unknown; success?: unknown };
  if (actionResult.success !== false) return null;
  return typeof actionResult.error === 'string' && actionResult.error.trim().length > 0
    ? actionResult.error.trim()
    : 'Task update failed';
};

const getUnknownErrorMessage = (error: unknown): string | undefined => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  return undefined;
};

function filterSelectionStable<T>(current: T[], predicate: (item: T) => boolean): T[] {
  const next = current.filter(predicate);
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
}

function buildFocusFilterCriteria({
  energyLevels,
  locations,
  priorities,
  projects,
  contextMatchMode,
  timeEstimates,
  tokens,
}: {
  contextMatchMode: MultiValueFilterMatchMode;
  energyLevels: TaskEnergyLevel[];
  locations: string[];
  priorities: TaskPriority[];
  projects: string[];
  timeEstimates: TimeEstimate[];
  tokens: string[];
}): FilterCriteria {
  const contexts = tokens.filter((token) => token.trim().startsWith('@'));
  const tags = tokens.filter((token) => token.trim().startsWith('#'));
  return {
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(contexts.length > 1 ? { contextMatchMode } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(projects.length > 0 ? { projects } : {}),
    ...(locations.length > 0 ? { locations } : {}),
    ...(priorities.length > 0 ? { priority: priorities } : {}),
    ...(energyLevels.length > 0 ? { energy: energyLevels } : {}),
    ...(timeEstimates.length > 0 ? { timeEstimates } : {}),
  };
}

function countFilterCriteria(criteria: FilterCriteria): number {
  return (
    (criteria.contexts?.length ?? 0)
    + (criteria.tags?.length ?? 0)
    + (criteria.projects?.length ?? 0)
    + (criteria.areas?.length ?? 0)
    + (criteria.priority?.length ?? 0)
    + (criteria.energy?.length ?? 0)
    + (criteria.statuses?.length ?? 0)
    + (criteria.assignedTo?.length ?? 0)
    + (criteria.locations?.length ?? 0)
    + (criteria.timeEstimates?.length ?? 0)
    + (criteria.dueDateRange ? 1 : 0)
    + (criteria.startDateRange ? 1 : 0)
    + (criteria.timeEstimateRange ? 1 : 0)
    + (criteria.hasDescription !== undefined ? 1 : 0)
    + (criteria.isStarred !== undefined ? 1 : 0)
  );
}

function normalizeFocusGroupBy(value: unknown): FocusGroupBy {
  return FOCUS_GROUP_BY_OPTIONS.includes(value as FocusGroupBy) ? value as FocusGroupBy : 'none';
}

function buildFocusTaskGroups(
  tasks: Task[],
  resolveGroup: (task: Task) => Omit<FocusTaskGroup, 'tasks'>,
): FocusTaskGroup[] {
  const groups = new Map<string, FocusTaskGroup>();
  tasks.forEach((task) => {
    const descriptor = resolveGroup(task);
    const group = groups.get(descriptor.id);
    if (group) {
      group.tasks.push(task);
      return;
    }
    groups.set(descriptor.id, { ...descriptor, tasks: [task] });
  });

  return Array.from(groups.values()).sort((left, right) => {
    const leftOrder = Number.isFinite(left.sortOrder) ? left.sortOrder as number : Number.POSITIVE_INFINITY;
    const rightOrder = Number.isFinite(right.sortOrder) ? right.sortOrder as number : Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
  });
}

const readPersistedFocusExpandedSections = (raw: string | null): Partial<FocusExpandedSections> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      expandedSections?: {
        focus?: unknown;
        next?: unknown;
        nextActions?: unknown;
        reviewDue?: unknown;
        reviewProjects?: unknown;
        schedule?: unknown;
      };
    };
    const persisted = parsed.expandedSections;
    if (!persisted) return null;
    const next: Partial<FocusExpandedSections> = {};
    if (typeof persisted.focus === 'boolean') next.focus = persisted.focus;
    if (typeof persisted.schedule === 'boolean') next.schedule = persisted.schedule;
    const nextActionsExpanded = typeof persisted.next === 'boolean'
      ? persisted.next
      : persisted.nextActions;
    if (typeof nextActionsExpanded === 'boolean') next.next = nextActionsExpanded;
    if (typeof persisted.reviewDue === 'boolean') next.reviewDue = persisted.reviewDue;
    if (typeof persisted.reviewProjects === 'boolean') next.reviewProjects = persisted.reviewProjects;
    return Object.keys(next).length > 0 ? next : null;
  } catch {
    return null;
  }
};

const serializeFocusViewState = (expandedSections: FocusExpandedSections): string => JSON.stringify({
  expandedSections: {
    focus: expandedSections.focus,
    schedule: expandedSections.schedule,
    next: expandedSections.next,
    nextActions: expandedSections.next,
    reviewDue: expandedSections.reviewDue,
    reviewProjects: expandedSections.reviewProjects,
  },
});

export default function FocusScreen() {
  const { taskId, openToken, taskTab } = useLocalSearchParams<{ taskId?: string; openToken?: string; taskTab?: string }>();
  const insets = useSafeAreaInsets();
  const { tasks, projects, settings, updateTask, deleteTask, updateSettings, highlightTaskId, setHighlightTask } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    settings: state.settings,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    updateSettings: state.updateSettings,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const { showToast } = useToast();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const pullSync = useManualPullSync();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [taskModalDefaultTab, setTaskModalDefaultTab] = useState<TaskEditTab>('view');
  const [taskModalOpenKey, setTaskModalOpenKey] = useState('manual');
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [deferPickerTask, setDeferPickerTask] = useState<Task | null>(null);
  const [deferPickerDate, setDeferPickerDate] = useState<Date>(() => getStartDateOffset(1));
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const [locationFilter, setLocationFilter] = useState('');
  const [contextMatchMode, setContextMatchMode] = useState<MultiValueFilterMatchMode>('all');
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const [focusSortBy, setFocusSortBy] = useState<SortField>(DEFAULT_FOCUS_SORT_BY);
  const [saveFilterDialogVisible, setSaveFilterDialogVisible] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');
  const showFutureStarts = settings?.appearance?.showFutureStarts === true;
  const [expandedSections, setExpandedSections] = useState(DEFAULT_EXPANDED_SECTIONS);
  const [focusViewStateHydrated, setFocusViewStateHydrated] = useState(false);
  const didToggleSectionRef = useRef(false);
  const lastOpenedFromNotificationRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pomodoroEnabled = settings?.features?.pomodoro === true;
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const focusGroupBy = normalizeFocusGroupBy(settings?.gtd?.focusGroupBy);
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const visibleProjects = useMemo(() => (
    projects.filter((project) => !project.deletedAt && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
  ), [projects, resolvedAreaFilter, areaById]);
  const visibleTasks = useMemo(() => (
    tasks.filter((task) => (
      isTaskInActiveProject(task, projectById)
      && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
    ))
  ), [tasks, resolvedAreaFilter, projectById, areaById]);
  const baseActiveTasks = useMemo(() => (
    visibleTasks.filter((task) => (
      !task.deletedAt
      && task.status !== 'done'
      && task.status !== 'archived'
      && task.status !== 'reference'
    ))
  ), [visibleTasks]);
  const activeTasks = useMemo(() => (
    baseActiveTasks.filter((task) => shouldShowTaskForStart(task, { showFutureStarts }))
  ), [baseActiveTasks, showFutureStarts]);
  const futureStartTasks = useMemo(() => (
    baseActiveTasks.filter((task) => !shouldShowTaskForStart(task, { showFutureStarts: false }))
  ), [baseActiveTasks]);
  const hiddenFutureStartCount = futureStartTasks.length;
  const futureStartPreview = useMemo(() => {
    if (!showFutureStarts || futureStartTasks.length === 0) return '';
    const visibleTitles = futureStartTasks.slice(0, 2).map((task) => task.title.trim()).filter(Boolean);
    const remainingCount = futureStartTasks.length - visibleTitles.length;
    return remainingCount > 0
      ? `${visibleTitles.join(', ')} +${remainingCount}`
      : visibleTitles.join(', ');
  }, [futureStartTasks, showFutureStarts]);
  const tokenOptions = useMemo(() => getFocusTokenOptions(activeTasks), [activeTasks]);
  const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(activeTasks, {
    prioritiesEnabled,
    timeEstimatesEnabled,
  }), [activeTasks, prioritiesEnabled, timeEstimatesEnabled]);
  const showPriorityFilters = metadataFilterVisibility.priority;
  const showEnergyLevelFilters = metadataFilterVisibility.energyLevel;
  const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
  const showLocationFilter = metadataFilterVisibility.location;
  const activeProjectIds = useMemo(() => (
    new Set(activeTasks.map((task) => task.projectId).filter((projectId): projectId is string => Boolean(projectId)))
  ), [activeTasks]);
  const projectOptions = useMemo(() => (
    visibleProjects
      .filter((project) => activeProjectIds.has(project.id))
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      })
  ), [activeProjectIds, visibleProjects]);
  const showNoProjectOption = useMemo(() => activeTasks.some((task) => !task.projectId), [activeTasks]);
  const effectiveTimeEstimatePresets = useMemo<TimeEstimate[]>(() => {
    const saved = settings?.gtd?.timeEstimatePresets;
    return saved?.length ? saved : DEFAULT_TIME_ESTIMATE_PRESETS;
  }, [settings?.gtd?.timeEstimatePresets]);
  const savedFocusFilters = useMemo(
    () => (settings?.savedFilters ?? []).filter((filter) => filter.view === 'focus' && !filter.deletedAt),
    [settings?.savedFilters],
  );
  const activeSavedFilter = useMemo(
    () => savedFocusFilters.find((filter) => filter.id === activeSavedFilterId) ?? null,
    [activeSavedFilterId, savedFocusFilters],
  );
  const effectiveFocusSortBy = activeSavedFilter?.sortBy ?? focusSortBy;
  const effectiveFocusGroupBy = normalizeFocusGroupBy(activeSavedFilter?.groupBy ?? focusGroupBy);
  const currentFilterCriteria = useMemo(() => buildFocusFilterCriteria({
    tokens: selectedTokens,
    projects: selectedProjects,
    locations: showLocationFilter && locationFilter.trim() ? [locationFilter.trim()] : [],
    priorities: showPriorityFilters ? selectedPriorities : [],
    energyLevels: showEnergyLevelFilters ? selectedEnergyLevels : [],
    contextMatchMode,
    timeEstimates: showTimeEstimateFilters ? selectedTimeEstimates : [],
  }), [
    contextMatchMode,
    locationFilter,
    showEnergyLevelFilters,
    showPriorityFilters,
    selectedEnergyLevels,
    selectedPriorities,
    selectedProjects,
    selectedTimeEstimates,
    selectedTokens,
    showTimeEstimateFilters,
  ]);
  const rawEffectiveFilterCriteria = activeSavedFilter?.criteria ?? currentFilterCriteria;
  const effectiveContextMatchMode = rawEffectiveFilterCriteria.contextMatchMode ?? 'all';
  const effectiveFilterCriteria = useMemo<FilterCriteria>(() => ({
    ...rawEffectiveFilterCriteria,
    ...(showPriorityFilters ? {} : { priority: undefined }),
    ...(showEnergyLevelFilters ? {} : { energy: undefined }),
    ...(showLocationFilter ? {} : { locations: undefined }),
    ...(showTimeEstimateFilters ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
  }), [rawEffectiveFilterCriteria, showEnergyLevelFilters, showLocationFilter, showPriorityFilters, showTimeEstimateFilters]);
  const hasCurrentFilterCriteria = hasActiveFilterCriteria(currentFilterCriteria);
  const hasFilters = hasActiveFilterCriteria(effectiveFilterCriteria);
  const canSaveFocusPerspective = activeSavedFilterId === null
    && (
      hasCurrentFilterCriteria
      || focusSortBy !== DEFAULT_FOCUS_SORT_BY
      || effectiveFocusGroupBy !== 'none'
    );
  const filteredActiveTasks = useMemo(() => (
    applyFilter(activeTasks, effectiveFilterCriteria, { projects, tokenMatchMode: 'all' })
  ), [
    activeTasks,
    effectiveFilterCriteria,
    projects,
  ]);
  const resolveText = useCallback((key: string, fallback: string) => {
    return translateWithFallback(t, key, fallback);
  }, [t]);
  const getFocusGroupByLabel = useCallback((groupBy: FocusGroupBy) => {
    switch (groupBy) {
      case 'context':
        return resolveText('focus.group.context', 'Context');
      case 'project':
        return resolveText('focus.group.project', 'Project');
      case 'area':
        return resolveText('focus.group.area', 'Area');
      case 'energy':
        return resolveText('focus.group.energy', 'Energy');
      case 'priority':
        return resolveText('focus.group.priority', 'Priority');
      case 'person':
        return resolveText('people.title', 'People');
      case 'tag':
        return resolveText('tags.title', 'Tags');
      case 'none':
      default:
        return resolveText('focus.group.none', 'None');
    }
  }, [resolveText]);
  const getFocusSortByLabel = useCallback((sortBy: SortField) => {
    if (sortBy === 'priority') return resolveText('filters.priority', 'Priority');
    return resolveText(`sort.${sortBy}`, sortBy);
  }, [resolveText]);
  const updateFocusSortBy = useCallback((nextSortBy: SortField) => {
    if (nextSortBy === effectiveFocusSortBy && !activeSavedFilter) return;
    setActiveSavedFilterId(null);
    setFocusSortBy(nextSortBy);
  }, [activeSavedFilter, effectiveFocusSortBy]);
  const updateFocusGroupBy = useCallback((nextGroupBy: FocusGroupBy) => {
    if (nextGroupBy === effectiveFocusGroupBy && !activeSavedFilter) return;
    setActiveSavedFilterId(null);
    void updateSettings({
      gtd: {
        ...(settings?.gtd ?? {}),
        focusGroupBy: nextGroupBy,
      },
    }).catch(() => undefined);
  }, [activeSavedFilter, effectiveFocusGroupBy, settings?.gtd, updateSettings]);
  const toggleFutureStarts = useCallback(() => {
    void updateSettings({
      appearance: {
        ...(settings.appearance ?? {}),
        showFutureStarts: !showFutureStarts,
      },
    }).catch(() => undefined);
  }, [settings.appearance, showFutureStarts, updateSettings]);
  const formatFutureStartNotice = useCallback((count: number, shown: boolean) => {
    const template = shown
      ? (count === 1
        ? resolveText('agenda.futureStartsShownOne', '1 future-start task shown')
        : resolveText('agenda.futureStartsShownMany', '{count} future-start tasks shown'))
      : (count === 1
        ? resolveText('agenda.futureStartsHiddenOne', '1 task hidden (future start)')
        : resolveText('agenda.futureStartsHiddenMany', '{count} tasks hidden (future start)'));
    return template.replace('{count}', String(count));
  }, [resolveText]);
  const showTaskUpdateError = useCallback((message?: string) => {
    showToast({
      title: resolveText('common.error', 'Error'),
      message: message || resolveText('task.updateFailed', 'Could not update task.'),
      tone: 'error',
      durationMs: 4200,
    });
  }, [resolveText, showToast]);
  const deferTaskUntil = useCallback((task: Task, selectedDate: Date) => {
    const startDate = new Date(selectedDate);
    startDate.setHours(0, 0, 0, 0);
    const startTime = formatDateOnly(startDate);
    const previousStartTime = task.startTime;
    const previousFocused = task.isFocusedToday === true;
    const deferUpdates: Partial<Task> = {
      startTime,
      ...(previousFocused ? { isFocusedToday: false } : {}),
    };

    void Promise.resolve(updateTask(task.id, deferUpdates))
      .then((result: TaskActionResult) => {
        const failure = getActionFailureMessage(result);
        if (failure) {
          showTaskUpdateError(failure);
          return;
        }
        showToast({
          title: task.title,
          message: `${resolveText('review.startTime', 'Defer until')} ${safeFormatDate(startDate, 'PP', startTime)}`,
          tone: 'info',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: async () => {
            const undoUpdates: Partial<Task> = {
              startTime: previousStartTime,
              ...(previousFocused ? { isFocusedToday: true } : {}),
            };
            const undoResult = await updateTask(task.id, undoUpdates);
            const undoFailure = getActionFailureMessage(undoResult);
            if (undoFailure) throw new Error(undoFailure);
          },
          durationMs: 5200,
        });
      })
      .catch((error) => showTaskUpdateError(getUnknownErrorMessage(error)));
  }, [resolveText, showTaskUpdateError, showToast, updateTask]);
  const markTaskReviewed = useCallback((task: Task) => {
    const previousReviewAt = task.reviewAt;

    void Promise.resolve(updateTask(task.id, { reviewAt: undefined }))
      .then((result: TaskActionResult) => {
        const failure = getActionFailureMessage(result);
        if (failure) {
          showTaskUpdateError(failure);
          return;
        }
        showToast({
          title: task.title,
          message: resolveText('review.markReviewedDone', 'Marked reviewed'),
          tone: 'success',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: async () => {
            const undoResult = await updateTask(task.id, { reviewAt: previousReviewAt });
            const undoFailure = getActionFailureMessage(undoResult);
            if (undoFailure) throw new Error(undoFailure);
          },
          durationMs: 5200,
        });
      })
      .catch((error) => showTaskUpdateError(getUnknownErrorMessage(error)));
  }, [resolveText, showTaskUpdateError, showToast, updateTask]);
  const advanceTaskReview = useCallback((task: Task) => {
    const previousReviewAt = task.reviewAt;

    void Promise.resolve(updateTask(task.id, { reviewAt: getAdvancedReviewDate(task.reviewAt) }))
      .then((result: TaskActionResult) => {
        const failure = getActionFailureMessage(result);
        if (failure) {
          showTaskUpdateError(failure);
          return;
        }
        showToast({
          title: task.title,
          message: resolveText('review.advanceWeekDone', 'Next review in 1 week'),
          tone: 'success',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: async () => {
            const undoResult = await updateTask(task.id, { reviewAt: previousReviewAt });
            const undoFailure = getActionFailureMessage(undoResult);
            if (undoFailure) throw new Error(undoFailure);
          },
          durationMs: 5200,
        });
      })
      .catch((error) => showTaskUpdateError(getUnknownErrorMessage(error)));
  }, [resolveText, showTaskUpdateError, showToast, updateTask]);
  const openReviewMenu = useCallback((task: Task) => {
    Alert.alert(
      task.title,
      undefined,
      [
        {
          text: resolveText('review.markReviewed', 'Mark reviewed'),
          onPress: () => markTaskReviewed(task),
        },
        {
          text: resolveText('review.advanceWeek', 'Review in 1 week'),
          onPress: () => advanceTaskReview(task),
        },
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
      ],
      { cancelable: true },
    );
  }, [advanceTaskReview, markTaskReviewed, resolveText]);
  const openDeferDatePicker = useCallback((task: Task) => {
    setDeferPickerDate(getStartDateOffset(1));
    setDeferPickerTask(task);
  }, []);
  const openDeferMenu = useCallback((task: Task) => {
    Alert.alert(
      resolveText('review.startTime', 'Defer until'),
      task.title,
      [
        {
          text: resolveText('quickDate.tomorrow', 'Tomorrow'),
          onPress: () => deferTaskUntil(task, getStartDateOffset(1)),
        },
        {
          text: resolveText('quickDate.nextWeek', 'Next week'),
          onPress: () => deferTaskUntil(task, getStartDateOffset(7)),
        },
        {
          text: resolveText('recurrence.custom', 'Custom...'),
          onPress: () => openDeferDatePicker(task),
        },
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
      ],
      { cancelable: true },
    );
  }, [deferTaskUntil, openDeferDatePicker, resolveText]);
  const closeDeferDatePicker = useCallback(() => {
    setDeferPickerTask(null);
  }, []);
  const confirmPickedDeferDate = useCallback(() => {
    const task = deferPickerTask;
    setDeferPickerTask(null);
    if (task) deferTaskUntil(task, deferPickerDate);
  }, [deferPickerDate, deferPickerTask, deferTaskUntil]);
  const handleDeferDateChange = useCallback((event: DateTimePickerEvent, selectedDate?: Date) => {
    if (event.type === 'dismissed') {
      setDeferPickerTask(null);
      return;
    }
    if (!selectedDate) return;
    const nextDate = new Date(selectedDate);
    nextDate.setHours(0, 0, 0, 0);
    setDeferPickerDate(nextDate);
    if (Platform.OS !== 'ios') {
      const task = deferPickerTask;
      setDeferPickerTask(null);
      if (task) deferTaskUntil(task, nextDate);
    }
  }, [deferPickerTask, deferTaskUntil]);
  useEffect(() => {
    if (activeSavedFilterId && !activeSavedFilter) {
      setActiveSavedFilterId(null);
    }
  }, [activeSavedFilter, activeSavedFilterId]);
  const toggleToken = useCallback((token: string) => {
    setActiveSavedFilterId(null);
    setSelectedTokens((current) => (
      current.includes(token) ? current.filter((item) => item !== token) : [...current, token]
    ));
  }, []);
  const toggleProject = useCallback((projectId: string) => {
    setActiveSavedFilterId(null);
    setSelectedProjects((current) => (
      current.includes(projectId) ? current.filter((item) => item !== projectId) : [...current, projectId]
    ));
  }, []);
  const togglePriority = useCallback((priority: TaskPriority) => {
    setActiveSavedFilterId(null);
    setSelectedPriorities((current) => (
      current.includes(priority) ? current.filter((item) => item !== priority) : [...current, priority]
    ));
  }, []);
  const toggleEnergyLevel = useCallback((energyLevel: TaskEnergyLevel) => {
    setActiveSavedFilterId(null);
    setSelectedEnergyLevels((current) => (
      current.includes(energyLevel) ? current.filter((item) => item !== energyLevel) : [...current, energyLevel]
    ));
  }, []);
  const toggleTimeEstimate = useCallback((estimate: TimeEstimate) => {
    setActiveSavedFilterId(null);
    setSelectedTimeEstimates((current) => (
      current.includes(estimate) ? current.filter((item) => item !== estimate) : [...current, estimate]
    ));
  }, []);
  const updateContextMatchMode = useCallback((mode: MultiValueFilterMatchMode) => {
    setActiveSavedFilterId(null);
    setContextMatchMode(mode);
  }, []);
  const updateLocationFilter = useCallback((value: string) => {
    setActiveSavedFilterId(null);
    setLocationFilter(value);
  }, []);
  const clearFilters = useCallback(() => {
    setActiveSavedFilterId(null);
    setFocusSortBy(DEFAULT_FOCUS_SORT_BY);
    setSelectedTokens([]);
    setSelectedProjects([]);
    setLocationFilter('');
    setSelectedPriorities([]);
    setSelectedEnergyLevels([]);
    setSelectedTimeEstimates([]);
    setContextMatchMode('all');
  }, []);
  const applySavedFocusFilter = useCallback((filter: SavedFilter) => {
    const criteria = filter.criteria ?? {};
    const prioritySet = new Set<TaskPriority>(PRIORITY_OPTIONS);
    const energySet = new Set<TaskEnergyLevel>(ENERGY_LEVEL_OPTIONS);
    const estimateSet = new Set<TimeEstimate>(ALL_TIME_ESTIMATE_OPTIONS);
    setSelectedTokens([...(criteria.contexts ?? []), ...(criteria.tags ?? [])]);
    setSelectedProjects(criteria.projects ?? []);
    setLocationFilter((criteria.locations ?? [])[0] ?? '');
    setSelectedPriorities((criteria.priority ?? []).filter((priority): priority is TaskPriority => (
      priority !== 'none' && prioritySet.has(priority)
    )));
    setSelectedEnergyLevels((criteria.energy ?? []).filter((energy): energy is TaskEnergyLevel => energySet.has(energy)));
    setSelectedTimeEstimates((criteria.timeEstimates ?? []).filter((estimate): estimate is TimeEstimate => estimateSet.has(estimate)));
    setContextMatchMode(criteria.contextMatchMode ?? 'all');
    setFocusSortBy(filter.sortBy ?? DEFAULT_FOCUS_SORT_BY);
    setActiveSavedFilterId(filter.id);
    setFiltersVisible(false);
  }, []);
  const saveCurrentFilter = useCallback(() => {
    const trimmedName = saveFilterName.trim();
    if (!trimmedName || !canSaveFocusPerspective) return;
    const nowIso = new Date().toISOString();
    const nextFilter: SavedFilter = {
      id: generateUUID(),
      name: trimmedName,
      view: 'focus',
      criteria: currentFilterCriteria,
      ...(focusSortBy !== DEFAULT_FOCUS_SORT_BY ? { sortBy: focusSortBy } : {}),
      ...(effectiveFocusGroupBy !== 'none' ? { groupBy: effectiveFocusGroupBy } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    updateSettings({
      savedFilters: [...(settings?.savedFilters ?? []), nextFilter],
    }).then(() => {
      setActiveSavedFilterId(nextFilter.id);
      setSaveFilterDialogVisible(false);
      setFiltersVisible(false);
    }).catch(() => undefined);
  }, [canSaveFocusPerspective, currentFilterCriteria, effectiveFocusGroupBy, focusSortBy, saveFilterName, settings?.savedFilters, updateSettings]);
  const deleteSavedFilter = useCallback((filter: SavedFilter) => {
    const nextFilters = markSavedFilterDeleted(settings?.savedFilters, filter.id);
    updateSettings({ savedFilters: nextFilters }).then(() => {
      if (activeSavedFilterId === filter.id) {
        setActiveSavedFilterId(null);
      }
    }).catch(() => undefined);
  }, [activeSavedFilterId, settings?.savedFilters, updateSettings]);
  const confirmDeleteSavedFilter = useCallback((filter: SavedFilter) => {
    Alert.alert(
      resolveText('savedFilters.deleteTitle', 'Delete saved filter?'),
      filter.name,
      [
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: resolveText('common.delete', 'Delete'),
          style: 'destructive',
          onPress: () => deleteSavedFilter(filter),
        },
      ],
      { cancelable: true },
    );
  }, [deleteSavedFilter, resolveText]);
  const removeAdvancedSavedFilterCriterion = useCallback((chipId: string) => {
    if (!activeSavedFilter) return;
    const nextCriteria = removeAdvancedFilterCriteriaChip(activeSavedFilter.criteria, chipId);
    if (nextCriteria === activeSavedFilter.criteria) return;

    const nowIso = new Date().toISOString();
    const nextFilters = (settings?.savedFilters ?? []).map((filter) => (
      filter.id === activeSavedFilter.id
        ? { ...filter, criteria: nextCriteria, updatedAt: nowIso }
        : filter
    ));
    updateSettings({ savedFilters: nextFilters }).catch(() => undefined);
  }, [activeSavedFilter, settings?.savedFilters, updateSettings]);
  const confirmRemoveAdvancedSavedFilterCriterion = useCallback((chipId: string, label: string) => {
    Alert.alert(
      resolveText('common.delete', 'Delete'),
      label,
      [
        { text: resolveText('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: resolveText('common.delete', 'Delete'),
          style: 'destructive',
          onPress: () => removeAdvancedSavedFilterCriterion(chipId),
        },
      ],
      { cancelable: true },
    );
  }, [removeAdvancedSavedFilterCriterion, resolveText]);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(FOCUS_VIEW_STATE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (!didToggleSectionRef.current) {
          const persistedExpandedSections = readPersistedFocusExpandedSections(raw);
          if (persistedExpandedSections) {
            setExpandedSections((current) => ({
              ...current,
              ...persistedExpandedSections,
            }));
          }
        }
        setFocusViewStateHydrated(true);
      })
      .catch(() => {
        if (active) {
          setFocusViewStateHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    const nextTaskTab = resolveTaskRouteTab(taskTab);
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}:${nextTaskTab}`;
    if (lastOpenedFromNotificationRef.current === openKey) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) return;
    lastOpenedFromNotificationRef.current = openKey;
    setHighlightTask(task.id);
    setTaskModalDefaultTab(nextTaskTab);
    setTaskModalOpenKey(`route:${openKey}`);
    setEditingTask(task);
    setIsModalVisible(true);
  }, [openToken, setHighlightTask, taskId, taskTab, tasks]);

  useEffect(() => {
    if (!highlightTaskId) return;
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = setTimeout(() => {
      setHighlightTask(null);
    }, 3500);
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, [highlightTaskId, setHighlightTask]);

  useEffect(() => {
    setSelectedTokens((current) => filterSelectionStable(current, (token) => tokenOptions.includes(token)));
  }, [tokenOptions]);

  useEffect(() => {
    const validProjectIds = new Set(projectOptions.map((project) => project.id));
    setSelectedProjects((current) => filterSelectionStable(current, (projectId) => (
      projectId === NO_PROJECT_FILTER_ID ? showNoProjectOption : validProjectIds.has(projectId)
    )));
  }, [projectOptions, showNoProjectOption]);

  useEffect(() => {
    if (showPriorityFilters) return;
    if (selectedPriorities.length === 0) return;
    setSelectedPriorities([]);
  }, [selectedPriorities.length, showPriorityFilters]);

  useEffect(() => {
    if (showEnergyLevelFilters) return;
    if (selectedEnergyLevels.length === 0) return;
    setSelectedEnergyLevels([]);
  }, [selectedEnergyLevels.length, showEnergyLevelFilters]);

  useEffect(() => {
    if (showLocationFilter) return;
    if (locationFilter.trim().length === 0) return;
    setLocationFilter('');
  }, [locationFilter, showLocationFilter]);

  useEffect(() => {
    if (showTimeEstimateFilters) return;
    if (selectedTimeEstimates.length === 0) return;
    setSelectedTimeEstimates([]);
  }, [selectedTimeEstimates.length, showTimeEstimateFilters]);

  const sequentialProjectIds = useMemo(() => {
    return new Set(visibleProjects.filter((project) => project.isSequential).map((project) => project.id));
  }, [visibleProjects]);
  const sequentialWithinSectionProjectIds = useMemo(() => {
    return new Set(
      visibleProjects
        .filter((project) => project.isSequential && project.sequentialScope === 'section')
        .map((project) => project.id)
    );
  }, [visibleProjects]);
  const sortBySavedPerspective = useCallback((items: Task[]) => {
    if (effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY) return items;
    return sortTasksBySavedPreference(items, effectiveFocusSortBy, {
      projects,
      prioritizeByPriority: prioritiesEnabled,
      sortOrder: activeSavedFilter?.sortOrder,
    });
  }, [activeSavedFilter?.sortOrder, effectiveFocusSortBy, prioritiesEnabled, projects]);

  const { focusedTasks, schedule, nextActions, reviewDue, projectDeadlineBoosts } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const { focusedTasks: allFocusedTasks, otherTasks: nonFocusedTasks } = splitFocusedTasks(filteredActiveTasks);
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, {
      now,
      sectionScopedProjectIds: sequentialWithinSectionProjectIds,
    });

    const isSequentialBlocked = (task: Task) => {
      if (!task.projectId) return false;
      if (!sequentialProjectIds.has(task.projectId)) return false;
      return !sequentialFirstTaskIds.has(task.id);
    };

    const reviewDueItems = nonFocusedTasks
      .filter((task) => isDueForReview(task.reviewAt, now))
      .sort((a, b) => {
        const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aReview !== bReview) return aReview - bReview;
        return a.title.localeCompare(b.title);
      });
    const reviewDueIds = new Set(reviewDueItems.map((task) => task.id));

    const scheduleItems = nonFocusedTasks.filter((task) => {
      if (reviewDueIds.has(task.id)) return false;
      if (task.status !== 'next') return false;
      if (isSequentialBlocked(task)) return false;
      const due = safeParseDueDate(task.dueDate);
      const start = safeParseDate(task.startTime);
      const startsToday = Boolean(
        start
        && start >= startOfToday
        && start <= endOfToday
      );
      return Boolean(due && due <= endOfToday) || startsToday;
    });

    const scheduleIds = new Set(scheduleItems.map((task) => task.id));

    const nextItems = nonFocusedTasks.filter((task) => {
      if (reviewDueIds.has(task.id)) return false;
      if (task.status !== 'next') return false;
      if (isSequentialBlocked(task)) return false;
      return !scheduleIds.has(task.id);
    });
    const nextProjectDeadlineBoosts = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
      ? getProjectDeadlineBoosts(nextItems, projects, { now })
      : new Map<string, ProjectDeadlineBoost>();

    return {
      focusedTasks: sortBySavedPerspective(allFocusedTasks),
      schedule: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY ? scheduleItems : sortBySavedPerspective(scheduleItems),
      nextActions: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
        ? sortFocusNextActions(nextItems, {
          now,
          prioritizeByPriority: prioritiesEnabled,
          projectDeadlineBoosts: nextProjectDeadlineBoosts,
        })
        : sortBySavedPerspective(nextItems),
      reviewDue: effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY ? reviewDueItems : sortBySavedPerspective(reviewDueItems),
      projectDeadlineBoosts: nextProjectDeadlineBoosts,
    };
  }, [
    baseActiveTasks,
    effectiveFocusSortBy,
    filteredActiveTasks,
    prioritiesEnabled,
    projects,
    sequentialProjectIds,
    sequentialWithinSectionProjectIds,
    sortBySavedPerspective,
  ]);
  const reviewDueProjects = useMemo(() => {
    const now = new Date();
    return visibleProjects
      .filter((project) => project.status !== 'archived' && isDueForReview(project.reviewAt, now))
      .sort((a, b) => {
        const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aReview !== bReview) return aReview - bReview;
        return a.title.localeCompare(b.title);
      });
  }, [visibleProjects]);

  const sections = useMemo<FocusSection[]>(() => {
    if (!focusViewStateHydrated) return [];

    const buildTaskItems = (items: Task[], grouped = false): FocusListItem[] => (
      items.map((task) => ({ type: 'task' as const, task, grouped }))
    );
    const buildProjectItems = (items: Project[]): FocusListItem[] => (
      items.map((project) => ({ type: 'project' as const, project }))
    );
    const getEnergySortOrder = (energyLevel: TaskEnergyLevel | undefined): number => {
      if (energyLevel === 'high') return 0;
      if (energyLevel === 'medium') return 1;
      if (energyLevel === 'low') return 2;
      return 3;
    };
    const getPrioritySortOrder = (priority: TaskPriority | undefined): number => {
      if (priority === 'urgent') return 0;
      if (priority === 'high') return 1;
      if (priority === 'medium') return 2;
      if (priority === 'low') return 3;
      return 4;
    };
    const buildNextActionGroups = (): FocusTaskGroup[] => {
      switch (effectiveFocusGroupBy) {
        case 'context':
          return groupFocusTasksByContext(nextActions, resolveText('contexts.none', 'No context'));
        case 'project':
          return buildFocusTaskGroups(nextActions, (task) => {
            const project = task.projectId ? projectById.get(task.projectId) : undefined;
            const order = project && Number.isFinite(project.order) ? project.order : Number.POSITIVE_INFINITY;
            return project
              ? { id: `project:${project.id}`, title: project.title, sortOrder: order }
              : { id: 'project:none', title: resolveText('taskEdit.noProjectOption', 'No project'), muted: true, sortOrder: -1 };
          });
        case 'area':
          return buildFocusTaskGroups(nextActions, (task) => {
            const project = task.projectId ? projectById.get(task.projectId) : undefined;
            const areaId = project?.areaId ?? task.areaId;
            const area = areaId ? areaById.get(areaId) : undefined;
            const order = area && Number.isFinite(area.order) ? area.order : Number.POSITIVE_INFINITY;
            return areaId
              ? {
                id: `area:${areaId}`,
                title: area?.name ?? project?.areaTitle ?? resolveText('taskEdit.noAreaOption', 'No area'),
                sortOrder: order,
              }
              : { id: 'area:none', title: resolveText('taskEdit.noAreaOption', 'No area'), muted: true, sortOrder: -1 };
          });
        case 'energy':
          return buildFocusTaskGroups(nextActions, (task) => (
            task.energyLevel
              ? {
                id: `energy:${task.energyLevel}`,
                title: t(`energyLevel.${task.energyLevel}`),
                sortOrder: getEnergySortOrder(task.energyLevel),
              }
              : { id: 'energy:none', title: resolveText('focus.group.noEnergy', 'No energy'), muted: true, sortOrder: getEnergySortOrder(undefined) }
          ));
        case 'priority':
          return buildFocusTaskGroups(nextActions, (task) => (
            task.priority
              ? {
                id: `priority:${task.priority}`,
                title: t(`priority.${task.priority}`),
                sortOrder: getPrioritySortOrder(task.priority),
              }
              : { id: 'priority:none', title: resolveText('focus.group.noPriority', 'No priority'), muted: true, sortOrder: getPrioritySortOrder(undefined) }
          ));
        case 'person':
          return buildFocusTaskGroups(nextActions, (task) => {
            const name = task.assignedTo?.trim();
            return name
              ? { id: `person:${name.toLowerCase()}`, title: name }
              : { id: 'person:none', title: resolveText('people.unassigned', 'Unassigned'), muted: true, sortOrder: Number.POSITIVE_INFINITY };
          });
        case 'tag':
          return groupFocusTasksByTag(nextActions, resolveText('projects.noTags', 'No tags'));
        case 'none':
        default:
          return [];
      }
    };
    const buildGroupedNextItems = (): FocusListItem[] => {
      if (!expandedSections.next) return [];
      if (effectiveFocusGroupBy === 'none') {
        return buildTaskItems(nextActions);
      }
      const groups = buildNextActionGroups();
      return groups
        .flatMap((group) => [
          {
            type: 'groupHeader' as const,
            id: group.id,
            title: group.title,
            count: group.tasks.length,
            muted: group.muted,
          },
          ...buildTaskItems(group.tasks, true),
        ]);
    };
    const nextSections: FocusSection[] = [];

    if (focusedTasks.length > 0) {
      nextSections.push({
        title: t('agenda.todaysFocus') ?? "Today's Focus",
        data: expandedSections.focus ? buildTaskItems(focusedTasks) : [],
        totalCount: focusedTasks.length,
        expanded: expandedSections.focus,
        type: 'focus',
      });
    }

    nextSections.push(
      {
        title: t('focus.schedule') ?? 'Today',
        data: expandedSections.schedule ? buildTaskItems(schedule) : [],
        totalCount: schedule.length,
        expanded: expandedSections.schedule,
        type: 'schedule',
      },
      {
        title: t('focus.nextActions') ?? t('list.next'),
        data: buildGroupedNextItems(),
        totalCount: nextActions.length,
        expanded: expandedSections.next,
        type: 'next',
      },
      {
        title: t('agenda.reviewDue') ?? 'Review Due',
        data: expandedSections.reviewDue ? buildTaskItems(reviewDue) : [],
        totalCount: reviewDue.length,
        expanded: expandedSections.reviewDue,
        type: 'reviewDue',
      },
      {
        title: t('agenda.reviewDueProjects') ?? 'Projects to review',
        data: expandedSections.reviewProjects ? buildProjectItems(reviewDueProjects) : [],
        totalCount: reviewDueProjects.length,
        expanded: expandedSections.reviewProjects,
        type: 'reviewProjects',
      }
    );

    return nextSections;
  }, [
    areaById,
    effectiveFocusGroupBy,
    expandedSections.focus,
    expandedSections.next,
    focusViewStateHydrated,
    expandedSections.reviewDue,
    expandedSections.reviewProjects,
    expandedSections.schedule,
    focusedTasks,
    nextActions,
    projectById,
    resolveText,
    reviewDue,
    reviewDueProjects,
    schedule,
    t,
  ]);
  const focusListVersion = useMemo(() => (
    sections.map((section) => {
      const itemVersion = section.data.map((item) => {
        if (item.type === 'task') {
          return [
            'task',
            item.task.id,
            item.task.status,
            item.task.isFocusedToday === true ? 'focused' : 'unfocused',
            item.task.updatedAt ?? '',
            item.task.rev ?? '',
          ].join(':');
        }
        if (item.type === 'project') {
          return [
            'project',
            item.project.id,
            item.project.status,
            item.project.reviewAt ?? '',
            item.project.updatedAt ?? '',
          ].join(':');
        }
        return ['group', item.id, item.count].join(':');
      }).join(',');
      return [section.type, section.expanded ? 'expanded' : 'collapsed', section.totalCount, itemVersion].join('|');
    }).join('||')
  ), [sections]);
  const firstVisibleSectionType = useMemo(
    () => sections.find((section) => section.totalCount > 0)?.type ?? null,
    [sections]
  );
  const hasTasks = focusedTasks.length > 0 || schedule.length > 0 || nextActions.length > 0 || reviewDue.length > 0 || reviewDueProjects.length > 0;
  const activeFilterCount = countFilterCriteria(effectiveFilterCriteria);
  const advancedFilterChips = useMemo<FocusFilterChip[]>(() => {
    if (!activeSavedFilter) return [];
    return buildAdvancedFilterCriteriaChips(effectiveFilterCriteria, {
      getAreaLabel: (areaId) => areaById.get(areaId)?.name,
      resolveText,
    }).map((chip) => ({
      id: `advanced:${chip.id}`,
      label: chip.label,
      onPress: () => confirmRemoveAdvancedSavedFilterCriterion(chip.id, chip.label),
      variant: 'advanced',
    }));
  }, [activeSavedFilter, areaById, confirmRemoveAdvancedSavedFilterCriterion, effectiveFilterCriteria, resolveText]);
  const activeFilterChips = useMemo(() => {
    const chips: FocusFilterChip[] = [];
    selectedTokens.forEach((token) => {
      chips.push({
        id: `token:${token}`,
        label: token,
        onPress: () => toggleToken(token),
      });
    });
    selectedProjects.forEach((projectId) => {
      if (projectId === NO_PROJECT_FILTER_ID) {
        chips.push({
          id: `project:${projectId}`,
          label: resolveText('taskEdit.noProjectOption', 'No project'),
          onPress: () => toggleProject(projectId),
        });
        return;
      }
      const project = projectById.get(projectId);
      if (!project) return;
      chips.push({
        id: `project:${project.id}`,
        label: project.title,
        onPress: () => toggleProject(project.id),
      });
    });
    (showPriorityFilters ? selectedPriorities : []).forEach((priority) => {
      chips.push({
        id: `priority:${priority}`,
        label: t(`priority.${priority}`),
        onPress: () => togglePriority(priority),
      });
    });
    (showEnergyLevelFilters ? selectedEnergyLevels : []).forEach((energyLevel) => {
      chips.push({
        id: `energy:${energyLevel}`,
        label: t(`energyLevel.${energyLevel}`),
        onPress: () => toggleEnergyLevel(energyLevel),
      });
    });
    (showTimeEstimateFilters ? selectedTimeEstimates : []).forEach((estimate) => {
      chips.push({
        id: `time:${estimate}`,
        label: formatFocusTimeEstimateLabel(estimate),
        onPress: () => toggleTimeEstimate(estimate),
      });
    });
    const normalizedLocationFilter = locationFilter.trim();
    if (showLocationFilter && normalizedLocationFilter && !activeSavedFilter) {
      chips.push({
        id: `location:${normalizedLocationFilter}`,
        label: `${resolveText('taskEdit.locationLabel', 'Location')}: ${normalizedLocationFilter}`,
        onPress: () => updateLocationFilter(''),
      });
    }
    chips.push(...advancedFilterChips);
    return chips;
  }, [
    activeSavedFilter,
    advancedFilterChips,
    locationFilter,
    projectById,
    resolveText,
    showEnergyLevelFilters,
    showLocationFilter,
    showPriorityFilters,
    showTimeEstimateFilters,
    selectedEnergyLevels,
    selectedPriorities,
    selectedProjects,
    selectedTimeEstimates,
    selectedTokens,
    t,
    toggleEnergyLevel,
    togglePriority,
    toggleProject,
    toggleTimeEstimate,
    toggleToken,
    updateLocationFilter,
  ]);
  const openSaveFilterDialog = useCallback(() => {
    const defaultName = activeFilterChips.slice(0, 3).map((chip) => chip.label).join(' + ')
      || resolveText('savedFilters.defaultName', 'Focus filter');
    setSaveFilterName(defaultName);
    setSaveFilterDialogVisible(true);
  }, [activeFilterChips, resolveText]);
  const selectedContextCount = useMemo(
    () => selectedTokens.filter((token) => token.trim().startsWith('@')).length,
    [selectedTokens],
  );
  const showContextMatchMode = selectedContextCount > 1;
  const emptyTitle = hasFilters ? resolveText('filters.noMatch', 'No tasks match these filters.') : t('agenda.allClear');
  const emptySubtitle = hasFilters ? resolveText('filters.label', 'Filters') : t('agenda.noTasks');
  const pomodoroTasks = useMemo(() => {
    const byId = new Map<string, Task>();
    [...focusedTasks, ...schedule, ...nextActions, ...reviewDue].forEach((task) => {
      if (task.deletedAt) return;
      byId.set(task.id, task);
    });
    return Array.from(byId.values());
  }, [focusedTasks, schedule, nextActions, reviewDue]);

  const onEdit = useCallback((task: Task) => {
    setTaskModalDefaultTab('view');
    setTaskModalOpenKey(`manual:${task.id}`);
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  }, [updateTask]);

  const toggleSection = useCallback((sectionType: FocusSectionType) => {
    didToggleSectionRef.current = true;
    setExpandedSections((current) => {
      const next = {
        ...current,
        [sectionType]: !current[sectionType],
      };
      AsyncStorage.setItem(FOCUS_VIEW_STATE_STORAGE_KEY, serializeFocusViewState(next)).catch(() => {});
      return next;
    });
  }, []);
  const renderFilterChip = useCallback((label: string, selected: boolean, onPress?: () => void, key = label, variant?: FocusFilterChip['variant']) => {
    const isAdvanced = variant === 'advanced';
    const chipStyle = [
      styles.filterChip,
      isAdvanced ? styles.filterChipAdvanced : null,
      {
        backgroundColor: isAdvanced ? tc.filterBg : selected ? tc.tint : tc.filterBg,
        borderColor: isAdvanced ? tc.tint : selected ? tc.tint : tc.border,
      },
    ];
    const textColor = isAdvanced ? tc.tint : selected ? tc.onTint : tc.text;
    const chipText = (
      <CompactText
        style={[styles.filterChipText, { color: textColor }]}
        numberOfLines={2}
      >
        {label}
      </CompactText>
    );

    if (!onPress) {
      return (
        <View key={key} style={chipStyle}>
          {chipText}
        </View>
      );
    }

    if (isAdvanced) {
      return (
        <View key={key} style={chipStyle}>
          {chipText}
          <TouchableOpacity
            accessibilityLabel={`${resolveText('common.delete', 'Delete')} ${label}`}
            accessibilityRole="button"
            hitSlop={8}
            onPress={onPress}
            style={styles.filterChipAction}
          >
            <X size={16} color={textColor} />
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <TouchableOpacity
        key={key}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={chipStyle}
      >
        {chipText}
      </TouchableOpacity>
    );
  }, [resolveText, tc.border, tc.filterBg, tc.onTint, tc.text, tc.tint]);

  const renderItem = ({ item, section }: { item: FocusListItem; section: FocusSection }) => {
    if (item.type === 'groupHeader') {
      return (
        <View
          accessible
          accessibilityRole="header"
          accessibilityLabel={`${item.title} ${item.count}`}
          style={styles.contextGroupHeader}
        >
          <View
            style={[
              styles.contextGroupDot,
              { backgroundColor: item.muted ? tc.secondaryText : tc.tint },
            ]}
          />
          <Text
            style={[
              styles.contextGroupTitle,
              { color: item.muted ? tc.secondaryText : tc.text },
            ]}
          >
            {item.title}
          </Text>
          <Text style={[styles.contextGroupCount, { color: tc.secondaryText }]}>
            {item.count}
          </Text>
        </View>
      );
    }

    if (item.type === 'project') {
      const project = item.project;
      return (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`${resolveText('common.open', 'Open')} ${project.title}`}
          onPress={() => openProjectScreen(project.id)}
          style={[
            styles.projectReviewCard,
            { backgroundColor: tc.cardBg, borderColor: tc.border },
          ]}
        >
          <View style={styles.projectReviewMain}>
            <View style={[styles.projectReviewIcon, { backgroundColor: project.color || tc.tint }]}>
              <Folder size={18} color="#fff" />
            </View>
            <View style={styles.projectReviewTextBlock}>
              <Text numberOfLines={1} style={[styles.projectReviewTitle, { color: tc.text }]}>
                {project.title}
              </Text>
              <Text style={[styles.projectReviewStatus, { color: tc.secondaryText }]}>
                {t(`status.${project.status}`)}
              </Text>
            </View>
          </View>
          {project.reviewAt ? (
            <Text style={[styles.projectReviewDate, { color: tc.secondaryText }]}>
              {safeFormatDate(project.reviewAt, 'P')}
            </Text>
          ) : null}
        </TouchableOpacity>
      );
    }

    const canMarkReviewed = section.type === 'reviewDue' && Boolean(item.task.reviewAt);
    const canDeferTask = !canMarkReviewed && !item.task.dueDate && (item.task.isFocusedToday === true || item.task.status === 'next');
    const longPressAction = canMarkReviewed
      ? () => openReviewMenu(item.task)
      : canDeferTask
        ? () => openDeferMenu(item.task)
        : undefined;
    const longPressActionLabel = canMarkReviewed
      ? resolveText('review.markReviewed', 'Mark reviewed')
      : canDeferTask
        ? resolveText('review.startTime', 'Defer until')
        : undefined;
    const projectDeadlineLabel = getProjectDeadlineBoostLabel(
      projectDeadlineBoosts.get(item.task.id),
      resolveText,
    );

    return (
      <View
        style={[
          styles.itemWrapper,
          item.grouped ? [styles.contextGroupTaskWrapper, { borderLeftColor: tc.border }] : null,
        ]}
      >
        <SwipeableTaskItem
          task={item.task}
          isDark={isDark}
          tc={tc}
          onPress={() => onEdit(item.task)}
          onStatusChange={(status) => updateTask(item.task.id, { status: status as TaskStatus })}
          onDelete={() => { void deleteTask(item.task.id); }}
          isHighlighted={item.task.id === highlightTaskId}
          showFocusToggle
          hideStatusBadge={section.type !== 'reviewDue'}
          projectDeadlineLabel={projectDeadlineLabel}
          onLongPressAction={longPressAction}
          onLongPressActionLabel={longPressActionLabel}
          onProjectPress={openProjectScreen}
          onContextPress={openContextsScreen}
          onTagPress={openContextsScreen}
        />
      </View>
    );
  };
  const listBottomPadding = FOCUS_LIST_BOTTOM_CLEARANCE + Math.max(0, insets.bottom);

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <SectionList
        sections={sections}
        extraData={focusListVersion}
        keyExtractor={(item) => item.type === 'task' ? item.task.id : item.type === 'project' ? `project:${item.project.id}` : item.id}
        stickySectionHeadersEnabled={false}
        initialNumToRender={FOCUS_LIST_INITIAL_RENDER_COUNT}
        maxToRenderPerBatch={FOCUS_LIST_BATCH_RENDER_COUNT}
        windowSize={FOCUS_LIST_WINDOW_SIZE}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: listBottomPadding },
        ]}
        scrollIndicatorInsets={{ bottom: listBottomPadding }}
        refreshControl={(
          <RefreshControl
            refreshing={pullSync.refreshing}
            onRefresh={pullSync.onRefresh}
            tintColor="transparent"
            colors={['transparent']}
            progressBackgroundColor="transparent"
          />
        )}
        ListHeaderComponent={(
          <View style={styles.header}>
            {pomodoroEnabled && (
              <PomodoroPanel
                tasks={pomodoroTasks}
                onMarkDone={(id) => updateTask(id, { status: 'done', isFocusedToday: false })}
              />
            )}
            <View style={styles.headerTopRow}>
              <View style={styles.headerTextBlock}>
                <Text style={[styles.dateText, { color: tc.secondaryText }]}>
                  {safeFormatDate(new Date(), 'PPPP')}
                </Text>
              </View>
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityLabel={resolveText('filters.label', 'Filters')}
                  accessibilityRole="button"
                  onPress={() => setFiltersVisible(true)}
                  style={({ pressed }) => [
                    styles.filterButton,
                    {
                      opacity: pressed ? 0.78 : 1,
                    },
                  ]}
                >
                  <SlidersHorizontal size={20} color={hasFilters ? tc.tint : tc.secondaryText} />
                  {hasFilters ? (
                    <View style={[styles.filterBadge, { backgroundColor: tc.tint }]}>
                      <Text style={[styles.filterBadgeText, { color: tc.onTint }]}>
                        {activeFilterCount}
                      </Text>
                    </View>
                  ) : null}
                </Pressable>
              </View>
            </View>
            {savedFocusFilters.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.savedFiltersRow}
                style={styles.savedFiltersScroller}
              >
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ selected: !hasFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY }}
                  onPress={clearFilters}
                  style={[
                    styles.savedFilterChip,
                    {
                      borderColor: !hasFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY ? tc.tint : tc.border,
                      backgroundColor: !hasFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY ? tc.tint : tc.filterBg,
                    },
                  ]}
                >
                  <Text style={[styles.savedFilterChipText, { color: !hasFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY ? tc.onTint : tc.text }]}>
                    {resolveText('common.all', 'All')}
                  </Text>
                </TouchableOpacity>
                {savedFocusFilters.map((filter) => {
                  const selected = activeSavedFilterId === filter.id;
                  return (
                    <View key={filter.id} style={styles.savedFilterChipGroup}>
                      <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        onPress={() => applySavedFocusFilter(filter)}
                        style={[
                          styles.savedFilterChip,
                          selected ? styles.savedFilterChipAttached : null,
                          {
                            borderColor: selected ? tc.tint : tc.border,
                            backgroundColor: selected ? tc.tint : tc.filterBg,
                          },
                        ]}
                      >
                        <CompactText
                          style={[styles.savedFilterChipText, { color: selected ? tc.onTint : tc.text }]}
                          numberOfLines={2}
                        >
                          {filter.icon ? `${filter.icon} ` : ''}{filter.name}
                        </CompactText>
                      </TouchableOpacity>
                      {selected ? (
                        <TouchableOpacity
                          accessibilityRole="button"
                          accessibilityLabel={`${resolveText('common.delete', 'Delete')} ${resolveText('savedFilters.label', 'saved filter')} ${filter.name}`}
                          onPress={() => confirmDeleteSavedFilter(filter)}
                          style={[
                            styles.savedFilterDeleteChip,
                            { borderColor: tc.tint, backgroundColor: tc.tint },
                          ]}
                        >
                          <X size={14} color={tc.onTint} />
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
            ) : null}
            {hasFilters ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.activeChipsRow}
                style={styles.activeChipsScroller}
              >
                {activeFilterChips.map((chip) => renderFilterChip(chip.label, true, chip.onPress, chip.id, chip.variant))}
                <TouchableOpacity onPress={clearFilters} style={styles.clearFiltersButton}>
                  <Text style={[styles.clearFiltersText, { color: tc.secondaryText }]}>
                    {resolveText('filters.clear', 'Clear')}
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            ) : null}
            {hiddenFutureStartCount > 0 ? (
              <View style={[styles.futureStartNotice, { borderColor: tc.border, backgroundColor: tc.cardBg }]}>
                <View style={styles.futureStartCopy}>
                  <Text style={[styles.futureStartText, { color: tc.secondaryText }]}>
                    {formatFutureStartNotice(hiddenFutureStartCount, showFutureStarts)}
                  </Text>
                  {futureStartPreview ? (
                    <Text style={[styles.futureStartPreview, { color: tc.text }]} numberOfLines={2}>
                      {futureStartPreview}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={toggleFutureStarts}
                  style={styles.futureStartButton}
                >
                  <Text style={[styles.futureStartButtonText, { color: tc.tint }]}>
                    {showFutureStarts
                      ? resolveText('agenda.hideFutureStarts', 'Hide')
                      : resolveText('agenda.showFutureStarts', 'Show')}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        )}
        renderSectionHeader={({ section }) => (
          section.totalCount > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={section.title}
              accessibilityState={{ expanded: section.expanded }}
              onPress={() => toggleSection(section.type)}
              style={[
                styles.sectionHeader,
                section.type === firstVisibleSectionType ? styles.firstSectionHeader : null,
              ]}
            >
              <Text style={[styles.sectionChevron, { color: tc.secondaryText }]}>
                {section.expanded ? '▾' : '▸'}
              </Text>
              <CompactText
                style={[styles.sectionTitle, { color: tc.tint }]}
                numberOfLines={2}
              >
                {section.title}
              </CompactText>
              <CompactText
                style={[styles.sectionCount, { color: tc.secondaryText }]}
              >
                ({section.totalCount})
              </CompactText>
              <View style={[styles.sectionLine, { backgroundColor: tc.border }]} />
            </Pressable>
          ) : null
        )}
        renderItem={renderItem}
        ListEmptyComponent={!hasTasks ? (
          <View style={styles.emptyState}>
            <CompactText
              style={[styles.emptyTitle, { color: tc.text }]}
              numberOfLines={2}
            >
              {emptyTitle}
            </CompactText>
            <CompactText
              style={[styles.emptySubtitle, { color: tc.secondaryText }]}
              numberOfLines={3}
            >
              {emptySubtitle}
            </CompactText>
          </View>
        ) : null}
        removeClippedSubviews={false}
      />
      <PullSyncIndicator state={pullSync.indicatorState} />
      <Modal
        animationType="fade"
        transparent
        visible={filtersVisible}
        onRequestClose={() => setFiltersVisible(false)}
      >
        <View style={styles.sheetRoot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={resolveText('common.close', 'Close')}
            onPress={() => setFiltersVisible(false)}
            style={styles.sheetBackdrop}
          />
          <View style={[styles.sheet, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: tc.text }]}>
                {resolveText('filters.label', 'Filters')}
              </Text>
              <View style={styles.sheetHeaderActions}>
                {canSaveFocusPerspective ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={openSaveFilterDialog}
                    style={styles.sheetSaveButton}
                  >
                    <BookmarkPlus size={16} color={tc.tint} />
                    <Text style={[styles.sheetTextButtonText, { color: tc.tint }]}>
                      {resolveText('savedFilters.save', 'Save')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                {hasFilters ? (
                  <TouchableOpacity accessibilityRole="button" onPress={clearFilters} style={styles.sheetTextButton}>
                    <Text style={[styles.sheetTextButtonText, { color: tc.tint }]}>
                      {resolveText('filters.clear', 'Clear')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={resolveText('common.close', 'Close')}
                  onPress={() => setFiltersVisible(false)}
                  style={styles.sheetIconButton}
                >
                  <X size={18} color={tc.secondaryText} />
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                {resolveText('sort.label', 'Sort')}
              </Text>
              <View style={styles.sheetChipRow}>
                {FOCUS_SORT_OPTIONS.map((sortBy) => renderFilterChip(
                  getFocusSortByLabel(sortBy),
                  effectiveFocusSortBy === sortBy,
                  () => updateFocusSortBy(sortBy),
                  `sort:${sortBy}`,
                ))}
              </View>

              <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                {resolveText('focus.groupBy', 'Group by')}
              </Text>
              <View style={styles.sheetChipRow}>
                {FOCUS_GROUP_BY_OPTIONS.map((groupBy) => renderFilterChip(
                  getFocusGroupByLabel(groupBy),
                  effectiveFocusGroupBy === groupBy,
                  () => updateFocusGroupBy(groupBy),
                  `group:${groupBy}`,
                ))}
              </View>

              {activeFilterChips.length > 0 ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.active', 'Active filters')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {activeFilterChips.map((chip) => renderFilterChip(chip.label, true, chip.onPress, chip.id, chip.variant))}
                  </View>
                </>
              ) : null}
              {tokenOptions.length > 0 ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.contexts', 'Contexts & tags')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {tokenOptions.map((token) => renderFilterChip(token, selectedTokens.includes(token), () => toggleToken(token)))}
                  </View>
                  {showContextMatchMode ? (
                    <View style={styles.matchModeRow}>
                      <Text style={[styles.matchModeLabel, { color: tc.secondaryText }]}>
                        {resolveText('filters.contextMatchMode', 'Context match')}
                      </Text>
                      <View style={[styles.matchModeControl, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                        {(['any', 'all'] as const).map((mode) => (
                          <TouchableOpacity
                            key={mode}
                            accessibilityRole="button"
                            accessibilityState={{ selected: effectiveContextMatchMode === mode }}
                            onPress={() => updateContextMatchMode(mode)}
                            style={[
                              styles.matchModeButton,
                              { backgroundColor: effectiveContextMatchMode === mode ? tc.tint : 'transparent' },
                            ]}
                          >
                            <Text
                              style={[
                                styles.matchModeButtonText,
                                { color: effectiveContextMatchMode === mode ? tc.onTint : tc.secondaryText },
                              ]}
                            >
                              {mode === 'any' ? resolveText('filters.matchAny', 'Any') : resolveText('common.all', 'All')}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  ) : null}
                </>
              ) : null}

              {(showNoProjectOption || projectOptions.length > 0) ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.projects', 'Projects')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {showNoProjectOption ? renderFilterChip(
                      resolveText('taskEdit.noProjectOption', 'No project'),
                      selectedProjects.includes(NO_PROJECT_FILTER_ID),
                      () => toggleProject(NO_PROJECT_FILTER_ID),
                    ) : null}
                    {projectOptions.map((project) => (
                      renderFilterChip(project.title, selectedProjects.includes(project.id), () => toggleProject(project.id))
                    ))}
                  </View>
                </>
              ) : null}

              {showLocationFilter ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('taskEdit.locationLabel', 'Location')}
                  </Text>
                  <TextInput
                    value={locationFilter}
                    onChangeText={updateLocationFilter}
                    placeholder={resolveText('taskEdit.locationPlaceholder', 'e.g. Office')}
                    placeholderTextColor={tc.secondaryText}
                    accessibilityLabel={resolveText('taskEdit.locationLabel', 'Location')}
                    style={[styles.sheetInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.bg }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                </>
              ) : null}

              {showPriorityFilters ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.priority', 'Priority')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {PRIORITY_OPTIONS.map((priority) => (
                      renderFilterChip(t(`priority.${priority}`), selectedPriorities.includes(priority), () => togglePriority(priority))
                    ))}
                  </View>
                </>
              ) : null}

              {showEnergyLevelFilters ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('taskEdit.energyLevel', 'Energy level')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {ENERGY_LEVEL_OPTIONS.map((energyLevel) => (
                      renderFilterChip(t(`energyLevel.${energyLevel}`), selectedEnergyLevels.includes(energyLevel), () => toggleEnergyLevel(energyLevel))
                    ))}
                  </View>
                </>
              ) : null}

              {showTimeEstimateFilters && effectiveTimeEstimatePresets.length > 0 ? (
                <>
                  <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                    {resolveText('filters.timeEstimate', 'Time estimate')}
                  </Text>
                  <View style={styles.sheetChipRow}>
                    {effectiveTimeEstimatePresets.map((estimate) => (
                      renderFilterChip(
                        formatFocusTimeEstimateLabel(estimate),
                        selectedTimeEstimates.includes(estimate),
                        () => toggleTimeEstimate(estimate),
                      )
                    ))}
                  </View>
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        animationType="fade"
        transparent
        visible={saveFilterDialogVisible}
        onRequestClose={() => setSaveFilterDialogVisible(false)}
      >
        <View style={styles.dialogRoot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={resolveText('common.cancel', 'Cancel')}
            onPress={() => setSaveFilterDialogVisible(false)}
            style={styles.sheetBackdrop}
          />
          <View style={[styles.dialog, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.dialogTitle, { color: tc.text }]}>
              {resolveText('savedFilters.saveTitle', 'Save filter')}
            </Text>
            <TextInput
              autoFocus
              value={saveFilterName}
              onChangeText={setSaveFilterName}
              placeholder={resolveText('savedFilters.namePlaceholder', 'Filter name')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.dialogInput, { borderColor: tc.border, color: tc.text, backgroundColor: tc.bg }]}
              returnKeyType="done"
              onSubmitEditing={saveCurrentFilter}
            />
            <View style={styles.dialogActions}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setSaveFilterDialogVisible(false)}
                style={styles.dialogButton}
              >
                <Text style={[styles.dialogButtonText, { color: tc.secondaryText }]}>
                  {resolveText('common.cancel', 'Cancel')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={saveCurrentFilter}
                disabled={!saveFilterName.trim()}
                style={[
                  styles.dialogButton,
                  styles.dialogPrimaryButton,
                  { backgroundColor: saveFilterName.trim() ? filledButton.backgroundColor : tc.filterBg },
                ]}
              >
                <Text style={[styles.dialogButtonText, { color: saveFilterName.trim() ? (filledButton.textColor ?? tc.onTint) : tc.secondaryText }]}>
                  {resolveText('common.save', 'Save')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {deferPickerTask && Platform.OS === 'ios' ? (
        <Modal
          animationType="fade"
          transparent
          visible
          onRequestClose={closeDeferDatePicker}
        >
          <View style={styles.sheetRoot}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={resolveText('common.cancel', 'Cancel')}
              onPress={closeDeferDatePicker}
              style={styles.sheetBackdrop}
            />
            <View style={[styles.sheet, styles.deferPickerSheet, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
              <View style={styles.sheetHeader}>
                <Text style={[styles.sheetTitle, { color: tc.text }]}>
                  {resolveText('review.startTime', 'Defer until')}
                </Text>
                <View style={styles.sheetHeaderActions}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={closeDeferDatePicker}
                    style={styles.sheetTextButton}
                  >
                    <Text style={[styles.sheetTextButtonText, { color: tc.secondaryText }]}>
                      {resolveText('common.cancel', 'Cancel')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={confirmPickedDeferDate}
                    style={styles.sheetTextButton}
                  >
                    <Text style={[styles.sheetTextButtonText, { color: tc.tint }]}>
                      {resolveText('common.done', 'Done')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
              <Text
                numberOfLines={1}
                style={[styles.deferPickerTaskTitle, { color: tc.secondaryText }]}
              >
                {deferPickerTask.title}
              </Text>
              <DateTimePicker
                value={deferPickerDate}
                mode="date"
                display="inline"
                minimumDate={getStartDateOffset(1)}
                onChange={handleDeferDateChange}
              />
            </View>
          </View>
        </Modal>
      ) : null}
      {deferPickerTask && Platform.OS !== 'ios' ? (
        <DateTimePicker
          value={deferPickerDate}
          mode="date"
          display="default"
          minimumDate={getStartDateOffset(1)}
          onChange={handleDeferDateChange}
        />
      ) : null}
      <TaskEditModal
        key={taskModalOpenKey}
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={onSaveTask}
        defaultTab={taskModalDefaultTab}
        onProjectNavigate={openProjectScreen}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingBottom: 110,
  },
  header: {
    marginTop: 6,
    marginBottom: 0,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  subtitleText: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  savedFiltersScroller: {
    marginTop: 10,
    marginHorizontal: -4,
  },
  savedFiltersRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  savedFilterChipGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  savedFilterChip: {
    maxWidth: 180,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  savedFilterChipAttached: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  savedFilterChipText: {
    fontSize: 12,
    fontWeight: '700',
  },
  savedFilterDeleteChip: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderLeftWidth: 0,
    borderTopRightRadius: 22,
    borderBottomRightRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeChipsScroller: {
    marginTop: 8,
    marginHorizontal: -4,
  },
  activeChipsRow: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  filterButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  filterBadge: {
    position: 'absolute',
    top: 5,
    right: 5,
    minWidth: 16,
    height: 16,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  filterBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 22,
    flexBasis: 104,
    flexGrow: 1,
    flexShrink: 1,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  filterChipAdvanced: {
    borderStyle: 'dashed',
  },
  filterChipAction: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'center',
  },
  clearFiltersButton: {
    justifyContent: 'center',
    paddingHorizontal: 8,
    minHeight: 44,
  },
  clearFiltersText: {
    fontSize: 12,
    fontWeight: '600',
  },
  futureStartNotice: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  futureStartCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  futureStartText: {
    fontSize: 12,
    fontWeight: '600',
  },
  futureStartPreview: {
    fontSize: 13,
    fontWeight: '600',
  },
  futureStartButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  futureStartButtonText: {
    fontSize: 13,
    fontWeight: '700',
  },
  dateText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
    marginBottom: 10,
  },
  firstSectionHeader: {
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    flexShrink: 1,
    minWidth: 0,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionChevron: {
    fontSize: 12,
    width: 14,
    textAlign: 'center',
  },
  sectionCount: {
    fontSize: 12,
    fontWeight: '600',
  },
  sectionLine: {
    flex: 1,
    minWidth: 24,
    height: 1,
    borderRadius: 1,
  },
  contextGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  contextGroupDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  contextGroupTitle: {
    fontSize: 17,
    fontWeight: '800',
  },
  contextGroupCount: {
    fontSize: 12,
    fontWeight: '700',
  },
  contextGroupTaskWrapper: {
    marginLeft: 13,
    paddingLeft: 10,
    borderLeftWidth: 2,
  },
  itemWrapper: {
    marginBottom: 8,
  },
  projectReviewCard: {
    minHeight: 72,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  projectReviewMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  projectReviewIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  projectReviewTextBlock: {
    flex: 1,
    minWidth: 0,
  },
  projectReviewTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  projectReviewStatus: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '600',
  },
  projectReviewDate: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: '700',
  },
  emptyState: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  emptySubtitle: {
    marginTop: 4,
    fontSize: 12,
    fontWeight: '600',
  },
  sheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 20,
    maxHeight: '78%',
  },
  deferPickerSheet: {
    maxHeight: '70%',
  },
  deferPickerTaskTitle: {
    marginBottom: 8,
    fontSize: 13,
    fontWeight: '600',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  sheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sheetTextButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sheetSaveButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sheetTextButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  sheetIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetScroll: {
    maxHeight: '100%',
  },
  sheetContent: {
    gap: 14,
    paddingBottom: 12,
  },
  sheetSectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sheetChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  matchModeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  matchModeLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  matchModeControl: {
    minHeight: 36,
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 18,
    padding: 2,
  },
  matchModeButton: {
    minWidth: 52,
    minHeight: 30,
    flexGrow: 1,
    flexShrink: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    paddingHorizontal: 10,
  },
  matchModeButtonText: {
    fontSize: 12,
    fontWeight: '700',
  },
  sheetInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  dialogRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  dialog: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
  },
  dialogTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  dialogInput: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  dialogActions: {
    marginTop: 14,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  dialogButton: {
    minHeight: 44,
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
  },
  dialogPrimaryButton: {
    paddingHorizontal: 14,
  },
  dialogButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
