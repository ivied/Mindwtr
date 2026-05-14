import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
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
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { BookmarkPlus, Plus, SlidersHorizontal, X } from 'lucide-react-native';

import {
  applyFilter,
  buildAdvancedFilterCriteriaChips,
  removeAdvancedFilterCriteriaChip,
  sortFocusNextActions,
  shouldShowTaskForStart,
  getFocusSequentialFirstTaskIds,
  generateUUID,
  hasActiveFilterCriteria,
  markSavedFilterDeleted,
  normalizeFocusTaskLimit,
  SAVED_FILTER_NO_PROJECT_ID,
  translateWithFallback,
  useTaskStore,
  isDueForReview,
  safeFormatDate,
  safeParseDate,
  safeParseDueDate,
  type Task,
  type TaskStatus,
  type TaskPriority,
  type TaskEnergyLevel,
  type TimeEstimate,
  type FilterCriteria,
  type SavedFilter,
} from '@mindwtr/core';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useTheme } from '../../../contexts/theme-context';
import { useLanguage } from '../../../contexts/language-context';
import { TaskEditModal } from '@/components/task-edit-modal';
import { PomodoroPanel } from '@/components/pomodoro-panel';
import {
  formatFocusTimeEstimateLabel,
  getFocusTokenOptions,
  splitFocusedTasks,
} from '@/lib/focus-screen-utils';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { projectMatchesAreaFilter, taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';

const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];
const ALL_TIME_ESTIMATE_OPTIONS: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const DEFAULT_TIME_ESTIMATE_PRESETS: TimeEstimate[] = ['10min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
const NO_PROJECT_FILTER_ID = SAVED_FILTER_NO_PROJECT_ID;
const FOCUS_LIST_INITIAL_RENDER_COUNT = 12;
const FOCUS_LIST_BATCH_RENDER_COUNT = 12;
const FOCUS_LIST_WINDOW_SIZE = 5;

type FocusFilterChip = {
  id: string;
  label: string;
  onPress?: () => void;
  variant?: 'advanced';
};

function filterSelectionStable<T>(current: T[], predicate: (item: T) => boolean): T[] {
  const next = current.filter(predicate);
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
}

function buildFocusFilterCriteria({
  energyLevels,
  priorities,
  projects,
  timeEstimates,
  tokens,
}: {
  energyLevels: TaskEnergyLevel[];
  priorities: TaskPriority[];
  projects: string[];
  timeEstimates: TimeEstimate[];
  tokens: string[];
}): FilterCriteria {
  const contexts = tokens.filter((token) => token.trim().startsWith('@'));
  const tags = tokens.filter((token) => token.trim().startsWith('#'));
  return {
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(projects.length > 0 ? { projects } : {}),
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
    + (criteria.timeEstimates?.length ?? 0)
    + (criteria.dueDateRange ? 1 : 0)
    + (criteria.startDateRange ? 1 : 0)
    + (criteria.timeEstimateRange ? 1 : 0)
    + (criteria.hasDescription !== undefined ? 1 : 0)
    + (criteria.isStarred !== undefined ? 1 : 0)
  );
}

export default function FocusScreen() {
  const { taskId, openToken } = useLocalSearchParams<{ taskId?: string; openToken?: string }>();
  const { tasks, projects, settings, updateTask, deleteTask, updateSettings, highlightTaskId, setHighlightTask } = useTaskStore();
  const { isDark } = useTheme();
  const { t } = useLanguage();
  const tc = useThemeColors();
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const [saveFilterDialogVisible, setSaveFilterDialogVisible] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');
  const showFutureStarts = settings?.appearance?.showFutureStarts === true;
  const [expandedSections, setExpandedSections] = useState({
    focus: true,
    schedule: true,
    next: true,
    reviewDue: true,
  });
  const lastOpenedFromNotificationRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pomodoroEnabled = settings?.features?.pomodoro === true;
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const visibleProjects = useMemo(() => (
    projects.filter((project) => !project.deletedAt && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
  ), [projects, resolvedAreaFilter, areaById]);
  const visibleTasks = useMemo(() => (
    tasks.filter((task) => taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById))
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
  const hiddenFutureStartCount = useMemo(() => (
    baseActiveTasks.filter((task) => !shouldShowTaskForStart(task, { showFutureStarts: false })).length
  ), [baseActiveTasks]);
  const tokenOptions = useMemo(() => getFocusTokenOptions(activeTasks), [activeTasks]);
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
  const currentFilterCriteria = useMemo(() => buildFocusFilterCriteria({
    tokens: selectedTokens,
    projects: selectedProjects,
    priorities: prioritiesEnabled ? selectedPriorities : [],
    energyLevels: selectedEnergyLevels,
    timeEstimates: timeEstimatesEnabled ? selectedTimeEstimates : [],
  }), [
    prioritiesEnabled,
    selectedEnergyLevels,
    selectedPriorities,
    selectedProjects,
    selectedTimeEstimates,
    selectedTokens,
    timeEstimatesEnabled,
  ]);
  const rawEffectiveFilterCriteria = activeSavedFilter?.criteria ?? currentFilterCriteria;
  const effectiveFilterCriteria = useMemo<FilterCriteria>(() => ({
    ...rawEffectiveFilterCriteria,
    ...(prioritiesEnabled ? {} : { priority: undefined }),
    ...(timeEstimatesEnabled ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
  }), [prioritiesEnabled, rawEffectiveFilterCriteria, timeEstimatesEnabled]);
  const hasCurrentFilterCriteria = hasActiveFilterCriteria(currentFilterCriteria);
  const hasFilters = hasActiveFilterCriteria(effectiveFilterCriteria);
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
  const clearFilters = useCallback(() => {
    setActiveSavedFilterId(null);
    setSelectedTokens([]);
    setSelectedProjects([]);
    setSelectedPriorities([]);
    setSelectedEnergyLevels([]);
    setSelectedTimeEstimates([]);
  }, []);
  const applySavedFocusFilter = useCallback((filter: SavedFilter) => {
    const criteria = filter.criteria ?? {};
    const prioritySet = new Set<TaskPriority>(PRIORITY_OPTIONS);
    const energySet = new Set<TaskEnergyLevel>(ENERGY_LEVEL_OPTIONS);
    const estimateSet = new Set<TimeEstimate>(ALL_TIME_ESTIMATE_OPTIONS);
    setSelectedTokens([...(criteria.contexts ?? []), ...(criteria.tags ?? [])]);
    setSelectedProjects(criteria.projects ?? []);
    setSelectedPriorities((criteria.priority ?? []).filter((priority): priority is TaskPriority => (
      priority !== 'none' && prioritySet.has(priority)
    )));
    setSelectedEnergyLevels((criteria.energy ?? []).filter((energy): energy is TaskEnergyLevel => energySet.has(energy)));
    setSelectedTimeEstimates((criteria.timeEstimates ?? []).filter((estimate): estimate is TimeEstimate => estimateSet.has(estimate)));
    setActiveSavedFilterId(filter.id);
    setFiltersVisible(false);
  }, []);
  const saveCurrentFilter = useCallback(() => {
    const trimmedName = saveFilterName.trim();
    if (!trimmedName || !hasCurrentFilterCriteria) return;
    const nowIso = new Date().toISOString();
    const nextFilter: SavedFilter = {
      id: generateUUID(),
      name: trimmedName,
      view: 'focus',
      criteria: currentFilterCriteria,
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
  }, [currentFilterCriteria, hasCurrentFilterCriteria, saveFilterName, settings?.savedFilters, updateSettings]);
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
    if (!taskId || typeof taskId !== 'string') return;
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}`;
    if (lastOpenedFromNotificationRef.current === openKey) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task) return;
    lastOpenedFromNotificationRef.current = openKey;
    setHighlightTask(task.id);
    setEditingTask(task);
    setIsModalVisible(true);
  }, [openToken, setHighlightTask, taskId, tasks]);

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
    if (prioritiesEnabled) return;
    if (selectedPriorities.length === 0) return;
    setSelectedPriorities([]);
  }, [prioritiesEnabled, selectedPriorities.length]);

  useEffect(() => {
    if (timeEstimatesEnabled) return;
    if (selectedTimeEstimates.length === 0) return;
    setSelectedTimeEstimates([]);
  }, [selectedTimeEstimates.length, timeEstimatesEnabled]);

  const sequentialProjectIds = useMemo(() => {
    return new Set(visibleProjects.filter((project) => project.isSequential).map((project) => project.id));
  }, [visibleProjects]);

  const { focusedTasks, schedule, nextActions, reviewDue } = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const { focusedTasks: allFocusedTasks, otherTasks: nonFocusedTasks } = splitFocusedTasks(filteredActiveTasks);
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, { now });

    const isSequentialBlocked = (task: Task) => {
      if (!task.projectId) return false;
      if (!sequentialProjectIds.has(task.projectId)) return false;
      return !sequentialFirstTaskIds.has(task.id);
    };

    const scheduleItems = nonFocusedTasks.filter((task) => {
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
      if (task.status !== 'next') return false;
      if (isSequentialBlocked(task)) return false;
      return !scheduleIds.has(task.id);
    });

    const reviewDueItems = nonFocusedTasks
      .filter((task) => isDueForReview(task.reviewAt, now))
      .sort((a, b) => {
        const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
        if (aReview !== bReview) return aReview - bReview;
        return a.title.localeCompare(b.title);
      });

    return {
      focusedTasks: allFocusedTasks,
      schedule: scheduleItems,
      nextActions: sortFocusNextActions(nextItems, {
        now,
        prioritizeByPriority: prioritiesEnabled,
      }),
      reviewDue: reviewDueItems,
    };
  }, [baseActiveTasks, filteredActiveTasks, prioritiesEnabled, sequentialProjectIds]);

  const sections = useMemo(() => {
    const nextSections = [];

    if (focusedTasks.length > 0) {
      nextSections.push({
        title: t('agenda.todaysFocus') ?? "Today's Focus",
        data: expandedSections.focus ? focusedTasks : [],
        totalCount: focusedTasks.length,
        expanded: expandedSections.focus,
        type: 'focus' as const,
      });
    }

    nextSections.push(
      {
        title: t('focus.schedule') ?? 'Today',
        data: expandedSections.schedule ? schedule : [],
        totalCount: schedule.length,
        expanded: expandedSections.schedule,
        type: 'schedule' as const,
      },
      {
        title: t('focus.nextActions') ?? t('list.next'),
        data: expandedSections.next ? nextActions : [],
        totalCount: nextActions.length,
        expanded: expandedSections.next,
        type: 'next' as const,
      },
      {
        title: t('agenda.reviewDue') ?? 'Review Due',
        data: expandedSections.reviewDue ? reviewDue : [],
        totalCount: reviewDue.length,
        expanded: expandedSections.reviewDue,
        type: 'reviewDue' as const,
      }
    );

    return nextSections;
  }, [expandedSections.focus, expandedSections.next, expandedSections.reviewDue, expandedSections.schedule, focusedTasks, schedule, nextActions, reviewDue, t]);
  const hasTasks = focusedTasks.length > 0 || schedule.length > 0 || nextActions.length > 0 || reviewDue.length > 0;
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
    selectedPriorities.forEach((priority) => {
      chips.push({
        id: `priority:${priority}`,
        label: t(`priority.${priority}`),
        onPress: () => togglePriority(priority),
      });
    });
    selectedEnergyLevels.forEach((energyLevel) => {
      chips.push({
        id: `energy:${energyLevel}`,
        label: t(`energyLevel.${energyLevel}`),
        onPress: () => toggleEnergyLevel(energyLevel),
      });
    });
    selectedTimeEstimates.forEach((estimate) => {
      chips.push({
        id: `time:${estimate}`,
        label: formatFocusTimeEstimateLabel(estimate),
        onPress: () => toggleTimeEstimate(estimate),
      });
    });
    chips.push(...advancedFilterChips);
    return chips;
  }, [
    advancedFilterChips,
    projectById,
    resolveText,
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
  ]);
  const openSaveFilterDialog = useCallback(() => {
    const defaultName = activeFilterChips.slice(0, 3).map((chip) => chip.label).join(' + ')
      || resolveText('savedFilters.defaultName', 'Focus filter');
    setSaveFilterName(defaultName);
    setSaveFilterDialogVisible(true);
  }, [activeFilterChips, resolveText]);
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
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    updateTask(taskId, updates);
  }, [updateTask]);

  const toggleSection = useCallback((sectionType: 'focus' | 'schedule' | 'next' | 'reviewDue') => {
    setExpandedSections((current) => ({
      ...current,
      [sectionType]: !current[sectionType],
    }));
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
      <Text style={[styles.filterChipText, { color: textColor }]}>
        {label}
      </Text>
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

  const renderItem = ({ item }: { item: Task }) => (
    <View style={styles.itemWrapper}>
      <SwipeableTaskItem
        task={item}
        isDark={isDark}
        tc={tc}
        onPress={() => onEdit(item)}
        onStatusChange={(status) => { void updateTask(item.id, { status: status as TaskStatus }); }}
        onDelete={() => { void deleteTask(item.id); }}
        isHighlighted={item.id === highlightTaskId}
        showFocusToggle
        hideStatusBadge
        onProjectPress={openProjectScreen}
        onContextPress={openContextsScreen}
        onTagPress={openContextsScreen}
      />
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        initialNumToRender={FOCUS_LIST_INITIAL_RENDER_COUNT}
        maxToRenderPerBatch={FOCUS_LIST_BATCH_RENDER_COUNT}
        windowSize={FOCUS_LIST_WINDOW_SIZE}
        contentContainerStyle={[
          styles.listContent,
        ]}
        ListHeaderComponent={(
          <View style={styles.header}>
            {pomodoroEnabled && (
              <PomodoroPanel
                tasks={pomodoroTasks}
                onMarkDone={(id) => updateTask(id, { status: 'done', isFocusedToday: false })}
              />
            )}
            <View style={styles.headerTopRow}>
              <Text style={[styles.dateText, { color: tc.secondaryText }]}>
                {safeFormatDate(new Date(), 'PPPP')}
              </Text>
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityLabel={resolveText('filters.label', 'Filters')}
                  accessibilityRole="button"
                  onPress={() => setFiltersVisible(true)}
                  style={({ pressed }) => [
                    styles.filterButton,
                    {
                      borderColor: hasFilters ? tc.tint : tc.border,
                      backgroundColor: hasFilters ? tc.filterBg : 'transparent',
                      opacity: pressed ? 0.78 : 1,
                    },
                  ]}
                >
                  <SlidersHorizontal size={16} color={hasFilters ? tc.tint : tc.secondaryText} />
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
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.savedFiltersRow}
              style={styles.savedFiltersScroller}
            >
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: !hasFilters }}
                onPress={clearFilters}
                style={[
                  styles.savedFilterChip,
                  {
                    borderColor: !hasFilters ? tc.tint : tc.border,
                    backgroundColor: !hasFilters ? tc.tint : tc.filterBg,
                  },
                ]}
              >
                <Text style={[styles.savedFilterChipText, { color: !hasFilters ? tc.onTint : tc.text }]}>
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
                      <Text
                        style={[styles.savedFilterChipText, { color: selected ? tc.onTint : tc.text }]}
                        numberOfLines={1}
                      >
                        {filter.icon ? `${filter.icon} ` : ''}{filter.name}
                      </Text>
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
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={resolveText('savedFilters.new', 'New saved filter')}
                onPress={() => {
                  setActiveSavedFilterId(null);
                  setFiltersVisible(true);
                }}
                style={[
                  styles.savedFilterAddChip,
                  { borderColor: tc.border, backgroundColor: tc.filterBg },
                ]}
              >
                <Plus size={16} color={tc.secondaryText} />
              </TouchableOpacity>
            </ScrollView>
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
                <Text style={[styles.futureStartText, { color: tc.secondaryText }]}>
                  {formatFutureStartNotice(hiddenFutureStartCount, showFutureStarts)}
                </Text>
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
              style={styles.sectionHeader}
            >
              <Text style={[styles.sectionChevron, { color: tc.secondaryText }]}>
                {section.expanded ? '▾' : '▸'}
              </Text>
              <Text style={[styles.sectionTitle, { color: tc.tint }]}>{section.title}</Text>
              <Text style={[styles.sectionCount, { color: tc.secondaryText }]}>({section.totalCount})</Text>
              <View style={[styles.sectionLine, { backgroundColor: tc.border }]} />
            </Pressable>
          ) : null
        )}
        renderItem={renderItem}
        ListEmptyComponent={!hasTasks ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: tc.text }]}>{emptyTitle}</Text>
            <Text style={[styles.emptySubtitle, { color: tc.secondaryText }]}>{emptySubtitle}</Text>
          </View>
        ) : null}
      />
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
                {hasCurrentFilterCriteria && activeSavedFilterId === null ? (
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

              {prioritiesEnabled ? (
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

              <Text style={[styles.sheetSectionLabel, { color: tc.secondaryText }]}>
                {resolveText('taskEdit.energyLevel', 'Energy level')}
              </Text>
              <View style={styles.sheetChipRow}>
                {ENERGY_LEVEL_OPTIONS.map((energyLevel) => (
                  renderFilterChip(t(`energyLevel.${energyLevel}`), selectedEnergyLevels.includes(energyLevel), () => toggleEnergyLevel(energyLevel))
                ))}
              </View>

              {timeEstimatesEnabled && effectiveTimeEstimatePresets.length > 0 ? (
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
                  { backgroundColor: saveFilterName.trim() ? tc.tint : tc.filterBg },
                ]}
              >
                <Text style={[styles.dialogButtonText, { color: saveFilterName.trim() ? tc.onTint : tc.secondaryText }]}>
                  {resolveText('common.save', 'Save')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <TaskEditModal
        visible={isModalVisible}
        task={editingTask}
        onClose={() => setIsModalVisible(false)}
        onSave={onSaveTask}
        defaultTab="view"
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
    marginTop: 8,
    marginBottom: 12,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
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
  savedFilterAddChip: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: 22,
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
    minWidth: 44,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: 10,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  filterBadge: {
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
  futureStartText: {
    flex: 1,
    fontSize: 12,
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
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
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
    height: 1,
    borderRadius: 1,
  },
  itemWrapper: {
    marginBottom: 8,
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
