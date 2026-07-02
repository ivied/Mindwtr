import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, Area, Project, Task } from '@mindwtr/core';

const addTaskMock = vi.hoisted(() => vi.fn());
const addProjectMock = vi.hoisted(() => vi.fn());
const updateTaskMock = vi.hoisted(() => vi.fn());
const setHighlightTaskMock = vi.hoisted(() => vi.fn());
const quickAddPropsSpy = vi.hoisted(() => vi.fn());
const quickAddFocusMock = vi.hoisted(() => vi.fn());
const selectedAreaIdForNewTasksMock = vi.hoisted(() => ({ current: undefined as string | null | undefined }));
const taskEditModalPropsSpy = vi.hoisted(() => vi.fn());
const bulkOrganizeModalPropsSpy = vi.hoisted(() => vi.fn());
const parseQuickAddMock = vi.hoisted(() => vi.fn());
const taskListHeaderPropsSpy = vi.hoisted(() => vi.fn());
const taskListSelectionState = vi.hoisted(() => ({
  current: {
    bulkActionLabel: 'Move',
    bulkActionLoading: false,
    exitSelectionMode: vi.fn(),
    handleBatchAddTag: vi.fn(),
    handleBatchDelete: vi.fn(),
    handleBatchOrganize: vi.fn(),
    handleBatchMove: vi.fn(),
    hasSelection: false,
    multiSelectedIds: new Set<string>(),
    rangeSelectMode: false,
    selectedIdsArray: [] as string[],
    selectionMode: false,
    setTagInput: vi.fn(),
    setTagModalVisible: vi.fn(),
    tagInput: '',
    tagModalVisible: false,
    toggleMultiSelect: vi.fn(),
    toggleRangeSelectMode: vi.fn(),
  },
}));

const projectFixture = vi.hoisted(() => ({
  id: 'project-1',
  title: 'Launch',
  color: '#2563eb',
  order: 0,
  status: 'active',
  tagIds: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
}));

const project = projectFixture as Project;

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title,
  status: 'next',
  projectId: project.id,
  tags: [],
  contexts: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  ...overrides,
});

const storeState = vi.hoisted(() => ({
  tasks: [] as Task[],
  _allTasks: [] as Task[],
  projects: [projectFixture as Project],
  sections: [],
  areas: [] as Area[],
  addTask: addTaskMock,
  addProject: addProjectMock,
  updateTask: updateTaskMock,
  deleteTask: vi.fn(),
  restoreTask: vi.fn(),
  batchMoveTasks: vi.fn(),
  batchDeleteTasks: vi.fn(),
  batchUpdateTasks: vi.fn(),
  reorderProjectTasks: vi.fn(),
  reorderSections: vi.fn(),
  settings: {
    ai: { enabled: false },
    appearance: {},
    features: {},
  } as AppSettings,
  getDerivedState: vi.fn(() => ({
    focusedCount: storeState._allTasks.filter((task) => task.isFocusedToday).length,
  })),
  updateSettings: vi.fn(),
  highlightTaskId: null as string | null,
  setHighlightTask: setHighlightTaskMock,
}));

vi.mock('react-native', () => ({
  FlatList: ({ data, ListEmptyComponent, ListHeaderComponent, renderItem }: any) => React.createElement(
    'FlatList',
    null,
    typeof ListHeaderComponent === 'function' ? React.createElement(ListHeaderComponent) : ListHeaderComponent,
    data?.length
      ? data.map((item: unknown, index: number) => renderItem?.({ item, index }))
      : (typeof ListEmptyComponent === 'function' ? React.createElement(ListEmptyComponent) : ListEmptyComponent),
  ),
  Modal: ({ children, visible, ...props }: any) => (visible ? React.createElement('Modal', props, children) : null),
  Pressable: ({ children, onPress, ...props }: any) => React.createElement('Pressable', { ...props, onPress }, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles },
  Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
  TextInput: () => React.createElement('TextInput'),
  TouchableOpacity: ({ children, onPress, ...props }: any) => React.createElement('TouchableOpacity', { ...props, onPress }, children),
  View: ({ children, ...props }: any) => React.createElement('View', props, children),
  useWindowDimensions: () => ({ width: 390, height: 800 }),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
}));

