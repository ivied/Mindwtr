import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer from 'react-test-renderer';
import { Alert } from 'react-native';

import { SwipeableTaskItem } from './swipeable-task-item';

const { addTask, updateTask, restoreTask, showToast, getChecklistProgress, getTaskAgeLabel, getTaskStaleness, safeFormatDate, storeState } = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  restoreTask: vi.fn(),
  showToast: vi.fn(),
  getChecklistProgress: vi.fn((_value: any): any => null),
  getTaskAgeLabel: vi.fn(() => '3 weeks old'),
  getTaskStaleness: vi.fn(() => 'stale'),
  safeFormatDate: vi.fn((_value: unknown, formatStr: string) => (
    formatStr === 'Pp' ? 'May 12, 2026, 8:30 AM' : ''
  )),
  storeState: {
    addTask: vi.fn(),
    updateTask: vi.fn(),
    restoreTask: vi.fn(),
    projects: [] as any[],
    _allProjects: [] as any[],
    areas: [] as any[],
    settings: { features: {}, appearance: {} },
    getDerivedState: () => ({ focusedCount: 0 }),
    tasks: [] as any[],
    _allTasks: [] as any[],
    _tasksById: new Map<string, any>(),
  },
}));
const hapticsMocks = vi.hoisted(() => ({
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@mindwtr/core', () => {
  storeState.addTask = addTask;
  storeState.updateTask = updateTask;
  storeState.restoreTask = restoreTask;
  const useTaskStore = Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    {
      getState: () => storeState,
    }
  );

  return {
    useTaskStore,
    getProjectNextActionPromptData: (completedTask: any, tasks: any[], projects: any[]) => {
      if (!completedTask?.projectId || completedTask.status !== 'done') return null;
      const project = projects.find((candidate) => candidate.id === completedTask.projectId);
      if (!project || project.deletedAt || project.status !== 'active') return null;
      const hasNext = tasks.some((candidate) => (
        candidate.id !== completedTask.id
        && candidate.projectId === project.id
        && !candidate.deletedAt
        && candidate.status === 'next'
      ));
      if (hasNext) return null;
      return {
        project,
        candidates: tasks.filter((candidate) => (
          candidate.id !== completedTask.id
          && candidate.projectId === project.id
          && !candidate.deletedAt
          && candidate.status !== 'next'
          && candidate.status !== 'done'
          && candidate.status !== 'archived'
          && candidate.status !== 'reference'
        )),
      };
    },
    formatFocusTaskLimitText: (template: string, limit: number) => template.replace('{{count}}', String(limit)),
    shallow: (value: unknown) => value,
    getChecklistProgress,
    getTaskAgeLabel,
    getTaskStaleness,
    getStatusColor: () => ({ bg: '#111111', border: '#222222', text: '#333333' }),
    hasTimeComponent: () => false,
    normalizeFocusTaskLimit: (value?: number) => value ?? 3,
    safeFormatDate,
    safeParseDueDate: () => null,
    tFallback: (t: (key: string) => string, key: string, fallback: string) => {
      const value = t(key);
      return value && value !== key ? value : fallback;
    },
    resolveTaskTextDirection: () => 'ltr',
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      ({
        'common.cancel': 'Cancel',
        'common.delete': 'Delete',
        'common.done': 'Done',
        'common.edit': 'Edit',
        'common.notice': 'Notice',
        'common.skip': 'Skip',
        'common.undo': 'Undo',
        'list.taskDeleted': 'Task deleted',
        'list.done': 'Completed',
        'status.inbox': 'Inbox',
        'status.done': 'Done',
        'status.next': 'Next',
        'status.someday': 'Someday',
        'projects.nextActionPromptTitle': "What's the next action?",
        'projects.nextActionPromptDesc': 'Choose or add the next action for {{project}}.',
        'projects.nextActionPromptChooseExisting': 'Choose an existing task',
        'projects.nextActionPromptAddNew': 'Add a new next action',
        'projects.nextActionPromptPlaceholder': 'New next action...',
        'projects.nextActionPromptAddButton': 'Add next action',
        'task.aria.delete': 'Delete task',
        'task.deleteConfirmBody': 'Move this task to Trash?',
      }[key] ?? key),
  }),
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ renderLeftActions, renderRightActions, children }: any) =>
    React.createElement(
      'Swipeable',
      {},
      renderLeftActions ? renderLeftActions() : null,
      renderRightActions ? renderRightActions() : null,
      children
    ),
}));

vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
  },
  notificationAsync: hapticsMocks.notificationAsync,
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast,
    dismissToast: vi.fn(),
  }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowRight: (props: any) => React.createElement('ArrowRight', props),
  Check: (props: any) => React.createElement('Check', props),
  RotateCcw: (props: any) => React.createElement('RotateCcw', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

describe('SwipeableTaskItem', () => {
  const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    return '';
  };

  const hasText = (tree: renderer.ReactTestRenderer, text: string) =>
    tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

  beforeEach(() => {
    vi.clearAllMocks();
    storeState.projects = [];
    storeState._allProjects = [];
    storeState.areas = [];
    storeState.settings = { features: {}, appearance: {} };
    storeState.tasks = [];
    storeState._allTasks = [];
    storeState._tasksById = new Map();
    addTask.mockResolvedValue({ success: true, id: 'created-task' });
    updateTask.mockResolvedValue({ success: true });
    getTaskAgeLabel.mockReturnValue('3 weeks old');
    getTaskStaleness.mockReturnValue('stale');
    getChecklistProgress.mockReturnValue(null);
    safeFormatDate.mockImplementation((_value: unknown, formatStr: string) => (
      formatStr === 'Pp' ? 'May 12, 2026, 8:30 AM' : ''
    ));
  });

  it('confirms deletion before invoking onDelete', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert');
    const onDelete = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Pay rent',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
        />
      );
    });

    const deleteAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Delete task' && typeof node.props.onPress === 'function'
    );

    renderer.act(() => {
      deleteAction.props.onPress();
    });

    expect(alertSpy).toHaveBeenCalledWith(
      'Pay rent',
      'Move this task to Trash?',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Delete', style: 'destructive', onPress: expect.any(Function) }),
      ]),
      { cancelable: true }
    );
    expect(onDelete).not.toHaveBeenCalled();

    const alertButtons = alertSpy.mock.calls[0]?.[2] as { text?: string; onPress?: () => void }[];
    const destructiveAction = alertButtons.find((button) => button.text === 'Delete');
    expect(destructiveAction?.onPress).toBeTypeOf('function');

    await renderer.act(async () => {
      destructiveAction?.onPress?.();
      await Promise.resolve();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('warning');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Task deleted',
      actionLabel: 'Undo',
      onAction: expect.any(Function),
    }));
  });

  it('navigates from project, context, and tag meta labels', () => {
    const onProjectPress = vi.fn();
    const onContextPress = vi.fn();
    const onTagPress = vi.fn();
    storeState.projects = [
      { id: 'project-1', title: 'Mindwtr', areaId: undefined },
    ];

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'inbox',
            projectId: 'project-1',
            contexts: ['@work'],
            tags: ['#urgent'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          onProjectPress={onProjectPress}
          onContextPress={onContextPress}
          onTagPress={onTagPress}
        />
      );
    });

    const projectButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open project Mindwtr');
    const contextButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open context @work');
    const tagButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open tag #urgent');

    renderer.act(() => {
      projectButton.props.onPress({ stopPropagation: vi.fn() });
      contextButton.props.onPress({ stopPropagation: vi.fn() });
      tagButton.props.onPress({ stopPropagation: vi.fn() });
    });

    expect(onProjectPress).toHaveBeenCalledWith('project-1');
    expect(onContextPress).toHaveBeenCalledWith('@work');
    expect(onTagPress).toHaveBeenCalledWith('#urgent');
  });

  it('hides stale task age when the appearance setting is off by default', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Defer filing',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, '3 weeks old')).toBe(false);
  });

  it('shows stale task age when enabled in appearance settings', () => {
    storeState.settings = { features: {}, appearance: { showTaskAge: true } };

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Defer filing',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, '3 weeks old')).toBe(true);
  });

  it('shows the completion date and time for completed tasks', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'File receipts',
            status: 'done',
            completedAt: '2026-05-12T08:30:00.000Z',
            createdAt: '2026-05-01T08:30:00.000Z',
            updatedAt: '2026-05-12T08:30:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, 'Completed: May 12, 2026, 8:30 AM')).toBe(true);
  });

  it('announces swipe directions and triggers haptics for status actions', () => {
    const onStatusChange = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const taskButton = tree.root.find((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('Status: Inbox'));
    const nextAction = tree.root.find((node) => node.props.accessibilityLabel === 'Next action' && typeof node.props.onPress === 'function');

    expect(taskButton.props.accessibilityHint).toContain('Swipe right to next');
    expect(taskButton.props.accessibilityHint).toContain('swipe left to delete');

    renderer.act(() => {
      nextAction.props.onPress();
    });

    expect(onStatusChange).toHaveBeenCalledWith('next');
    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('success');
  });

  it('prompts for the project next action after completing the last next task', async () => {
    const project = { id: 'project-1', title: 'Launch plan', status: 'active' };
    const task = {
      id: 'task-1',
      title: 'Finish current step',
      status: 'next',
      projectId: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    const candidate = {
      id: 'task-2',
      title: 'Draft follow-up',
      status: 'someday',
      projectId: 'project-1',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } as any;
    storeState.projects = [project];
    storeState._allProjects = [project];
    storeState._allTasks = [task, candidate];
    storeState._tasksById = new Map([[task.id, task], [candidate.id, candidate]]);
    const onStatusChange = vi.fn((status: string) => {
      const updatedTask = { ...task, status };
      storeState._allTasks = [updatedTask, candidate];
      storeState._tasksById = new Map([[updatedTask.id, updatedTask], [candidate.id, candidate]]);
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            onTint: '#ffffff',
            inputBg: '#222222',
            filterBg: '#333333',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    expect(hasText(tree, "What's the next action?")).toBe(true);
    expect(hasText(tree, 'Draft follow-up')).toBe(true);

    const candidateAction = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      candidateAction.props.onPress();
      await Promise.resolve();
    });

    expect(updateTask).toHaveBeenCalledWith('task-2', { status: 'next' });
  });

  it('can add a new project next action from the completion prompt', async () => {
    const project = { id: 'project-1', title: 'Launch plan', status: 'active' };
    const task = {
      id: 'task-1',
      title: 'Finish current step',
      status: 'next',
      projectId: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.projects = [project];
    storeState._allProjects = [project];
    storeState._allTasks = [task];
    storeState._tasksById = new Map([[task.id, task]]);
    const onStatusChange = vi.fn((status: string) => {
      const updatedTask = { ...task, status };
      storeState._allTasks = [updatedTask];
      storeState._tasksById = new Map([[updatedTask.id, updatedTask]]);
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            onTint: '#ffffff',
            inputBg: '#222222',
            filterBg: '#333333',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    const input = tree.root.find((node) => node.props.accessibilityLabel === 'Add a new next action');
    renderer.act(() => {
      input.props.onChangeText('Call Alex');
    });

    const addButton = tree.root.find((node) => node.props.accessibilityLabel === 'Add next action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      addButton.props.onPress();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Call Alex', {
      status: 'next',
      projectId: 'project-1',
      sectionId: undefined,
    });
  });

  it('cancels pending checklist flushes when deleting a task', () => {
    vi.useFakeTimers();
    const alertSpy = vi.spyOn(Alert, 'alert');
    const onDelete = vi.fn();
    const task = {
      id: 'task-1',
      title: 'Pay rent',
      status: 'inbox',
      checklist: [{ id: 'item-1', title: 'Confirm amount', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.tasks = [task];
    getChecklistProgress.mockImplementation((value: any) => {
      const checklist = value?.checklist ?? [];
      if (!checklist.length) return null;
      const completed = checklist.filter((entry: any) => entry.isCompleted).length;
      return {
        completed,
        total: checklist.length,
        percent: completed / checklist.length,
      };
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
        />
      );
    });

    const checklistProgressButton = tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress');
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });

    const checklistItemButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Confirm amount' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      checklistItemButton.props.onPress();
    });

    expect(updateTask).not.toHaveBeenCalled();

    const deleteAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Delete task' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      deleteAction.props.onPress();
    });

    const alertButtons = alertSpy.mock.calls[0]?.[2] as { text?: string; onPress?: () => void }[];
    const destructiveAction = alertButtons.find((button) => button.text === 'Delete');
    renderer.act(() => {
      destructiveAction?.onPress?.();
      tree.unmount();
      vi.runAllTimers();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('hides checklist progress when requested by the list view', () => {
    const task = {
      id: 'task-1',
      title: 'Plan move',
      status: 'inbox',
      checklist: [{ id: 'item-1', title: 'Book van', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    getChecklistProgress.mockReturnValue({
      completed: 0,
      total: 1,
      percent: 0,
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          hideChecklistProgress
        />
      );
    });

    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress')).toThrow();
  });

  it('flushes checklist updates using the full task set, not only visible tasks', () => {
    vi.useFakeTimers();
    const task = {
      id: 'task-1',
      title: 'Pack samples',
      status: 'next',
      taskMode: 'list',
      checklist: [{ id: 'item-1', title: 'Seal box', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.tasks = [];
    storeState._allTasks = [task];
    getChecklistProgress.mockImplementation((value: any) => {
      const checklist = value?.checklist ?? [];
      if (!checklist.length) return null;
      const completed = checklist.filter((entry: any) => entry.isCompleted).length;
      return {
        completed,
        total: checklist.length,
        percent: completed / checklist.length,
      };
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const checklistProgressButton = tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress');
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });

    const checklistItemButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Seal box' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      checklistItemButton.props.onPress();
    });
    renderer.act(() => {
      tree.unmount();
    });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      checklist: [{ id: 'item-1', title: 'Seal box', isCompleted: true }],
      status: 'done',
    });
    vi.useRealTimers();
  });
});
