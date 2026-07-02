import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { View, FlatList, Text, TextInput, RefreshControl, Modal, Pressable, TouchableOpacity, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { router } from 'expo-router';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, MoveVertical } from 'lucide-react-native';
import DraggableFlatList, { NestableDraggableFlatList, type DragEndParams, type RenderItemParams } from 'react-native-draggable-flatlist';
import {
  useTaskStore,
  Task,
  TaskStatus,
  TaskEnergyLevel,
  TaskPriority,
  TimeEstimate,
  sortTasksBy,
  splitCompletedTasks,
  sortDoneTasksForListView,
  parseQuickAdd,
  formatFocusTaskLimitText,
  getDefaultTaskAreaMode,
  normalizeClockTimeInput,
  resolveDefaultNewTaskAreaId,
  getQuickAddProjectInitialProps,
  getUsedTaskTokens,
  createAIProvider,
  type AIProviderId,
  type TaskSortBy,
  type Project,
  type ProjectSequenceTaskCue,
  DEFAULT_PROJECT_COLOR,
  getTranslationsSync,
  shallow,
  normalizeFocusTaskLimit,
  tFallback,
  isSelectableProjectForTaskAssignment,
  isTaskInActiveProject,
  getTaskMetadataFilterVisibility,
  type MultiValueFilterMatchMode,
} from '@mindwtr/core';

import { TaskEditModal } from './task-edit-modal';
import { ErrorBoundary } from './ErrorBoundary';
import { ListEmptyState } from './list-empty-state';
import { SwipeableTaskItem, type SwipeableTaskItemRowContext } from './swipeable-task-item';
import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useToast } from '@/contexts/toast-context';
import { PullSyncIndicator } from '@/components/PullSyncIndicator';
import { useManualPullSync } from '@/hooks/use-manual-pull-sync';
import { taskMatchesAreaFilter } from '@mindwtr/core';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { buildCopilotConfig, isAIKeyRequired, loadAIKey } from '../lib/ai-config';
import { logError } from '../lib/app-log';
import {
  beginMobilePerformanceDiagnostic,
  finishMobilePerformanceDiagnostic,
  resolveMobilePerformanceRoute,
} from '../lib/performance-diagnostics';
import {
  TaskListBulkBar,
  getBulkMoveStatusOptions,
  type TaskListBulkBarProps,
} from './task-list/TaskListBulkBar';
import {
  TaskListBulkOrganizeModal,
} from './task-list/TaskListBulkOrganizeModal';
import {
  TaskListHeader,
  type TaskListActiveFilterChip,
} from './task-list/TaskListHeader';
import {
  TaskListFiltersSheet,
} from './task-list/TaskListFiltersSheet';
import {
  TaskListQuickAdd,
} from './task-list/TaskListQuickAdd';
import {
  TaskListSortModal,
} from './task-list/TaskListSortModal';
import {
  TaskListTagModal,
} from './task-list/TaskListTagModal';
import { styles } from './task-list/task-list.styles';
import {
  buildProjectTaskReorderGroups,
  buildStaticListVirtualWindow,
  resolveStaticListViewportHeight,
  type ProjectTaskReorderGroup,
  sortProjectTasksByOrder,
} from './task-list-utils';
import {
  buildTaskListMeasuredHeightKey,
  buildTaskListItemLayouts,
  buildTaskListVirtualizedItemKey,
  ESTIMATED_TASK_HEIGHT,
  LIST_CONTENT_VERTICAL_PADDING,
  type TaskListLayoutRevision,
} from './task-list/task-list-layout';
import {
  buildMobileTaskListFilters,
  countActiveMobileTaskFilters,
  taskMatchesMobileTaskFilters,
  type MobileTaskListFilters,
} from './task-list/task-list-filter-utils';
import { useTaskListSelection } from './use-task-list-selection';

const REMOVE_CLIPPED_SUBVIEWS_MIN_ITEMS = 15;
const PROJECT_REORDER_ITEM_HEIGHT = 80;
const PROJECT_REORDER_ANIMATION_CONFIG = {
  damping: 28,
  mass: 0.15,
  overshootClamping: true,
  restDisplacementThreshold: 0.1,
  restSpeedThreshold: 0.1,
  stiffness: 240,
} as const;
const STATIC_LIST_VIRTUALIZATION_THRESHOLD = 80;
const STATIC_LIST_ROW_ESTIMATE = 88;
const STATIC_LIST_OVERSCAN = 8;
const PRIORITY_OPTIONS: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const ENERGY_LEVEL_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];

type StaticListVirtualizationWindow = {
  scrollOffsetY: number;
  viewportHeight: number;
};

type AddTaskOptions = {
  openAfterCreate?: boolean;
};

export type ReferenceGroupBy = 'none' | 'area' | 'project' | 'tag';

export interface TaskListProps {
  statusFilter: TaskStatus | 'all';
  title: string;
  taskSource?: Task[];
  showHeader?: boolean;
  showTimeEstimateFilters?: boolean;
  allowAdd?: boolean;
  projectId?: string;
  staticList?: boolean;
  staticListVirtualization?: StaticListVirtualizationWindow;
  enableBulkActions?: boolean;
  enableInboxBulkOrganize?: boolean;
  enableProjectBulkOrganize?: boolean;
  bulkBarPlacement?: 'inline' | 'external';
  onBulkBarPropsChange?: (props: TaskListBulkBarProps | null) => void;
  showSort?: boolean;
  showQuickAddHelp?: boolean;
  emptyText?: string;
  emptyHint?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  headerAccessory?: React.ReactNode;
  primaryActionRow?: React.ReactNode;
  showFilterButton?: boolean;
  onFilterStateChange?: (state: { activeCount: number; hasActive: boolean }) => void;
  enableCopilot?: boolean;
  defaultEditTab?: 'task' | 'view';
  contentPaddingBottom?: number;
  enableProjectReorder?: boolean;
  externalFilterOpenSignal?: number;
  externalQuickAddFocusSignal?: number;
  projectSortBy?: TaskSortBy;
  onQuickAddInputFocus?: (targetInput?: number | string) => void;
  projectReorderMode?: boolean;
  onProjectReorderModeChange?: (active: boolean) => void;
  projectReorderOwnsScroll?: boolean;
  includeArchived?: boolean;
  includeDone?: boolean;
  groupCompletedTasksLast?: boolean;
  referenceGroupBy?: ReferenceGroupBy;
  onChangeReferenceGroupBy?: (value: ReferenceGroupBy) => void;
  groupBy?: ReferenceGroupBy;
  onChangeGroupBy?: (value: ReferenceGroupBy) => void;
  getTaskSequenceCue?: (task: Task) => ProjectSequenceTaskCue | undefined;
  sequenceCueLabels?: Record<ProjectSequenceTaskCue, string>;
}