vi.mock('lucide-react-native', () => ({
  ArrowDown: () => null,
  ArrowUp: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  GripVertical: () => null,
  MoveVertical: () => null,
}));

vi.mock('react-native-draggable-flatlist', () => ({
  default: (props: any) => React.createElement('DraggableFlatList', props),
  NestableDraggableFlatList: (props: any) => React.createElement('NestableDraggableFlatList', props),
  ScaleDecorator: ({ children, ...props }: any) => React.createElement('ScaleDecorator', props, children),
}));

vi.mock('@mindwtr/core', () => {
  const useTaskStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  );

  return {
    DEFAULT_PROJECT_COLOR: '#2563eb',
    createAIProvider: vi.fn(),
    formatFocusTaskLimitText: (template: string, limit: number) => (
      template.includes('{{count}}') ? template.replace('{{count}}', String(limit)) : `Max ${limit} focus items.`
    ),
    getDefaultTaskAreaMode: (settings: any) => {
      const mode = settings?.gtd?.defaultAreaMode;
      if (mode === 'none' || mode === 'fixed' || mode === 'active') return mode;
      return settings?.gtd?.defaultAreaId ? 'fixed' : 'none';
    },
    getQuickAddProjectInitialProps: vi.fn(() => ({})),
    getTranslationsSync: vi.fn(() => ({ 'trash.restoreToInbox': 'Restore' })),
    getTaskMetadataFilterVisibility: vi.fn(() => ({
      showEnergy: true,
      showLocation: true,
      showPriority: true,
      showTimeEstimate: true,
    })),
    getUsedTaskTokens: vi.fn(() => []),
    hasActiveFilterCriteria: vi.fn(() => false),
    isSelectableProjectForTaskAssignment: (item: Project) => item.status === 'active' && !item.deletedAt,
    isTaskInActiveProject: vi.fn(() => true),
    matchesTask: vi.fn(() => true),
    normalizeClockTimeInput: (value?: string | null) => String(value ?? '').trim(),
    normalizeFocusTaskLimit: (value: unknown) => (typeof value === 'number' ? value : 3),
    parseQuickAdd: parseQuickAddMock,
    parseSearchQuery: vi.fn(() => ({ filters: [], text: '' })),
    resolveDefaultNewTaskAreaId: (settings: any, areas: any[]) => {
      const mode = settings?.gtd?.defaultAreaMode ?? (settings?.gtd?.defaultAreaId ? 'fixed' : 'none');
      if (mode !== 'fixed') return undefined;
      const areaId = settings?.gtd?.defaultAreaId;
      return typeof areaId === 'string' && areas.some((area) => area.id === areaId && !area.deletedAt)
        ? areaId
        : undefined;
    },
    shallow: Object.is,
    sortTasksBy: (tasks: Task[]) => tasks,
    splitCompletedTasks: (tasks: Task[]) => ({ activeTasks: tasks, completedTasks: [] }),
    taskMatchesAreaFilter: vi.fn(() => true),
    taskMatchesFilterCriteria: vi.fn(() => true),
    tFallback: (t: (key: string) => string, key: string, fallback: string) => {
      const value = t(key);
      return value && value !== key ? value : fallback;
    },
    useTaskStore,
  };
});

vi.mock('./task-edit-modal', () => ({
  TaskEditModal: (props: any) => {
    taskEditModalPropsSpy(props);
    return React.createElement('TaskEditModal', { visible: props.visible, taskId: props.task?.id });
  },
}));

vi.mock('./ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => children,
}));

vi.mock('./list-empty-state', () => ({
  ListEmptyState: () => null,
}));

vi.mock('./swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) => ({
      'common.notice': 'Notice',
      'filters.clear': 'Clear',
      'filters.noMatch': 'No tasks match these filters.',
      'list.noTasks': 'No tasks',
      'quickAdd.invalidDateCommand': 'Invalid date command',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#ffffff',
    border: '#d1d5db',
    cardBg: '#ffffff',
    danger: '#dc2626',
    filterBg: '#f8fafc',
    icon: '#64748b',
    inputBg: '#ffffff',
    onTint: '#ffffff',
    secondaryText: '#64748b',
    success: '#16a34a',
    tabIconDefault: '#64748b',
    tabIconSelected: '#2563eb',
    taskItemBg: '#ffffff',
    text: '#0f172a',
    tint: '#2563eb',
    warning: '#f59e0b',
  }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({
    areaById: new Map(),
    resolvedAreaFilter: null,
    selectedAreaIdForNewTasks: selectedAreaIdForNewTasksMock.current,
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@/components/PullSyncIndicator', () => ({
  PullSyncIndicator: () => null,
}));

vi.mock('@/hooks/use-manual-pull-sync', () => ({
  useManualPullSync: () => ({
    handleRefresh: vi.fn(),
    indicatorState: 'idle',
    refreshing: false,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('../lib/ai-config', () => ({
  buildCopilotConfig: vi.fn(),
  isAIKeyRequired: vi.fn(() => false),
  loadAIKey: vi.fn(() => Promise.resolve('')),
}));

vi.mock('../lib/app-log', () => ({
  logError: vi.fn(),
}));

vi.mock('./use-task-list-selection', () => ({
  useTaskListSelection: () => taskListSelectionState.current,
}));

vi.mock('./task-list/TaskListBulkBar', () => ({
  TaskListBulkBar: (props: any) => React.createElement('TaskListBulkBar', props),
  getBulkMoveStatusOptions: (currentStatus?: string) => (
    ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'].filter((status) => status !== currentStatus)
  ),
}));

vi.mock('./task-list/TaskListBulkOrganizeModal', () => ({
  TaskListBulkOrganizeModal: (props: any) => {
    bulkOrganizeModalPropsSpy(props);
    return React.createElement('TaskListBulkOrganizeModal', props);
  },
}));

const resetTaskListSelectionState = () => {
  taskListSelectionState.current = {
    bulkActionLabel: 'Move',
    bulkActionLoading: false,
    exitSelectionMode: vi.fn(),
    handleBatchAddTag: vi.fn(),
    handleBatchDelete: vi.fn(),
    handleBatchOrganize: vi.fn(),
    handleBatchMove: vi.fn(),
    hasSelection: false,
    multiSelectedIds: new Set(),
    rangeSelectMode: false,
    selectedIdsArray: [],
    selectionMode: false,
    setTagInput: vi.fn(),
    setTagModalVisible: vi.fn(),
    tagInput: '',
    tagModalVisible: false,
    toggleMultiSelect: vi.fn(),
    toggleRangeSelectMode: vi.fn(),
  };
};

vi.mock('./task-list/TaskListFiltersSheet', () => ({
  TaskListFiltersSheet: () => null,
}));

vi.mock('./task-list/TaskListHeader', () => ({
  TaskListHeader: (props: any) => {
    taskListHeaderPropsSpy(props);
    return React.createElement('TaskListHeader', props);
  },
}));

vi.mock('./task-list/TaskListQuickAdd', () => ({
  TaskListQuickAdd: (props: any) => {
    quickAddPropsSpy(props);
    React.useEffect(() => {
      if (props.inputRef) {
        props.inputRef.current = { focus: quickAddFocusMock };
      }
      return () => {
        if (props.inputRef) props.inputRef.current = null;
      };
    }, [props.inputRef]);
    return React.createElement('TaskListQuickAdd', props);
  },
}));

vi.mock('./task-list/TaskListSortModal', () => ({
  TaskListSortModal: () => null,
}));

vi.mock('./task-list/TaskListTagModal', () => ({
  TaskListTagModal: () => null,
}));

import { TaskList } from './task-list';

const latestQuickAddProps = () => quickAddPropsSpy.mock.calls.at(-1)?.[0];
const latestHeaderProps = () => taskListHeaderPropsSpy.mock.calls.at(-1)?.[0];

describe('TaskList project quick add', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTaskListSelectionState();
    storeState.tasks = [];
    storeState._allTasks = [];
    storeState.areas = [];
    storeState.highlightTaskId = null;
    storeState.settings = {
      ai: { enabled: false },
      appearance: {},
      features: {},
    };
    selectedAreaIdForNewTasksMock.current = undefined;
    addTaskMock.mockResolvedValue({ success: true, id: 'created-task' });
    parseQuickAddMock.mockImplementation((input: string) => ({ title: input, props: {} }));
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderProjectList = () => create(
    <TaskList
      allowAdd
      projectId={project.id}
      showHeader={false}
      statusFilter="all"
      taskSource={[]}
      title={project.title}
    />,
  );

  const renderInboxList = () => create(
    <TaskList
      allowAdd
      showHeader={false}
      statusFilter="inbox"
      taskSource={[]}
      title="Inbox"
    />,
  );

  it("does not show standalone quick-add outside Inbox", async () => {
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          allowAdd
          showHeader={false}
          statusFilter="next"
          taskSource={[]}
          title="Next"
        />,
      );
    });

    expect(quickAddPropsSpy).not.toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
  });

  it('passes a group control to non-reference list headers', async () => {
    const onChangeGroupBy = vi.fn();
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          allowAdd
          groupBy="tag"
          onChangeGroupBy={onChangeGroupBy}
          showHeader={false}
          statusFilter="inbox"
          taskSource={[]}
          title="Inbox"
        />,
      );
    });

    expect(latestHeaderProps()).toEqual(expect.objectContaining({
      groupByLabel: 'Tags',
      onOpenGroup: expect.any(Function),
    }));

    act(() => {
      tree.unmount();
    });
  });

  it('publishes project selection actions to an external bulk bar with organize available', async () => {
    taskListSelectionState.current = {
      ...taskListSelectionState.current,
      hasSelection: true,
      selectedIdsArray: ['task-1', 'task-2'],
      selectionMode: true,
    };
    const onBulkBarPropsChange = vi.fn();
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          allowAdd={false}
          bulkBarPlacement="external"
          enableProjectBulkOrganize
          onBulkBarPropsChange={onBulkBarPropsChange}
          projectId={project.id}
          showHeader={false}
          statusFilter="all"
          taskSource={[]}
          title={project.title}
        />,
      );
    });

    const bulkBarProps = onBulkBarPropsChange.mock.calls.at(-1)?.[0];
    expect(bulkBarProps).toEqual(expect.objectContaining({
      hasSelection: true,
      selectedCount: 2,
    }));
    expect(typeof bulkBarProps.onOpenOrganize).toBe('function');
    expect(tree.root.findAll((node) => String(node.type) === 'TaskListBulkBar')).toHaveLength(0);

    act(() => {
      bulkBarProps.onOpenOrganize();
    });

    expect(bulkOrganizeModalPropsSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      selectedCount: 2,
      visible: true,
    }));
  });



  it('omits the current page status from bulk move options and orders Done before Reference', async () => {
    taskListSelectionState.current = {
      ...taskListSelectionState.current,
      hasSelection: true,
      selectedIdsArray: ['task-1'],
      selectionMode: true,
    };
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          allowAdd={false}
          showHeader={false}
          statusFilter="inbox"
          taskSource={[]}
          title="Inbox"
        />,
      );
    });

    const bulkBarProps = tree.root.findAll((node) => String(node.type) === 'TaskListBulkBar')[0]?.props;
    expect(bulkBarProps.statusOptions).toEqual(['next', 'waiting', 'someday', 'done', 'reference']);

    act(() => {
      tree.unmount();
    });
  });

  it('assigns standalone quick-add tasks to the selected area filter in active area mode', async () => {
    selectedAreaIdForNewTasksMock.current = 'area-work';
    storeState.areas = [{
      id: 'area-work',
      name: 'Work',
      order: 0,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    }];
    storeState.settings = {
      ...storeState.settings,
      gtd: { defaultAreaMode: 'active', defaultAreaId: 'area-home' },
    };

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = renderInboxList();
    });

    await act(async () => {
      latestQuickAddProps().onChangeText('Capture work task');
    });

    await act(async () => {
      await latestQuickAddProps().handleAddTask();
    });

    expect(addTaskMock).toHaveBeenCalledWith('Capture work task', expect.objectContaining({
      areaId: 'area-work',
      status: 'inbox',
    }));

    act(() => {
      tree.unmount();
    });
  });

  it('plain add clears the composer and refocuses it for the next capture', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = renderProjectList();
    });

    await act(async () => {
      latestQuickAddProps().onChangeText('Draft launch checklist');
    });

    await act(async () => {
      await latestQuickAddProps().handleAddTask();
    });

    expect(addTaskMock).toHaveBeenCalledWith('Draft launch checklist', expect.objectContaining({
      projectId: project.id,
      status: 'inbox',
    }));
    expect(latestQuickAddProps().newTaskTitle).toBe('');
    expect(quickAddFocusMock).toHaveBeenCalledTimes(1);
    expect(taskEditModalPropsSpy.mock.calls.some(([props]) => props.visible === true)).toBe(false);

    act(() => {
      tree.unmount();
    });
  });

  it('passes isFocusedToday when the quick-add focus toggle is enabled', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = renderProjectList();
    });

    await act(async () => {
      latestQuickAddProps().onToggleFocusNewTask();
      latestQuickAddProps().onChangeText('Focus launch checklist');
    });

    await act(async () => {
      await latestQuickAddProps().handleAddTask();
    });

    expect(addTaskMock).toHaveBeenCalledWith('Focus launch checklist', expect.objectContaining({
      isFocusedToday: true,
      projectId: project.id,
      status: 'inbox',
    }));

    act(() => {
      tree.unmount();
    });
  });

  it('add-and-edit opens the created task without bypassing the shared add path', async () => {
    addTaskMock.mockImplementation(async (title: string, props: Partial<Task>) => {
      const created = makeTask('created-task', title, props);
      storeState.tasks = [created];
      storeState._allTasks = [created];
      return { success: true, id: created.id };
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = renderProjectList();
    });

    await act(async () => {
      latestQuickAddProps().onChangeText('Add launch brief');
    });

    await act(async () => {
      await latestQuickAddProps().handleAddAndEditTask();
    });

    expect(addTaskMock).toHaveBeenCalledWith('Add launch brief', expect.objectContaining({
      projectId: project.id,
      status: 'inbox',
    }));
    expect(setHighlightTaskMock).toHaveBeenCalledWith('created-task');
    expect(taskEditModalPropsSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      visible: true,
      task: expect.objectContaining({ id: 'created-task' }),
    }));
    expect(latestQuickAddProps().newTaskTitle).toBe('');

    act(() => {
      tree.unmount();
    });
  });

  it('applies typeahead suggestions using the latest quick-add text and selection', async () => {
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = renderProjectList();
    });

    await act(async () => {
      const quickAdd = latestQuickAddProps();
      quickAdd.onChangeText('+La today');
      quickAdd.onSelectionChange({ start: '+La'.length, end: '+La'.length });
      await quickAdd.applyTypeaheadOption({ kind: 'project', label: 'Launch', value: 'Launch' });
    });

    expect(latestQuickAddProps().newTaskTitle).toBe('+Launch today');

    act(() => {
      tree.unmount();
    });
  });

  it('passes shared row context to task rows instead of making each row subscribe to the store', async () => {
    const visibleTask = makeTask('task-row-context', 'Review launch notes');
    storeState.tasks = [visibleTask];
    storeState._allTasks = [visibleTask];

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(
        <TaskList
          allowAdd={false}
          showHeader={false}
          statusFilter="next"
          taskSource={[visibleTask]}
          title="Next"
        />,
      );
    });

    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    expect(row.props.rowContext).toEqual(expect.objectContaining({
      areas: storeState.areas,
      focusedCount: 0,
      projects: storeState.projects,
      restoreTask: storeState.restoreTask,
      updateTask: updateTaskMock,
    }));
    expect(row.props.rowContext).toEqual(expect.objectContaining({
      focusTaskLimit: 3,
      showTaskAge: false,
      timeEstimatesEnabled: true,
      undoNotificationsEnabled: true,
    }));

    act(() => {
      tree.unmount();
    });
  });

  it('uses compact draggable rows without extra placeholder or scale overlays for long project reorder lists', async () => {
    const longTaskList = Array.from({ length: 130 }, (_, index) => makeTask(
      `task-${index}`,
      `Task ${index}`,
      { order: index },
    ));
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          allowAdd={false}
          enableProjectReorder
          projectId={project.id}
          projectReorderMode
          showHeader={false}
          statusFilter="all"
          taskSource={longTaskList}
          title={project.title}
        />,
      );
    });

    const draggableList = tree.root.findByType('NestableDraggableFlatList' as unknown as React.ElementType);
    expect(draggableList.props.data).toHaveLength(longTaskList.length);
    expect(draggableList.props.renderPlaceholder).toBeUndefined();
    expect(draggableList.props.animationConfig).toEqual(expect.objectContaining({
      overshootClamping: true,
    }));

    let row!: ReturnType<typeof create>;
    await act(async () => {
      row = create(
        draggableList.props.renderItem({
          drag: vi.fn(),
          getIndex: () => 80,
          isActive: false,
          item: longTaskList[80],
        }),
      );
    });

    expect(row.root.findAllByType('SwipeableTaskItem' as unknown as React.ElementType)).toHaveLength(0);
    expect(row.root.findAllByType('ScaleDecorator' as unknown as React.ElementType)).toHaveLength(0);
    expect(row.root.findByProps({ testID: 'project-task-reorder-row-task-80' })).toBeTruthy();
    expect(row.root.findByProps({ testID: 'project-task-drag-handle-task-80' })).toBeTruthy();

    act(() => {
      row.unmount();
      tree.unmount();
    });
  });

  it('uses a single self-scrolling draggable list when a section-less project owns the scroll', async () => {
    const longTaskList = Array.from({ length: 130 }, (_, index) => makeTask(
      `task-${index}`,
      `Task ${index}`,
      { order: index },
    ));
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(
        <TaskList
          allowAdd={false}
          enableProjectReorder
          projectId={project.id}
          projectReorderMode
          projectReorderOwnsScroll
          showHeader={false}
          statusFilter="all"
          taskSource={longTaskList}
          title={project.title}
        />,
      );
    });

    // The self-scrolling list owns scroll, so the nested (non-virtualizing) variant must be gone.
    expect(tree.root.findAllByType('NestableDraggableFlatList' as unknown as React.ElementType)).toHaveLength(0);

    const draggableList = tree.root.findByType('DraggableFlatList' as unknown as React.ElementType);
    expect(draggableList.props.data).toHaveLength(longTaskList.length);
    expect(draggableList.props.scrollEnabled).not.toBe(false);
    expect(draggableList.props.animationConfig).toEqual(expect.objectContaining({
      overshootClamping: true,
    }));

    act(() => {
      tree.unmount();
    });
  });
});