// ... inside TaskList component
function TaskListComponent({
  statusFilter,
  title,
  taskSource,
  showHeader = true,
  showTimeEstimateFilters: showTimeEstimateFiltersProp = true,
  allowAdd = true,
  projectId,
  staticList = false,
  staticListVirtualization,
  enableBulkActions = true,
  enableInboxBulkOrganize = false,
  enableProjectBulkOrganize = false,
  bulkBarPlacement = 'inline',
  onBulkBarPropsChange,
  showSort = true,
  showQuickAddHelp = true,
  emptyText,
  emptyHint,
  emptyActionLabel,
  onEmptyAction,
  headerAccessory,
  primaryActionRow,
  showFilterButton = true,
  onFilterStateChange,
  enableCopilot = true,
  defaultEditTab,
  contentPaddingBottom,
  enableProjectReorder = false,
  externalFilterOpenSignal = 0,
  externalQuickAddFocusSignal = 0,
  projectSortBy,
  onQuickAddInputFocus,
  projectReorderMode: projectReorderModeProp,
  onProjectReorderModeChange,
  projectReorderOwnsScroll = false,
  includeArchived = false,
  includeDone = true,
  groupCompletedTasksLast = false,
  referenceGroupBy = 'area',
  onChangeReferenceGroupBy,
  groupBy,
  onChangeGroupBy,
  getTaskSequenceCue,
  sequenceCueLabels,
}: TaskListProps) {
  const { isDark } = useTheme();
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const {
    tasks,
    projects,
    sections,
    areas,
    addTask,
    addProject,
    updateTask,
    deleteTask,
    restoreTask,
    batchMoveTasks,
    batchDeleteTasks,
    batchUpdateTasks,
    reorderProjectTasks,
    reorderSections,
    settings,
    updateSettings,
    highlightTaskId,
    setHighlightTask,
    getDerivedState,
  } = useTaskStore((state) => ({
    tasks: taskSource ?? (includeArchived ? state._allTasks : state.tasks),
    projects: state.projects,
    sections: state.sections,
    areas: state.areas,
    addTask: state.addTask,
    addProject: state.addProject,
    updateTask: state.updateTask,
    deleteTask: state.deleteTask,
    restoreTask: state.restoreTask,
    batchMoveTasks: state.batchMoveTasks,
    batchDeleteTasks: state.batchDeleteTasks,
    batchUpdateTasks: state.batchUpdateTasks,
    reorderProjectTasks: state.reorderProjectTasks,
    reorderSections: state.reorderSections,
    settings: state.settings,
    updateSettings: state.updateSettings,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
    getDerivedState: state.getDerivedState,
  }), shallow);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [quickAddFocus, setQuickAddFocus] = useState(false);
  const [aiKey, setAiKey] = useState('');
  const [copilotSuggestion, setCopilotSuggestion] = useState<{ context?: string; timeEstimate?: Task['timeEstimate']; tags?: string[] } | null>(null);
  const [copilotApplied, setCopilotApplied] = useState(false);
  const [copilotContext, setCopilotContext] = useState<string | undefined>(undefined);
  const [copilotTags, setCopilotTags] = useState<string[]>([]);
  const [copilotThinking, setCopilotThinking] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [sortModalVisible, setSortModalVisible] = useState(false);
  const [referenceGroupModalVisible, setReferenceGroupModalVisible] = useState(false);
  const [filtersVisible, setFiltersVisible] = useState(false);
  const [bulkOrganizeVisible, setBulkOrganizeVisible] = useState(false);
  const [internalProjectReorderMode, setInternalProjectReorderMode] = useState(false);
  const [completedTasksCollapsed, setCompletedTasksCollapsed] = useState(true);
  const [taskSearchQuery, setTaskSearchQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const [contextMatchMode, setContextMatchMode] = useState<MultiValueFilterMatchMode>('all');
  const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
  const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
  const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
  const [inputSelection, setInputSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [typeaheadOpen, setTypeaheadOpen] = useState(false);
  const [typeaheadIndex, setTypeaheadIndex] = useState(0);
  const newTaskTitleRef = useRef(newTaskTitle);
  const inputSelectionRef = useRef(inputSelection);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copilotAbortRef = useRef<AbortController | null>(null);
  const copilotRequestIdRef = useRef(0);
  const restoreActionLabel = getTranslationsSync(language)['trash.restoreToInbox']
    || getTranslationsSync('en')['trash.restoreToInbox']
    || 'Restore';
  const pullSync = useManualPullSync();

  // Dynamic colors based on theme
  const themeColors = useThemeColors();
  const themeColorsMemo = useMemo(
    () => ({
      bg: themeColors.bg,
      cardBg: themeColors.cardBg,
      taskItemBg: themeColors.taskItemBg,
      text: themeColors.text,
      secondaryText: themeColors.secondaryText,
      icon: themeColors.icon,
      border: themeColors.border,
      tint: themeColors.tint,
      onTint: themeColors.onTint,
      tabIconDefault: themeColors.tabIconDefault,
      tabIconSelected: themeColors.tabIconSelected,
      inputBg: themeColors.inputBg,
      danger: themeColors.danger,
      success: themeColors.success,
      warning: themeColors.warning,
      filterBg: themeColors.filterBg,
    }),
    [
      themeColors.bg,
      themeColors.cardBg,
      themeColors.taskItemBg,
      themeColors.text,
      themeColors.secondaryText,
      themeColors.icon,
      themeColors.border,
      themeColors.tint,
      themeColors.onTint,
      themeColors.tabIconDefault,
      themeColors.tabIconSelected,
      themeColors.inputBg,
      themeColors.danger,
      themeColors.success,
      themeColors.warning,
      themeColors.filterBg,
    ],
  );

  const listContentStyle = useMemo(() => {
    if (!contentPaddingBottom || contentPaddingBottom <= 0) {
      return styles.listContent;
    }
    return [styles.listContent, { paddingBottom: 12 + contentPaddingBottom }];
  }, [contentPaddingBottom]);
  const [taskListRootOffsetY, setTaskListRootOffsetY] = useState(0);
  const [staticListOffsetY, setStaticListOffsetY] = useState(0);
  const handleTaskListRootLayout = useCallback((event: LayoutChangeEvent) => {
    if (!staticListVirtualization) return;
    setTaskListRootOffsetY(event.nativeEvent.layout.y);
  }, [staticListVirtualization]);
  const handleStaticListLayout = useCallback((event: LayoutChangeEvent) => {
    if (!staticListVirtualization) return;
    setStaticListOffsetY(event.nativeEvent.layout.y);
  }, [staticListVirtualization]);
  const emptyMessage = emptyText || t('list.noTasks');

  const tasksById = useMemo(() => {
    return tasks.reduce((acc, task) => {
      acc[task.id] = task;
      return acc;
    }, {} as Record<string, Task>);
  }, [tasks]);
  const {
    bulkActionLabel,
    bulkActionLoading,
    exitSelectionMode,
    handleBatchAddTag,
    handleBatchDelete,
    handleBatchOrganize,
    handleBatchMove,
    hasSelection,
    multiSelectedIds,
    rangeSelectMode,
    selectedIdsArray,
    selectionMode,
    setTagInput,
    setTagModalVisible,
    tagInput,
    tagModalVisible,
    toggleRangeSelectMode,
    toggleMultiSelect,
  } = useTaskListSelection({
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    restoreActionLabel,
    restoreTask,
    t,
    tasksById,
  });

  const sortBy = (projectSortBy ?? settings?.taskSortBy ?? 'default') as TaskSortBy;
  const activeGroupBy: ReferenceGroupBy = statusFilter === 'reference' && !projectId
    ? (referenceGroupBy ?? groupBy ?? 'area')
    : (groupBy ?? 'none');
  const handleChangeGroupBy = statusFilter === 'reference' && !projectId
    ? (onChangeReferenceGroupBy ?? onChangeGroupBy)
    : onChangeGroupBy;
  const canUseProjectReorder = Boolean(enableProjectReorder && projectId && sortBy === 'default');
  const shouldGroupCompletedTasks = Boolean(groupCompletedTasksLast && projectId && statusFilter === 'all');
  const projectReorderMode = projectReorderModeProp ?? internalProjectReorderMode;
  const quickAddInputRef = useRef<TextInput | null>(null);
  const quickAddAvailable = allowAdd && !projectReorderMode && (Boolean(projectId) || statusFilter === 'inbox');
  const aiEnabled = settings?.ai?.enabled === true;
  const quickAddCopilotEnabled = quickAddAvailable && enableCopilot && aiEnabled;
  const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
  const focusedCount = getDerivedState().focusedCount;
  const canQuickAddFocus = quickAddFocus || focusedCount < focusTaskLimit;
  const quickAddFocusDisabledReason = formatFocusTaskLimitText(
    tFallback(t, 'agenda.maxFocusItems', 'Max {{count}} focus items.'),
    focusTaskLimit,
  );
  const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
  const keyRequired = isAIKeyRequired(settings);
  const prioritiesEnabled = settings?.features?.priorities !== false;
  const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
  const showTaskAge = settings?.appearance?.showTaskAge === true;
  const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
  const rowContext = useMemo<SwipeableTaskItemRowContext>(() => ({
    addTask,
    updateTask,
    restoreTask,
    projects,
    areas,
    focusedCount,
    focusTaskLimit,
    timeEstimatesEnabled,
    showTaskAge,
    undoNotificationsEnabled,
  }), [
    addTask,
    areas,
    focusedCount,
    focusTaskLimit,
    projects,
    restoreTask,
    showTaskAge,
    timeEstimatesEnabled,
    undoNotificationsEnabled,
    updateTask,
  ]);
  const timeEstimateFiltersEnabled = showTimeEstimateFiltersProp && timeEstimatesEnabled && statusFilter !== 'inbox';
  const canBulkOrganizeInbox = enableInboxBulkOrganize && statusFilter === 'inbox';
  const canBulkOrganizeProject = enableProjectBulkOrganize && Boolean(projectId);
  const canBulkOrganizeSelection = canBulkOrganizeInbox || canBulkOrganizeProject;
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const { areaById, resolvedAreaFilter, selectedAreaIdForNewTasks } = useMobileAreaFilter();
  const defaultAreaMode = getDefaultTaskAreaMode(settings);
  const defaultNewTaskAreaId = resolveDefaultNewTaskAreaId(settings, areas);
  const quickAddNewTaskAreaId = defaultAreaMode === 'active'
    ? selectedAreaIdForNewTasks ?? undefined
    : defaultNewTaskAreaId;

  // Track the last-seen signal so a remount (e.g. toggling reorder mode swaps the
  // scroll container component type) doesn't re-open the sheet from a stale value.
  const lastFilterOpenSignalRef = useRef(externalFilterOpenSignal);
  useEffect(() => {
    if (externalFilterOpenSignal === lastFilterOpenSignalRef.current) return;
    lastFilterOpenSignalRef.current = externalFilterOpenSignal;
    if (externalFilterOpenSignal <= 0) return;
    setFiltersVisible(true);
  }, [externalFilterOpenSignal]);

  const lastQuickAddFocusSignalRef = useRef(externalQuickAddFocusSignal);
  useEffect(() => {
    if (externalQuickAddFocusSignal === lastQuickAddFocusSignalRef.current) return;
    lastQuickAddFocusSignalRef.current = externalQuickAddFocusSignal;
    if (externalQuickAddFocusSignal <= 0) return;
    if (!quickAddAvailable) return;
    quickAddInputRef.current?.focus();
  }, [externalQuickAddFocusSignal, quickAddAvailable]);

  const refocusQuickAddInput = useCallback(() => {
    if (!quickAddAvailable) return;
    const focusInput = () => {
      quickAddInputRef.current?.focus();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(focusInput);
    } else {
      setTimeout(focusInput, 0);
    }
  }, [quickAddAvailable]);

  const lastProjectIdRef = useRef(projectId);
  const setProjectReorderMode = useCallback((active: boolean) => {
    if (projectReorderModeProp === undefined) {
      setInternalProjectReorderMode(active);
    }
    onProjectReorderModeChange?.(active);
  }, [onProjectReorderModeChange, projectReorderModeProp]);

  useEffect(() => {
    if (lastProjectIdRef.current === projectId) return;
    lastProjectIdRef.current = projectId;
    setProjectReorderMode(false);
  }, [projectId, setProjectReorderMode]);

  useEffect(() => {
    setCompletedTasksCollapsed(true);
  }, [groupCompletedTasksLast, projectId]);

  useEffect(() => {
    if (!canUseProjectReorder && projectReorderMode) {
      setProjectReorderMode(false);
    }
  }, [canUseProjectReorder, projectReorderMode, setProjectReorderMode]);

  useEffect(() => {
    if (projectReorderMode && selectionMode) {
      exitSelectionMode();
    }
  }, [exitSelectionMode, projectReorderMode, selectionMode]);

  const toggleTimeEstimate = useCallback((estimate: TimeEstimate) => {
    setSelectedTimeEstimates((prev) => (
      prev.includes(estimate)
        ? prev.filter((value) => value !== estimate)
        : [...prev, estimate]
    ));
  }, []);
  const toggleTokenFilter = useCallback((token: string) => {
    setSelectedTokens((prev) => (
      prev.includes(token)
        ? prev.filter((value) => value !== token)
        : [...prev, token]
    ));
  }, []);
  const togglePriorityFilter = useCallback((priority: TaskPriority) => {
    setSelectedPriorities((prev) => (
      prev.includes(priority)
        ? prev.filter((value) => value !== priority)
        : [...prev, priority]
    ));
  }, []);
  const toggleEnergyLevelFilter = useCallback((energyLevel: TaskEnergyLevel) => {
    setSelectedEnergyLevels((prev) => (
      prev.includes(energyLevel)
        ? prev.filter((value) => value !== energyLevel)
        : [...prev, energyLevel]
    ));
  }, []);
  const clearTaskFilters = useCallback(() => {
    setTaskSearchQuery('');
    setLocationFilter('');
    setSelectedTokens([]);
    setContextMatchMode('all');
    setSelectedPriorities([]);
    setSelectedEnergyLevels([]);
    setSelectedTimeEstimates([]);
  }, []);
  const clearAllFilters = useCallback(() => {
    clearTaskFilters();
  }, [clearTaskFilters]);

  const filterableTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (task.deletedAt) return false;
      if (statusFilter === 'all' && task.status === 'reference') return false;
      if (statusFilter === 'all' && !includeDone && task.status === 'done') return false;
      const matchesStatus = statusFilter === 'all' ? true : task.status === statusFilter;
      const matchesProject = projectId ? task.projectId === projectId : true;
      if (!projectId && !isTaskInActiveProject(task, projectById)) return false;
      if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)) return false;
      return matchesStatus && matchesProject;
    });
  }, [areaById, includeDone, projectById, projectId, resolvedAreaFilter, statusFilter, tasks]);
  const tokenFilterOptions = useMemo(() => {
    if (!filtersVisible) return selectedTokens;
    return getUsedTaskTokens(filterableTasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])]);
  }, [filterableTasks, filtersVisible, selectedTokens]);
  const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(filterableTasks, {
    prioritiesEnabled,
    timeEstimatesEnabled: timeEstimateFiltersEnabled,
  }), [filterableTasks, prioritiesEnabled, timeEstimateFiltersEnabled]);
  const showPriorityFilters = metadataFilterVisibility.priority;
  const showEnergyLevelFilters = metadataFilterVisibility.energyLevel;
  const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
  const showLocationFilter = metadataFilterVisibility.location;
  useEffect(() => {
    if (!showTimeEstimateFilters && selectedTimeEstimates.length > 0) {
      setSelectedTimeEstimates([]);
    }
  }, [selectedTimeEstimates.length, showTimeEstimateFilters]);

  useEffect(() => {
    if (!showPriorityFilters && selectedPriorities.length > 0) {
      setSelectedPriorities([]);
    }
  }, [selectedPriorities.length, showPriorityFilters]);

  useEffect(() => {
    if (!showEnergyLevelFilters && selectedEnergyLevels.length > 0) {
      setSelectedEnergyLevels([]);
    }
  }, [selectedEnergyLevels.length, showEnergyLevelFilters]);

  useEffect(() => {
    if (!showLocationFilter && locationFilter.trim().length > 0) {
      setLocationFilter('');
    }
  }, [locationFilter, showLocationFilter]);

  const taskListFilters = useMemo<MobileTaskListFilters>(() => buildMobileTaskListFilters({
    energyLevels: showEnergyLevelFilters ? selectedEnergyLevels : [],
    locationQuery: showLocationFilter ? locationFilter : '',
    priorities: showPriorityFilters ? selectedPriorities : [],
    searchQuery: taskSearchQuery,
    timeEstimates: showTimeEstimateFilters ? selectedTimeEstimates : [],
    tokens: selectedTokens,
    contextMatchMode,
  }), [
    contextMatchMode,
    locationFilter,
    showEnergyLevelFilters,
    showLocationFilter,
    showPriorityFilters,
    selectedEnergyLevels,
    selectedPriorities,
    selectedTimeEstimates,
    selectedTokens,
    showTimeEstimateFilters,
    taskSearchQuery,
  ]);
  const activeTaskFilterCount = countActiveMobileTaskFilters(taskListFilters);
  const hasActiveTaskFilters = activeTaskFilterCount > 0;
  const totalFilterActiveCount = activeTaskFilterCount;
  const hasAnyActiveFilters = hasActiveTaskFilters;
  useEffect(() => {
    onFilterStateChange?.({ activeCount: totalFilterActiveCount, hasActive: hasAnyActiveFilters });
  }, [hasAnyActiveFilters, onFilterStateChange, totalFilterActiveCount]);
  const activeFilterChips = useMemo<TaskListActiveFilterChip[]>(() => {
    const chips: TaskListActiveFilterChip[] = [];
    const normalizedSearch = taskSearchQuery.trim();
    if (normalizedSearch) {
      chips.push({
        id: 'search',
        label: `${t('common.search')}: ${normalizedSearch}`,
        onPress: () => setTaskSearchQuery(''),
      });
    }
    selectedTokens.forEach((token) => {
      chips.push({
        id: `token:${token}`,
        label: token,
        onPress: () => toggleTokenFilter(token),
      });
    });
    if (showPriorityFilters) {
      selectedPriorities.forEach((priority) => {
        chips.push({
          id: `priority:${priority}`,
          label: t(`priority.${priority}`),
          onPress: () => togglePriorityFilter(priority),
        });
      });
    }
    if (showEnergyLevelFilters) {
      selectedEnergyLevels.forEach((energyLevel) => {
        chips.push({
          id: `energy:${energyLevel}`,
          label: t(`energyLevel.${energyLevel}`),
          onPress: () => toggleEnergyLevelFilter(energyLevel),
        });
      });
    }
    if (showTimeEstimateFilters) {
      selectedTimeEstimates.forEach((estimate) => {
        chips.push({
          id: `time:${estimate}`,
          label: estimate.replace('min', 'm').replace('hr+', 'h+').replace('hr', 'h'),
          onPress: () => toggleTimeEstimate(estimate),
        });
      });
    }
    const normalizedLocation = locationFilter.trim();
    if (showLocationFilter && normalizedLocation) {
      chips.push({
        id: 'location',
        label: `${tFallback(t, 'taskEdit.locationLabel', 'Location')}: ${normalizedLocation}`,
        onPress: () => setLocationFilter(''),
      });
    }
    return chips;
  }, [
    locationFilter,
    showEnergyLevelFilters,
    showLocationFilter,
    showPriorityFilters,
    selectedEnergyLevels,
    selectedPriorities,
    selectedTimeEstimates,
    selectedTokens,
    showTimeEstimateFilters,
    t,
    taskSearchQuery,
    toggleEnergyLevelFilter,
    togglePriorityFilter,
    toggleTimeEstimate,
    toggleTokenFilter,
  ]);
  const selectedContextCount = useMemo(
    () => selectedTokens.filter((token) => token.trim().startsWith('@')).length,
    [selectedTokens],
  );
  const showContextMatchMode = selectedContextCount > 1;
  const updateContextMatchMode = useCallback((mode: MultiValueFilterMatchMode) => {
    setContextMatchMode(mode);
  }, []);
  const filteredEmptyMessage = hasActiveTaskFilters
    ? tFallback(t, 'filters.noMatch', 'No tasks match these filters.')
    : emptyMessage;
  const filteredEmptyHint = hasActiveTaskFilters
    ? activeFilterChips.slice(0, 3).map((chip) => chip.label).join(', ')
    : emptyHint;
  const filteredEmptyActionLabel = hasActiveTaskFilters
    ? tFallback(t, 'filters.clear', 'Clear')
    : emptyActionLabel;
  const filteredEmptyAction = hasActiveTaskFilters ? clearTaskFilters : onEmptyAction;

  // Memoize filtered and sorted tasks for performance
  const filteredTasks = useMemo(() => {
    return filterableTasks.filter((task) => taskMatchesMobileTaskFilters(task, taskListFilters));
  }, [filterableTasks, taskListFilters]);

  const orderedTasks = useMemo(() => {
    if (projectId && enableProjectReorder && sortBy === 'default') {
      return sortProjectTasksByOrder(filteredTasks);
    }
    return sortTasksBy(filteredTasks, sortBy);
  }, [enableProjectReorder, filteredTasks, projectId, sortBy]);
  const { activeTasks: orderedActiveTasks, completedTasks: orderedCompletedTasks } = useMemo(() => {
    if (!shouldGroupCompletedTasks) {
      return { activeTasks: orderedTasks, completedTasks: [] as Task[] };
    }
    const { activeTasks, completedTasks } = splitCompletedTasks(orderedTasks);
    return {
      activeTasks,
      completedTasks: sortDoneTasksForListView(completedTasks),
    };
  }, [orderedTasks, shouldGroupCompletedTasks]);

  const projectSections = useMemo(() => {
    if (!projectId) return [];
    return sections
      .filter((section) => section.projectId === projectId && !section.deletedAt)
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : 0;
        const bOrder = Number.isFinite(b.order) ? b.order : 0;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [projectId, sections]);

  type ListItem =
    | { type: 'section'; id: string; title: string; count: number; muted?: boolean; collapsible?: boolean; collapsed?: boolean }
    | { type: 'task'; task: Task; reorderSectionId?: string | null; groupId?: string };

  const listItems = useMemo<ListItem[]>(() => {
    if (!projectId && activeGroupBy !== 'none') {
      const appendSection = (items: ListItem[], id: string, title: string, tasksForGroup: Task[], muted = false) => {
        if (tasksForGroup.length === 0) return;
        items.push({
          type: 'section',
          id,
          title,
          count: tasksForGroup.length,
          muted,
        });
        tasksForGroup.forEach((task) => items.push({ type: 'task', task, groupId: id }));
      };
      if (activeGroupBy === 'project') {
        const grouped = new Map<string, Task[]>();
        const noProjectTasks: Task[] = [];

        orderedActiveTasks.forEach((task) => {
          if (!task.projectId) {
            noProjectTasks.push(task);
            return;
          }
          const project = projectById.get(task.projectId);
          if (!project) {
            noProjectTasks.push(task);
            return;
          }
          const items = grouped.get(project.id) ?? [];
          items.push(task);
          grouped.set(project.id, items);
        });

        const items: ListItem[] = [];
        appendSection(items, 'project:none', tFallback(t, 'taskEdit.noProjectOption', 'No project'), noProjectTasks, true);
        const sortedProjects = [...grouped.keys()]
          .map((itemProjectId) => projectById.get(itemProjectId))
          .filter((project): project is Project => Boolean(project))
          .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.title.localeCompare(b.title);
          });
        sortedProjects.forEach((project) => appendSection(items, `project:${project.id}`, project.title, grouped.get(project.id) ?? []));
        return items;
      }
      if (activeGroupBy === 'tag') {
        const grouped = new Map<string, Task[]>();
        const noTagTasks: Task[] = [];

        orderedActiveTasks.forEach((task) => {
          const tags = (task.tags ?? [])
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);
          if (tags.length === 0) {
            noTagTasks.push(task);
            return;
          }
          Array.from(new Set(tags)).forEach((tag) => {
            const items = grouped.get(tag) ?? [];
            items.push(task);
            grouped.set(tag, items);
          });
        });

        const items: ListItem[] = [];
        appendSection(items, 'tag:none', tFallback(t, 'taskEdit.noTags', 'No tags'), noTagTasks, true);
        [...grouped.keys()]
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          .forEach((tag) => appendSection(items, `tag:${tag}`, tag, grouped.get(tag) ?? []));
        return items;
      }

      const activeAreas = [...areas].filter((area) => !area.deletedAt).sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      });
      const areaIds = new Set(activeAreas.map((area) => area.id));
      const grouped = new Map<string, Task[]>();
      const generalTasks: Task[] = [];

      orderedActiveTasks.forEach((task) => {
        const projectAreaId = task.projectId ? projectById.get(task.projectId)?.areaId : undefined;
        const resolvedAreaId = task.areaId || projectAreaId;
        if (resolvedAreaId && areaIds.has(resolvedAreaId)) {
          const items = grouped.get(resolvedAreaId) ?? [];
          items.push(task);
          grouped.set(resolvedAreaId, items);
        } else {
          generalTasks.push(task);
        }
      });

      const items: ListItem[] = [];
      appendSection(items, 'general', tFallback(t, 'settings.general', 'General'), generalTasks, true);

      activeAreas.forEach((area) => {
        const tasksForArea = grouped.get(area.id) ?? [];
        appendSection(items, area.id, area.name, tasksForArea);
      });
      return items;
    }

    const appendCompletedTasks = (items: ListItem[]) => {
      if (!shouldGroupCompletedTasks || orderedCompletedTasks.length === 0) return items;
      items.push({
        type: 'section',
        id: 'project-completed-tasks',
        title: tFallback(t, 'list.done', tFallback(t, 'status.done', 'Completed')),
        count: orderedCompletedTasks.length,
        muted: true,
        collapsible: true,
        collapsed: completedTasksCollapsed,
      });
      if (!completedTasksCollapsed) {
        orderedCompletedTasks.forEach((task) => items.push({ type: 'task', task }));
      }
      return items;
    };

    const shouldGroup = Boolean(projectId) && (projectSections.length > 0 || orderedActiveTasks.some((task) => task.sectionId));
    if (!shouldGroup) {
      return appendCompletedTasks(orderedActiveTasks.map((task) => ({ type: 'task', task, reorderSectionId: projectId ? undefined : task.sectionId })));
    }
    const sectionIds = new Set(projectSections.map((section) => section.id));
    const tasksBySection = new Map<string, Task[]>();
    const unsectioned: Task[] = [];
    orderedActiveTasks.forEach((task) => {
      const sectionId = task.sectionId && sectionIds.has(task.sectionId) ? task.sectionId : null;
      if (sectionId) {
        const list = tasksBySection.get(sectionId) ?? [];
        list.push(task);
        tasksBySection.set(sectionId, list);
      } else {
        unsectioned.push(task);
      }
    });
    const items: ListItem[] = [];
    projectSections.forEach((section) => {
      const tasksForSection = tasksBySection.get(section.id) ?? [];
      if (tasksForSection.length === 0 && !projectReorderMode) return;
      items.push({ type: 'section', id: section.id, title: section.title, count: tasksForSection.length });
      tasksForSection.forEach((task) => items.push({ type: 'task', task, reorderSectionId: section.id }));
    });
    if (unsectioned.length > 0) {
      const reorderSectionId = projectSections.length > 0 ? null : undefined;
      items.push({
        type: 'section',
        id: 'no-section',
        title: t('projects.noSection'),
        count: unsectioned.length,
        muted: true,
      });
      unsectioned.forEach((task) => items.push({ type: 'task', task, reorderSectionId }));
    }
    return appendCompletedTasks(items);
  }, [activeGroupBy, areas, completedTasksCollapsed, orderedActiveTasks, orderedCompletedTasks, projectById, projectId, projectReorderMode, projectSections, shouldGroupCompletedTasks, t]);
  const orderedTaskIds = useMemo(
    () => Array.from(new Set(listItems.flatMap((item) => (item.type === 'task' ? [item.task.id] : [])))),
    [listItems],
  );
  const performanceRoute = useMemo(
    () => resolveMobilePerformanceRoute({ projectId, statusFilter }),
    [projectId, statusFilter],
  );
  const listItemCountForDiagnostics = orderedTaskIds.length;
  const itemHeightsRef = useRef<Record<string, number>>({});
  const [itemLayoutVersion, setItemLayoutVersion] = useState(0);
  const getListItemKey = useCallback((item: ListItem) => (
    item.type === 'section' ? `section-${item.id}` : (item.groupId ? `${item.groupId}:${item.task.id}` : item.task.id)
  ), []);
  const getListItemLayoutRevision = useCallback((item: ListItem): TaskListLayoutRevision => {
    if (item.type === 'section') {
      return `${item.title}:${item.count}:${item.collapsed === true ? 'collapsed' : 'expanded'}`;
    }
    return item.task.rev ?? item.task.updatedAt;
  }, []);
  const getListItemLayoutKey = useCallback((item: ListItem) => (
    buildTaskListMeasuredHeightKey(getListItemKey(item), getListItemLayoutRevision(item))
  ), [getListItemKey, getListItemLayoutRevision]);
  const getVirtualizedListItemKey = useCallback((item: ListItem, index: number) => (
    buildTaskListVirtualizedItemKey(getListItemKey(item), index)
  ), [getListItemKey]);
  const wasPullRefreshingRef = useRef(false);
  const registerItemHeight = useCallback((itemKey: string, height: number) => {
    const rounded = Math.round(height);
    if (!Number.isFinite(rounded) || rounded <= 0) return;
    if (itemHeightsRef.current[itemKey] === rounded) return;
    itemHeightsRef.current[itemKey] = rounded;
    setItemLayoutVersion((prev) => prev + 1);
  }, []);
  useEffect(() => {
    if (wasPullRefreshingRef.current && !pullSync.refreshing) {
      itemHeightsRef.current = {};
      setItemLayoutVersion((prev) => prev + 1);
    }
    wasPullRefreshingRef.current = pullSync.refreshing;
  }, [pullSync.refreshing]);
  const itemLayouts = useMemo(() => {
    // itemLayoutVersion invalidates memoized offsets when ref-backed row heights change.
    void itemLayoutVersion;
    return buildTaskListItemLayouts(listItems, {
      getItemKey: getListItemLayoutKey,
      measuredHeights: itemHeightsRef.current,
    });
  }, [getListItemLayoutKey, itemLayoutVersion, listItems]);
  useEffect(() => {
    const activeItemKeys = new Set(listItems.map(getListItemLayoutKey));
    let didPrune = false;
    Object.keys(itemHeightsRef.current).forEach((itemKey) => {
      if (!activeItemKeys.has(itemKey)) {
        delete itemHeightsRef.current[itemKey];
        didPrune = true;
      }
    });
    if (didPrune) {
      setItemLayoutVersion((prev) => prev + 1);
    }
  }, [getListItemLayoutKey, listItems]);
  const getItemLayout = useCallback((_: ArrayLike<ListItem> | null | undefined, index: number) => {
    const measured = itemLayouts[index];
    if (measured) {
      return { index, length: measured.length, offset: measured.offset };
    }
    return {
      index,
      length: ESTIMATED_TASK_HEIGHT,
      offset: LIST_CONTENT_VERTICAL_PADDING + (ESTIMATED_TASK_HEIGHT * index),
    };
  }, [itemLayouts]);

  const projectReorderGroups = useMemo<ProjectTaskReorderGroup<Task>[]>(() => {
    if (!canUseProjectReorder) return [];
    const reorderItems = shouldGroupCompletedTasks
      ? listItems.filter((item) => (item.type === 'section' ? item.id !== 'project-completed-tasks' : item.task.status !== 'done'))
      : listItems;
    return buildProjectTaskReorderGroups<Task>(reorderItems, { includeEmptySections: projectSections.length > 0 });
  }, [canUseProjectReorder, listItems, projectSections.length, shouldGroupCompletedTasks]);
  const projectSectionIds = useMemo(() => projectSections.map((section) => section.id), [projectSections]);
  const hasProjectReorderItems = projectReorderGroups.some((group) => group.tasks.length > 0) || projectSections.length > 1;
  const groupByOptions: ReferenceGroupBy[] = ['none', 'area', 'project', 'tag'];
  const getReferenceGroupLabel = useCallback((groupBy: ReferenceGroupBy) => {
    switch (groupBy) {
      case 'none':
        return tFallback(t, 'list.groupByNone', 'No grouping');
      case 'area':
        return tFallback(t, 'list.groupByArea', 'Area');
      case 'project':
        return tFallback(t, 'taskEdit.projectLabel', 'Project');
      case 'tag':
        return tFallback(t, 'taskEdit.tagsLabel', 'Tags');
      default:
        return groupBy;
    }
  }, [t]);
  const groupByLabel = getReferenceGroupLabel(activeGroupBy);
  const groupLabel = tFallback(t, 'list.groupBy', 'Group');
  const showGroupControl = !projectId && Boolean(handleChangeGroupBy);
  const staticListVirtualWindow = useMemo(() => {
    const effectiveViewportHeight = resolveStaticListViewportHeight(
      staticListVirtualization?.viewportHeight ?? 0,
      windowHeight,
    );
    if (
      !staticList
      || projectReorderMode
      || !staticListVirtualization
      || effectiveViewportHeight <= 0
      || listItems.length <= STATIC_LIST_VIRTUALIZATION_THRESHOLD
    ) {
      return null;
    }

    return buildStaticListVirtualWindow(listItems, {
      listOffsetY: taskListRootOffsetY + staticListOffsetY,
      overscan: STATIC_LIST_OVERSCAN,
      rowEstimate: STATIC_LIST_ROW_ESTIMATE,
      scrollOffsetY: staticListVirtualization.scrollOffsetY,
      viewportHeight: effectiveViewportHeight,
    });
  }, [
    listItems,
    projectReorderMode,
    staticList,
    staticListOffsetY,
    staticListVirtualization,
    taskListRootOffsetY,
    windowHeight,
  ]);
  // Keep the draggable pan handler on the handle strip so vertical scrolling still works.
  // DraggableFlatList gesture props: https://github.com/computerjazz/react-native-draggable-flatlist#props
  const projectDragHitSlop = useMemo(() => ({
    bottom: 0,
    left: -Math.max(windowWidth - 96, 0),
    right: 0,
    top: 0,
  }), [windowWidth]);

  const handleToggleProjectReorderMode = useCallback(() => {
    if (!canUseProjectReorder) return;
    exitSelectionMode();
    setProjectReorderMode(!projectReorderMode);
  }, [canUseProjectReorder, exitSelectionMode, projectReorderMode, setProjectReorderMode]);

  const handleProjectTaskDragEnd = useCallback((
    sectionId: string | null | undefined,
    params: DragEndParams<Task>,
  ) => {
    if (!projectId) return;
    if (params.from === params.to) return;
    const orderedIds = params.data.map((task) => task.id);

    void Promise.resolve(reorderProjectTasks(projectId, orderedIds, sectionId)).catch((error) => {
      void logError(error, { scope: 'project', extra: { message: 'Failed to reorder project tasks' } });
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'projects.taskReorderFailed', 'Failed to reorder tasks.'),
        tone: 'error',
      });
    });
  }, [projectId, reorderProjectTasks, showToast, t]);

  const handleProjectSectionMove = useCallback((sectionId: string, offset: -1 | 1) => {
    if (!projectId) return;
    const currentIndex = projectSectionIds.indexOf(sectionId);
    const nextIndex = currentIndex + offset;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= projectSectionIds.length) return;
    const nextIds = [...projectSectionIds];
    const [moved] = nextIds.splice(currentIndex, 1);
    if (!moved) return;
    nextIds.splice(nextIndex, 0, moved);
    void Promise.resolve(reorderSections(projectId, nextIds)).catch((error) => {
      void logError(error, { scope: 'project', extra: { message: 'Failed to reorder project sections' } });
      showToast({
        title: t('common.notice'),
        message: tFallback(t, 'projects.sectionReorderFailed', 'Failed to reorder sections.'),
        tone: 'error',
      });
    });
  }, [projectId, projectSectionIds, reorderSections, showToast, t]);

  const contextOptions = useMemo(() => {
    if (!quickAddAvailable) return [];
    return getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' });
  }, [quickAddAvailable, tasks]);
  const tagOptions = useMemo(() => {
    if (!quickAddCopilotEnabled) return [];
    return getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' });
  }, [quickAddCopilotEnabled, tasks]);

  const bulkMoveStatusOptions = useMemo(
    () => getBulkMoveStatusOptions(statusFilter),
    [statusFilter],
  );

  const bulkBarProps = useMemo<TaskListBulkBarProps | null>(() => {
    if (!enableBulkActions || !selectionMode || projectReorderMode) return null;
    return {
      bulkActionLabel,
      bulkActionLoading,
      handleBatchDelete,
      handleBatchMove,
      hasSelection,
      onExitSelectionMode: exitSelectionMode,
      onOpenOrganize: canBulkOrganizeSelection ? () => setBulkOrganizeVisible(true) : undefined,
      onOpenTagModal: () => setTagModalVisible(true),
      onToggleRangeSelectMode: toggleRangeSelectMode,
      rangeSelectMode,
      selectedCount: selectedIdsArray.length,
      statusOptions: bulkMoveStatusOptions,
      t,
      themeColors: themeColorsMemo,
    };
  }, [
    bulkActionLabel,
    bulkActionLoading,
    bulkMoveStatusOptions,
    canBulkOrganizeSelection,
    enableBulkActions,
    exitSelectionMode,
    handleBatchDelete,
    handleBatchMove,
    hasSelection,
    projectReorderMode,
    rangeSelectMode,
    selectedIdsArray.length,
    selectionMode,
    setTagModalVisible,
    t,
    themeColorsMemo,
    toggleRangeSelectMode,
  ]);

  useEffect(() => {
    onBulkBarPropsChange?.(bulkBarProps);
  }, [bulkBarProps, onBulkBarPropsChange]);

  useEffect(() => () => {
    onBulkBarPropsChange?.(null);
  }, [onBulkBarPropsChange]);

  const shouldRenderInlineBulkBar = Boolean(
    bulkBarProps && (bulkBarPlacement !== 'external' || !onBulkBarPropsChange),
  );

  type TriggerType = 'project' | 'context';
  type TriggerState = { type: TriggerType; start: number; end: number; query: string };
  type Option =
    | { kind: 'create'; label: string; value: string }
    | { kind: 'project'; label: string; value: string }
    | { kind: 'context'; label: string; value: string };

  const getTrigger = useCallback((text: string, caret: number): TriggerState | null => {
    if (caret < 0) return null;
    const before = text.slice(0, caret);
    const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n'), before.lastIndexOf('\t'));
    const start = lastSpace + 1;
    const token = before.slice(start);
    if (!token.startsWith('+') && !token.startsWith('@')) return null;
    return {
      type: token.startsWith('+') ? 'project' : 'context',
      start,
      end: caret,
      query: token.slice(1),
    };
  }, []);

  const trigger = useMemo(() => {
    return getTrigger(newTaskTitle, inputSelection.start ?? newTaskTitle.length);
  }, [getTrigger, inputSelection.start, newTaskTitle]);

  const typeaheadOptions = useMemo<Option[]>(() => {
    if (!quickAddAvailable || !trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    if (trigger.type === 'project') {
      const matches = projects
        .filter(isSelectableProjectForTaskAssignment)
        .filter((project) => project.title.toLowerCase().includes(query));
      const hasExact = query.length > 0 && projects.some((project) => project.title.toLowerCase() === query);
      const result: Option[] = [];
      if (!hasExact && query.length > 0) {
        const title = trigger.query.trim();
        result.push({
          kind: 'create' as const,
          label: `${tFallback(t, 'projects.create', 'Create')} "${title}"`,
          value: title,
        });
      }
      result.push(
        ...matches.map((project) => ({
          kind: 'project' as const,
          label: project.title,
          value: project.title,
        }))
      );
      return result;
    }
    const matches = contextOptions.filter((context) => {
      const raw = context.startsWith('@') || context.startsWith('#') ? context.slice(1) : context;
      return raw.toLowerCase().includes(query);
    });
    return matches.map((context) => ({
      kind: 'context' as const,
      label: context,
      value: context,
    }));
  }, [contextOptions, projects, quickAddAvailable, t, trigger]);

  useEffect(() => {
    if (!trigger || typeaheadOptions.length === 0) {
      setTypeaheadOpen(false);
      return;
    }
    setTypeaheadOpen(true);
  }, [trigger, typeaheadOptions.length]);

  useEffect(() => {
    if (!quickAddCopilotEnabled) {
      setAiKey('');
      return;
    }
    loadAIKey(aiProvider).then(setAiKey).catch((error) => {
      void logError(error, { scope: 'ai', extra: { message: 'Failed to load AI key' } });
      showToast({
        title: t('ai.errorTitle'),
        message: t('ai.disabledBody'),
        tone: 'warning',
        durationMs: 4200,
      });
    });
  }, [aiProvider, quickAddCopilotEnabled, showToast, t]);

  useEffect(() => {
    if (!quickAddCopilotEnabled || (keyRequired && !aiKey)) {
      setCopilotSuggestion(null);
      setCopilotThinking(false);
      return;
    }
    const title = newTaskTitle.trim();
    if (title.length < 4) {
      setCopilotSuggestion(null);
      setCopilotThinking(false);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const requestId = copilotRequestIdRef.current + 1;
      copilotRequestIdRef.current = requestId;
      setCopilotThinking(true);
      try {
        if (copilotAbortRef.current) copilotAbortRef.current.abort();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        copilotAbortRef.current = abortController;
        const provider = createAIProvider(buildCopilotConfig(settings, aiKey));
        const suggestion = await provider.predictMetadata(
          { title, contexts: contextOptions, tags: tagOptions },
          abortController ? { signal: abortController.signal } : undefined
        );
        if (cancelled) return;
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
        if (!cancelled && copilotRequestIdRef.current === requestId) {
          setCopilotThinking(false);
        }
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
  }, [aiKey, aiProvider, contextOptions, keyRequired, newTaskTitle, quickAddCopilotEnabled, settings, statusFilter, tagOptions, timeEstimatesEnabled]);

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

  const handleAddTask = async (options: AddTaskOptions = {}) => {
    if (!newTaskTitle.trim()) return;

    const defaultStatus: TaskStatus = 'inbox';

    const { title: parsedTitle, props, projectTitle, invalidDateCommands } = parseQuickAdd(newTaskTitle, projects, new Date(), areas, {
      defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || undefined,
      preserveText: settings.quickAddAutoClean !== true,
    });
    if (invalidDateCommands && invalidDateCommands.length > 0) {
      showToast({
        title: t('common.notice'),
        message: `${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`,
        tone: 'warning',
        durationMs: 4200,
      });
      return;
    }
    const finalTitle = parsedTitle || newTaskTitle;
    if (!finalTitle.trim()) return;

    const initialProps: Partial<Task> = { projectId, status: defaultStatus, ...props };
    if (
      initialProps.projectId
      && !projects.some((project) => project.id === initialProps.projectId && isSelectableProjectForTaskAssignment(project))
    ) {
      delete initialProps.projectId;
    }
    if (!props.status) initialProps.status = defaultStatus;
    if (!props.projectId && projectId) initialProps.projectId = projectId;
    if (!initialProps.projectId && projectTitle) {
      const inactiveProject = projects.find((project) => (
        project.title.toLowerCase() === projectTitle.toLowerCase()
        && !isSelectableProjectForTaskAssignment(project)
      ));
      if (inactiveProject) return;
      const created = await addProject(
        projectTitle,
        DEFAULT_PROJECT_COLOR,
        getQuickAddProjectInitialProps(initialProps, quickAddNewTaskAreaId)
      );
      if (!created) return;
      initialProps.projectId = created.id;
    }
    if (!initialProps.projectId && !props.areaId) {
      initialProps.areaId = quickAddNewTaskAreaId;
    }
    if (initialProps.projectId) {
      initialProps.areaId = undefined;
    }
    if (copilotContext) {
      const nextContexts = Array.from(new Set([...(initialProps.contexts ?? []), copilotContext]));
      initialProps.contexts = nextContexts;
    }
    if (copilotTags.length) {
      const nextTags = Array.from(new Set([...(initialProps.tags ?? []), ...copilotTags]));
      initialProps.tags = nextTags;
    }
    if (quickAddFocus && canQuickAddFocus) {
      initialProps.isFocusedToday = true;
    }

    const result = await addTask(finalTitle, initialProps);
    const resultObject = result && typeof result === 'object'
      ? result as { success?: boolean; id?: string }
      : null;
    if (resultObject?.success === false) return;
    const createdTaskId = typeof resultObject?.id === 'string' ? resultObject.id : undefined;
    newTaskTitleRef.current = '';
    inputSelectionRef.current = { start: 0, end: 0 };
    setNewTaskTitle('');
    setInputSelection({ start: 0, end: 0 });
    setTypeaheadOpen(false);
    setCopilotSuggestion(null);
    setCopilotApplied(false);
    setCopilotContext(undefined);
    setCopilotTags([]);
    setQuickAddFocus(false);

    if (options.openAfterCreate && createdTaskId) {
      const createdTask = useTaskStore.getState()._allTasks.find((task) => task.id === createdTaskId && !task.deletedAt);
      if (createdTask) {
        setHighlightTask(createdTaskId);
        setEditingTask(createdTask);
        setIsModalVisible(true);
      }
      return;
    }

    refocusQuickAddInput();
  };

  const applyTypeaheadOption = useCallback(async (option: Option) => {
    const currentTitle = newTaskTitleRef.current;
    const currentSelection = inputSelectionRef.current;
    const activeTrigger = getTrigger(currentTitle, currentSelection.start ?? currentTitle.length) ?? trigger;
    if (!activeTrigger) return;
    const expectedTriggerType = option.kind === 'create' ? 'project' : option.kind;
    if (activeTrigger.type !== expectedTriggerType) return;

    let tokenValue = option.value;
    if (option.kind === 'create') {
      const title = option.value.trim();
      if (title) {
        await addProject(
          title,
          DEFAULT_PROJECT_COLOR,
          getQuickAddProjectInitialProps({}, defaultNewTaskAreaId)
        );
      }
    }
    if (activeTrigger.type === 'project') {
      tokenValue = `+${tokenValue}`;
    } else {
      tokenValue = tokenValue.startsWith('@') ? tokenValue : `@${tokenValue}`;
    }
    const before = currentTitle.slice(0, activeTrigger.start);
    const after = currentTitle.slice(activeTrigger.end);
    const needsSpace = after.length > 0 && !/^\s/.test(after);
    const nextValue = `${before}${tokenValue}${needsSpace ? ' ' : ''}${after}`;
    newTaskTitleRef.current = nextValue;
    setNewTaskTitle(nextValue);
    const caret = before.length + tokenValue.length + (needsSpace ? 1 : 0);
    const nextSelection = { start: caret, end: caret };
    inputSelectionRef.current = nextSelection;
    setInputSelection(nextSelection);
    setTypeaheadOpen(false);
    setTypeaheadIndex(0);
  }, [addProject, defaultNewTaskAreaId, getTrigger, trigger]);

  const handleEditTask = useCallback((task: Task) => {
    setEditingTask(task);
    setIsModalVisible(true);
  }, []);

  const onSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
    const diagnostic = beginMobilePerformanceDiagnostic({
      operation: 'task_save_to_list',
      route: performanceRoute,
      listItemCount: listItemCountForDiagnostics,
    });
    const result = updateTask(taskId, updates);
    setIsModalVisible(false);
    setEditingTask(null);
    void Promise.resolve(result).finally(() => {
      void finishMobilePerformanceDiagnostic(diagnostic, {
        visibleItemCount: listItemCountForDiagnostics,
      });
    });
  }, [listItemCountForDiagnostics, performanceRoute, updateTask]);

  const sortOptions: TaskSortBy[] = ['default', 'due', 'start', 'review', 'title', 'created', 'created-desc'];
  // Single-status lists (inbox/next/waiting/someday/done/reference) repeat the same status on every
  // row, so show a compact icon button to change status instead of the redundant status-name badge.
  // The 'all' list keeps the labeled badge because its rows have mixed statuses.
  const statusBadgeAsIconForList = statusFilter !== 'all';
  const hideChecklistProgressForList = statusFilter === 'inbox';
  const handleTaskStatusChange = useCallback((taskId: string, status: TaskStatus) => {
    const diagnostic = beginMobilePerformanceDiagnostic({
      operation: status === 'done' ? 'task_done_to_list' : 'task_mutation',
      route: performanceRoute,
      listItemCount: listItemCountForDiagnostics,
    });
    const result = updateTask(taskId, { status });
    void Promise.resolve(result).finally(() => {
      void finishMobilePerformanceDiagnostic(diagnostic, {
        visibleItemCount: listItemCountForDiagnostics,
      });
    });
  }, [listItemCountForDiagnostics, performanceRoute, updateTask]);

  const renderTask = useCallback(({ item }: { item: Task }) => {
    const sequenceCue = getTaskSequenceCue?.(item);
    const sequenceLabel = sequenceCue ? sequenceCueLabels?.[sequenceCue] : undefined;

    return (
      <ErrorBoundary>
        <SwipeableTaskItem
          task={item}
          isDark={isDark}
          tc={themeColorsMemo}
          onPress={() => handleEditTask(item)}
          selectionMode={enableBulkActions ? selectionMode : false}
          isMultiSelected={enableBulkActions && multiSelectedIds.has(item.id)}
          onToggleSelect={enableBulkActions ? () => toggleMultiSelect(item.id, { visibleTaskIds: orderedTaskIds }) : undefined}
          onStatusChange={(status) => handleTaskStatusChange(item.id, status as TaskStatus)}
          onDelete={() => { void deleteTask(item.id); }}
          isHighlighted={item.id === highlightTaskId}
          statusBadgeAsIcon={statusBadgeAsIconForList}
          hideChecklistProgress={hideChecklistProgressForList}
          hideProjectMeta={Boolean(projectId)}
          sequenceCue={sequenceCue}
          sequenceLabel={sequenceLabel}
          rowContext={rowContext}
          onProjectPress={projectId ? undefined : openProjectScreen}
          onContextPress={openContextsScreen}
          onTagPress={openContextsScreen}
        />
      </ErrorBoundary>
    );
  }, [
    deleteTask,
    enableBulkActions,
    getTaskSequenceCue,
    handleEditTask,
    handleTaskStatusChange,
    highlightTaskId,
    isDark,
    multiSelectedIds,
    orderedTaskIds,
    selectionMode,
    hideChecklistProgressForList,
    statusBadgeAsIconForList,
    themeColorsMemo,
    toggleMultiSelect,
    projectId,
    sequenceCueLabels,
    rowContext,
  ]);

  const getProjectReorderItemLayout = useCallback((_: ArrayLike<Task> | null | undefined, index: number) => ({
    index,
    length: PROJECT_REORDER_ITEM_HEIGHT,
    offset: PROJECT_REORDER_ITEM_HEIGHT * index,
  }), []);

  const renderProjectReorderTask = useCallback(({ drag, isActive, item }: RenderItemParams<Task>) => {
    const statusLabel = t(`status.${item.status}`);

    return (
      <View
        style={[
          styles.projectDragTaskRow,
          { height: PROJECT_REORDER_ITEM_HEIGHT },
          isActive && styles.projectDragTaskRowActive,
        ]}
        testID={`project-task-reorder-row-${item.id}`}
      >
        <View
          style={[
            styles.projectReorderTaskCard,
            { backgroundColor: themeColorsMemo.taskItemBg, borderColor: themeColorsMemo.border },
          ]}
        >
          <Text
            numberOfLines={2}
            style={[styles.projectReorderTaskTitle, { color: themeColorsMemo.text }]}
          >
            {item.title}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.projectReorderTaskMeta, { color: themeColorsMemo.secondaryText }]}
          >
            {statusLabel}
          </Text>
        </View>
        <TouchableOpacity
          accessibilityLabel={`${tFallback(t, 'board.dragTask', 'Drag task')}: ${item.title}`}
          accessibilityRole="button"
          activeOpacity={0.85}
          disabled={isActive}
          onPressIn={drag}
          style={[
            styles.projectDragHandle,
            { backgroundColor: themeColorsMemo.filterBg, borderColor: themeColorsMemo.border },
          ]}
          testID={`project-task-drag-handle-${item.id}`}
        >
          <GripVertical size={20} color={themeColorsMemo.secondaryText} />
        </TouchableOpacity>
      </View>
    );
  }, [
    t,
    themeColorsMemo.border,
    themeColorsMemo.filterBg,
    themeColorsMemo.secondaryText,
    themeColorsMemo.taskItemBg,
    themeColorsMemo.text,
  ]);

  const renderListItem = useCallback(({ item }: { item: ListItem }) => {
    const itemKey = getListItemLayoutKey(item);
    if (item.type === 'section') {
      if (item.collapsible) {
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ expanded: item.collapsed !== true }}
            onPress={() => setCompletedTasksCollapsed((value) => !value)}
            style={styles.sectionHeader}
            onLayout={(event) => registerItemHeight(itemKey, event.nativeEvent.layout.height)}
          >
            <View style={styles.sectionHeaderTitleBlock}>
              {item.collapsed ? (
                <ChevronRight size={15} color={themeColorsMemo.secondaryText} />
              ) : (
                <ChevronDown size={15} color={themeColorsMemo.secondaryText} />
              )}
              <Text style={[styles.sectionTitle, { color: item.muted ? themeColorsMemo.secondaryText : themeColorsMemo.text }]}>
                {item.title}
              </Text>
            </View>
            <Text style={[styles.sectionCount, { color: themeColorsMemo.secondaryText }]}>
              {item.count}
            </Text>
          </TouchableOpacity>
        );
      }

      return (
        <View
          style={styles.sectionHeader}
          onLayout={(event) => registerItemHeight(itemKey, event.nativeEvent.layout.height)}
        >
          <Text style={[styles.sectionTitle, { color: item.muted ? themeColorsMemo.secondaryText : themeColorsMemo.text }]}>
            {item.title}
          </Text>
          <Text style={[styles.sectionCount, { color: themeColorsMemo.secondaryText }]}>
            {item.count}
          </Text>
        </View>
      );
    }
    return (
      <View onLayout={(event) => registerItemHeight(itemKey, event.nativeEvent.layout.height)}>
        {renderTask({ item: item.task })}
      </View>
    );
  }, [getListItemLayoutKey, registerItemHeight, renderTask, themeColorsMemo.secondaryText, themeColorsMemo.text]);

  const renderProjectReorderGroup = useCallback((group: ProjectTaskReorderGroup<Task>) => {
    const sectionIndex = typeof group.sectionId === 'string' ? projectSectionIds.indexOf(group.sectionId) : -1;
    const canReorderSection = sectionIndex >= 0 && projectSectionIds.length > 1;
    const canMoveSectionUp = canReorderSection && sectionIndex > 0;
    const canMoveSectionDown = canReorderSection && sectionIndex < projectSectionIds.length - 1;
    const moveSectionUpLabel = tFallback(t, 'projects.moveSectionUp', 'Move section up');
    const moveSectionDownLabel = tFallback(t, 'projects.moveSectionDown', 'Move section down');

    return (
      <View key={group.id} style={styles.projectDragGroup}>
        {group.title ? (
          <View style={styles.sectionHeader}>
            <View style={styles.sectionHeaderTitleBlock}>
              <Text style={[styles.sectionTitle, { color: group.muted ? themeColorsMemo.secondaryText : themeColorsMemo.text }]} numberOfLines={1}>
                {group.title}
              </Text>
              <Text style={[styles.sectionCount, { color: themeColorsMemo.secondaryText }]}>
                {group.tasks.length}
              </Text>
            </View>
            {canReorderSection && typeof group.sectionId === 'string' ? (
              <View style={styles.sectionReorderControls}>
                <TouchableOpacity
                  accessibilityLabel={`${moveSectionUpLabel}: ${group.title}`}
                  accessibilityRole="button"
                  disabled={!canMoveSectionUp}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => handleProjectSectionMove(group.sectionId as string, -1)}
                  style={[
                    styles.sectionReorderButton,
                    { borderColor: themeColorsMemo.border, backgroundColor: themeColorsMemo.filterBg },
                    !canMoveSectionUp && styles.sectionReorderButtonDisabled,
                  ]}
                >
                  <ArrowUp size={16} color={themeColorsMemo.secondaryText} />
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityLabel={`${moveSectionDownLabel}: ${group.title}`}
                  accessibilityRole="button"
                  disabled={!canMoveSectionDown}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  onPress={() => handleProjectSectionMove(group.sectionId as string, 1)}
                  style={[
                    styles.sectionReorderButton,
                    { borderColor: themeColorsMemo.border, backgroundColor: themeColorsMemo.filterBg },
                    !canMoveSectionDown && styles.sectionReorderButtonDisabled,
                  ]}
                >
                  <ArrowDown size={16} color={themeColorsMemo.secondaryText} />
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        ) : null}
        {group.tasks.length > 0 ? (
          <NestableDraggableFlatList
            data={group.tasks}
            getItemLayout={getProjectReorderItemLayout}
            keyExtractor={(task) => task.id}
            renderItem={renderProjectReorderTask}
            onDragEnd={(params) => handleProjectTaskDragEnd(group.sectionId, params)}
            activationDistance={2}
            animationConfig={PROJECT_REORDER_ANIMATION_CONFIG}
            autoscrollThreshold={80}
            autoscrollSpeed={120}
            dragItemOverflow
            dragHitSlop={projectDragHitSlop}
            style={styles.projectDragList}
            removeClippedSubviews={false}
          />
        ) : null}
      </View>
    );
  }, [
    handleProjectSectionMove,
    handleProjectTaskDragEnd,
    getProjectReorderItemLayout,
    projectDragHitSlop,
    projectSectionIds,
    renderProjectReorderTask,
    t,
    themeColorsMemo.border,
    themeColorsMemo.filterBg,
    themeColorsMemo.secondaryText,
    themeColorsMemo.text,
  ]);

  const projectReorderToggle = canUseProjectReorder && hasProjectReorderItems && !projectReorderMode ? (
    <TouchableOpacity
      accessibilityLabel={tFallback(t, 'projects.reorderTasks', 'Order')}
      accessibilityRole="button"
      onPress={handleToggleProjectReorderMode}
      style={[
        styles.projectReorderIconButton,
        { backgroundColor: themeColorsMemo.filterBg, borderColor: themeColorsMemo.border },
      ]}
      testID="project-task-reorder-toggle"
    >
      <MoveVertical size={20} color={themeColorsMemo.secondaryText} />
    </TouchableOpacity>
  ) : null;

  return (
    <View
      style={[styles.container, { backgroundColor: themeColorsMemo.bg }]}
      onLayout={handleTaskListRootLayout}
    >
      <TaskListHeader
        activeFilterChips={activeFilterChips}
        count={orderedTasks.length}
        filterActiveCount={totalFilterActiveCount}
        groupByLabel={showGroupControl ? groupByLabel : undefined}
        hasActiveFilters={hasAnyActiveFilters}
        headerAccessory={headerAccessory}
        onClearFilters={clearAllFilters}
        onOpenFilters={() => setFiltersVisible(true)}
        onOpenGroup={showGroupControl ? () => setReferenceGroupModalVisible(true) : undefined}
        onOpenSort={() => setSortModalVisible(true)}
        showHeader={showHeader}
        showFilterButton={showFilterButton}
        showSort={showSort}
        sortByLabel={t(`sort.${sortBy}`)}
        t={t}
        themeColors={themeColorsMemo}
        title={title}
      />

      {primaryActionRow}

      <TaskListFiltersSheet
        energyLevelOptions={ENERGY_LEVEL_OPTIONS}
        hasFilters={hasAnyActiveFilters}
        locationQuery={locationFilter}
        onChangeLocationQuery={setLocationFilter}
        onChangeSearchQuery={setTaskSearchQuery}
        onClearFilters={clearAllFilters}
        onClose={() => setFiltersVisible(false)}
        showPriorityFilters={showPriorityFilters}
        priorityOptions={PRIORITY_OPTIONS}
        searchQuery={taskSearchQuery}
        selectedEnergyLevels={selectedEnergyLevels}
        selectedPriorities={selectedPriorities}
        selectedTimeEstimates={selectedTimeEstimates}
        selectedTokens={selectedTokens}
        contextMatchMode={contextMatchMode}
        contextMatchModeLabels={{
          title: tFallback(t, 'filters.contextMatchMode', 'Context match'),
          any: tFallback(t, 'filters.matchAny', 'Any'),
          all: tFallback(t, 'common.all', 'All'),
        }}
        onChangeContextMatchMode={updateContextMatchMode}
        showContextMatchMode={showContextMatchMode}
        showEnergyLevelFilters={showEnergyLevelFilters}
        showLocationFilter={showLocationFilter}
        showTimeEstimateFilters={showTimeEstimateFilters}
        t={t}
        themeColors={themeColorsMemo}
        toggleEnergyLevel={toggleEnergyLevelFilter}
        togglePriority={togglePriorityFilter}
        toggleTimeEstimate={toggleTimeEstimate}
        toggleToken={toggleTokenFilter}
        tokenOptions={tokenFilterOptions}
        visible={filtersVisible}
      />

      {shouldRenderInlineBulkBar && bulkBarProps ? (
        <TaskListBulkBar {...bulkBarProps} />
      ) : null}

      {canUseProjectReorder && hasProjectReorderItems && projectReorderMode && (
        <View style={[styles.projectReorderModeBar, { backgroundColor: themeColorsMemo.cardBg, borderBottomColor: themeColorsMemo.border }]}>
          <Text style={[styles.projectReorderTitle, { color: themeColorsMemo.text }]}>
            {projectSections.length > 1
              ? tFallback(t, 'projects.projectOrder', 'Project order')
              : tFallback(t, 'projects.taskOrder', 'Task order')}
          </Text>
          <TouchableOpacity
            accessibilityLabel={projectReorderMode
              ? t('common.done')
              : tFallback(t, 'projects.reorderTasks', 'Order tasks')}
            accessibilityRole="button"
            onPress={handleToggleProjectReorderMode}
            style={[
              styles.projectReorderModeButton,
              {
                backgroundColor: themeColorsMemo.tint,
                borderColor: themeColorsMemo.tint,
              },
            ]}
            testID="project-task-reorder-toggle"
          >
            <Text style={[
              styles.projectReorderModeButtonText,
              { color: themeColorsMemo.onTint },
            ]}>
              {t('common.done')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {quickAddAvailable && (
        <TaskListQuickAdd
          aiEnabled={aiEnabled}
          applyTypeaheadOption={applyTypeaheadOption}
          copilotApplied={copilotApplied}
          copilotContext={copilotContext}
          copilotSuggestion={copilotSuggestion}
          copilotTags={copilotTags}
          copilotThinking={copilotThinking}
          enableCopilot={enableCopilot}
          handleAddAndEditTask={projectId ? () => handleAddTask({ openAfterCreate: true }) : undefined}
          handleAddTask={handleAddTask}
          focusNewTask={quickAddFocus}
          canFocusNewTask={canQuickAddFocus}
          focusNewTaskDisabledReason={quickAddFocusDisabledReason}
          inputRef={quickAddInputRef}
          newTaskTitle={newTaskTitle}
          onApplyCopilot={() => {
            setCopilotContext(copilotSuggestion?.context);
            setCopilotTags(copilotSuggestion?.tags ?? []);
            setCopilotApplied(true);
          }}
          onChangeText={(text) => {
            newTaskTitleRef.current = text;
            setNewTaskTitle(text);
            const nextSelection = { start: text.length, end: text.length };
            inputSelectionRef.current = nextSelection;
            setInputSelection(nextSelection);
            setCopilotApplied(false);
            setCopilotContext(undefined);
            setCopilotTags([]);
          }}
          onInputFocus={onQuickAddInputFocus}
          onSelectionChange={(selection) => {
            inputSelectionRef.current = selection;
            setInputSelection(selection);
            const currentTitle = newTaskTitleRef.current;
            setTypeaheadOpen(Boolean(getTrigger(currentTitle, selection.start ?? currentTitle.length)));
          }}
          onToggleFocusNewTask={() => setQuickAddFocus((current) => !current)}
          projectId={projectId}
          setTypeaheadIndex={setTypeaheadIndex}
          showQuickAddHelp={showQuickAddHelp}
          t={t}
          themeColors={themeColorsMemo}
          title={title}
          trailingAccessory={projectReorderToggle}
          trigger={trigger}
          typeaheadIndex={typeaheadIndex}
          typeaheadOpen={typeaheadOpen}
          typeaheadOptions={typeaheadOptions}
        />
      )}

      {projectReorderMode && canUseProjectReorder ? (
        projectReorderOwnsScroll && projectReorderGroups.length === 1 ? (
          // Section-less projects own the scroll, so a single virtualizing list keeps long
          // lists responsive and tracks the finger (the nested variant disables windowing).
          <DraggableFlatList
            data={projectReorderGroups[0].tasks}
            keyExtractor={(task) => task.id}
            getItemLayout={getProjectReorderItemLayout}
            renderItem={renderProjectReorderTask}
            onDragEnd={(params) => handleProjectTaskDragEnd(projectReorderGroups[0].sectionId, params)}
            activationDistance={2}
            animationConfig={PROJECT_REORDER_ANIMATION_CONFIG}
            autoscrollThreshold={80}
            autoscrollSpeed={120}
            dragItemOverflow
            dragHitSlop={projectDragHitSlop}
            keyboardShouldPersistTaps="handled"
            initialNumToRender={14}
            maxToRenderPerBatch={12}
            windowSize={7}
            removeClippedSubviews={false}
            style={styles.projectDragSelfScrollList}
            contentContainerStyle={styles.projectDragSelfScrollContent}
          />
        ) : (
          <View style={styles.staticList}>
            {projectReorderGroups.map(renderProjectReorderGroup)}
          </View>
        )
      ) : staticList ? (
        <View style={styles.staticList} onLayout={handleStaticListLayout}>
          {listItems.length === 0 ? (
            <ListEmptyState
              message={filteredEmptyMessage}
              hint={filteredEmptyHint}
              backgroundColor={themeColorsMemo.cardBg}
              borderColor={themeColorsMemo.border}
              textColor={themeColorsMemo.text}
              mutedTextColor={themeColorsMemo.secondaryText}
              actionLabel={filteredEmptyActionLabel}
              onAction={filteredEmptyAction}
            />
          ) : staticListVirtualWindow ? (
            <>
              {staticListVirtualWindow.topSpacerHeight > 0 ? (
                <View style={{ height: staticListVirtualWindow.topSpacerHeight }} />
              ) : null}
              {staticListVirtualWindow.items.map((item) => (
                <View key={getListItemKey(item)} style={styles.staticItem}>
                  {renderListItem({ item })}
                </View>
              ))}
              {staticListVirtualWindow.bottomSpacerHeight > 0 ? (
                <View style={{ height: staticListVirtualWindow.bottomSpacerHeight }} />
              ) : null}
            </>
          ) : (
            listItems.map((item) => (
              <View key={getListItemKey(item)} style={styles.staticItem}>
                {renderListItem({ item })}
              </View>
            ))
          )}
        </View>
      ) : (
        <FlatList
          data={listItems}
          renderItem={renderListItem}
          keyExtractor={getVirtualizedListItemKey}
          style={styles.list}
          contentContainerStyle={listContentStyle}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          getItemLayout={getItemLayout}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={listItems.length >= REMOVE_CLIPPED_SUBVIEWS_MIN_ITEMS}
          refreshControl={
            <RefreshControl
              refreshing={pullSync.refreshing}
              onRefresh={pullSync.onRefresh}
              tintColor="transparent"
              colors={['transparent']}
              progressBackgroundColor="transparent"
            />
          }
          ListEmptyComponent={
            <ListEmptyState
              message={filteredEmptyMessage}
              hint={filteredEmptyHint}
              backgroundColor={themeColorsMemo.cardBg}
              borderColor={themeColorsMemo.border}
              textColor={themeColorsMemo.text}
              mutedTextColor={themeColorsMemo.secondaryText}
              actionLabel={filteredEmptyActionLabel}
              onAction={filteredEmptyAction}
            />
          }
        />
      )}

      <PullSyncIndicator state={pullSync.indicatorState} />

      <TaskListTagModal
        onChangeTag={setTagInput}
        onClose={() => {
          setTagModalVisible(false);
          setTagInput('');
        }}
        onSave={handleBatchAddTag}
        t={t}
        tagInput={tagInput}
        themeColors={themeColorsMemo}
        visible={tagModalVisible}
      />

      <TaskListBulkOrganizeModal
        areas={areas}
        isApplying={bulkActionLoading}
        onApply={async (input) => {
          await handleBatchOrganize(input);
          setBulkOrganizeVisible(false);
        }}
        onClose={() => setBulkOrganizeVisible(false)}
        projects={projects}
        selectedCount={selectedIdsArray.length}
        t={t}
        themeColors={themeColorsMemo}
        visible={bulkOrganizeVisible}
      />

      <TaskListSortModal
        onClose={() => setSortModalVisible(false)}
        onSelect={(option) => {
          updateSettings({ taskSortBy: option });
          setSortModalVisible(false);
        }}
        sortBy={sortBy}
        sortOptions={sortOptions}
        t={t}
        themeColors={themeColorsMemo}
        visible={sortModalVisible}
      />

      {showGroupControl && (
        <Modal
          visible={referenceGroupModalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setReferenceGroupModalVisible(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setReferenceGroupModalVisible(false)}>
            <View style={[styles.modalCard, { backgroundColor: themeColorsMemo.cardBg }]}>
              <Text style={[styles.modalTitle, { color: themeColorsMemo.text }]}>{groupLabel}</Text>
              <View style={styles.sortList}>
                {groupByOptions.map((option) => (
                  <Pressable
                    key={option}
                    onPress={() => {
                      handleChangeGroupBy?.(option);
                      setReferenceGroupModalVisible(false);
                    }}
                    style={[
                      styles.sortItem,
                      option === activeGroupBy && { backgroundColor: themeColorsMemo.filterBg },
                    ]}
                  >
                    <Text style={[styles.sortItemText, { color: themeColorsMemo.text }]}>
                      {getReferenceGroupLabel(option)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </Pressable>
        </Modal>
      )}

      <ErrorBoundary>
        <TaskEditModal
          visible={isModalVisible}
          task={editingTask}
          onClose={() => setIsModalVisible(false)}
          onSave={onSaveTask}
          defaultTab={defaultEditTab}
          onProjectNavigate={projectId ? undefined : openProjectScreen}
          onContextNavigate={openContextsScreen}
          onTagNavigate={openContextsScreen}
          onFocusMode={(taskId) => {
            setIsModalVisible(false);
            router.push(`/check-focus?id=${taskId}`);
          }}
        />
      </ErrorBoundary>
    </View>
  );
}

export const TaskList = React.memo(TaskListComponent);
