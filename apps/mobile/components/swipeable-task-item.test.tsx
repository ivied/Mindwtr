import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer from 'react-test-renderer';
import { Alert } from 'react-native';

import { SwipeableTaskItem } from './swipeable-task-item';

const { addTask, updateTask, restoreTask, showToast, getChecklistProgress, getTaskAgeLabel, getTaskStaleness, safeFormatDate, safeParseDate, storeState } = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  restoreTask: vi.fn(),
  showToast: vi.fn(),
  getChecklistProgress: vi.fn((_value: any): any => null),
  getTaskAgeLabel: vi.fn(() => '3 weeks old'),
  getTaskStaleness: vi.fn(() => 'stale'),
  safeFormatDate: vi.fn((_value: unknown, formatStr: string): string => (
    formatStr === 'Pp' ? 'May 12, 2026, 8:30 AM' : ''
  )),
  safeParseDate: vi.fn((value?: string | null) => (value ? new Date(value) : null)),
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
const translate = vi.hoisted(() => {
  const labels: Record<string, string> = {
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.done': 'Done',
    'common.edit': 'Edit',
    'common.notice': 'Notice',
    'common.skip': 'Skip',
    'common.undo': 'Undo',
    'agenda.addToFocus': 'Add to focus',
    'agenda.removeFromFocus': 'Remove from focus',
    'list.taskDeleted': 'Task deleted',
    'list.done': 'Completed',
    'status.inbox': 'Inbox',
    'status.done': 'Done',
    'status.next': 'Next',
    'status.waiting': 'Waiting',
    'status.someday': 'Someday',
    'status.reference': 'Reference',
    'taskStatus.changeStatus': 'Change Status',
    'projects.nextActionPromptTitle': "What's the next action?",
    'projects.nextActionPromptDesc': 'Choose or add the next action for {{project}}.',
    'projects.nextActionPromptChooseExisting': 'Choose an existing task',
    'projects.nextActionPromptAddNew': 'Add a new next action',
    'projects.nextActionPromptPlaceholder': 'New next action...',
    'projects.nextActionPromptAddButton': 'Add next action',
    'task.aria.delete': 'Delete task',
    'task.deleteConfirmBody': 'Move this task to Trash?',
    'taskEdit.recurrenceLabel': 'Recurrence',
    'taskEdit.startDateLabel': 'Start',
    'recurrence.daily': 'Daily',
    'recurrence.repeatEvery': 'Repeat every',
    'recurrence.dayUnit': 'day(s)',
  };
  return (key: string) => labels[key] ?? key;
});

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
    formatRecurrenceLabel: ({ recurrence, t }: any) => {
      const rule = typeof recurrence === 'string' ? recurrence : recurrence?.rule;
      if (!rule) return '';
      const intervalMatch = typeof recurrence === 'object'
        ? /INTERVAL=(\d+)/.exec(recurrence.rrule || '')
        : null;
      const interval = intervalMatch ? Number(intervalMatch[1]) : 1;
      return [
        t(`recurrence.${rule}`),
        rule === 'daily' && interval > 1
          ? `${t('recurrence.repeatEvery')} ${interval} ${t('recurrence.dayUnit')}`
          : undefined,
      ].filter(Boolean).join(' · ');
    },
    shallow: (value: unknown) => value,
    getChecklistProgress,
    getTaskAgeLabel,
    getTaskDateCoherenceIssues: (task: any) => (
      task?.startTime === '2026-04-25' && task?.dueDate === '2026-04-24'
        ? [{ code: 'start_after_due', field: 'startTime', relatedField: 'dueDate' }]
        : []
    ),
    getTaskStaleness,
    getTaskUrgency: (task: any) => task?.urgency ?? 'normal',
    getStatusColor: () => ({ bg: '#111111', border: '#222222', text: '#333333' }),
    hasTimeComponent: (value?: string | null) => Boolean(value && /[T\s]\d{2}:\d{2}/.test(value)),
    normalizeFocusTaskLimit: (value?: number) => value ?? 3,
    getInlineMarkdownPreview: (text: string) => {
      const line = text.replace(/\r\n/g, '\n').split('\n').find((candidate) => candidate.trim()) ?? '';
      return line.replace(/^\s{0,3}(?:(?:[-*+]\s+)?\[(?: |x|X)\]\s+|>\s?|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '').trim();
    },
    parseInlineMarkdown: (text: string) => {
      const tokens: Array<{ type: string; text: string; href?: string }> = [];
      const regex = /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
        if (match[7]) {
          tokens.push({ type: 'code', text: match[7] });
        } else if (match[2] || match[3]) {
          tokens.push({ type: 'bold', text: match[2] || match[3] });
        } else if (match[4]) {
          tokens.push({ type: 'strike', text: match[4] });
        } else if (match[5] || match[6]) {
          tokens.push({ type: 'italic', text: match[5] || match[6] });
        } else if (match[8] && match[9]) {
          tokens.push({ type: 'link', text: match[8], href: match[9] });
        }
        lastIndex = regex.lastIndex;
      }
      if (lastIndex < text.length) tokens.push({ type: 'text', text: text.slice(lastIndex) });
      return tokens;
    },
    parseMarkdownReferenceHref: () => null,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate: (value?: string | null) => (value ? new Date(value) : null),
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
    t: translate,
  }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: translate,
  }),
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ renderLeftActions, renderRightActions, children, ...props }: any) =>
    React.createElement(
      'Swipeable',
      props,
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

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openProjectScreen: vi.fn(),
  openTaskScreen: vi.fn(),
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast,
    dismissToast: vi.fn(),
  }),
}));

vi.mock('../hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({
    isMaterial: false,
    shape: { large: 16 },
    state: { rippleColor: undefined, stateLayerColor: () => 'transparent' },
  }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowRight: (props: any) => React.createElement('ArrowRight', props),
  Check: (props: any) => React.createElement('Check', props),
  CircleDot: (props: any) => React.createElement('CircleDot', props),
  Repeat: (props: any) => React.createElement('Repeat', props),
  RotateCcw: (props: any) => React.createElement('RotateCcw', props),
  Star: (props: any) => React.createElement('Star', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

describe('SwipeableTaskItem', () => {
  const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    if (value && typeof value === 'object') {
      const item = value as { children?: unknown; props?: { children?: unknown } };
      return flattenText(item.props?.children ?? item.children);
    }
    return '';
  };

  const hasText = (tree: renderer.ReactTestRenderer, text: string) =>
    tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
  };

  const getTextColor = (tree: renderer.ReactTestRenderer, text: string) => {
    const matches = tree.root.findAll((node) => (
      flattenText(node.props?.children) === text && node.props?.style
    ));
    const node = matches[matches.length - 1];
    return flattenStyle(node?.props.style).color;
  };

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
    safeParseDate.mockImplementation((value?: string | null) => (value ? new Date(value) : null));
  });

  it('keeps inbox row titles width-constrained without the focus toggle', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Do laundry',
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
          statusBadgeAsIcon
        />
      );
    });

    const title = tree.root.findAll((node) => (
      flattenText(node.props?.children) === 'Do laundry' && node.props?.style
    )).at(-1);

    expect(title).toBeTruthy();
    expect(flattenStyle(title?.props.style)).toEqual(expect.objectContaining({
      flex: 1,
      minWidth: 0,
    }));
  });

  it('requires a deliberate horizontal drag before opening swipe actions', () => {
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
          onDelete={vi.fn()}
        />
      );
    });

    const swipeable = tree.root.find((node) => (node.type as unknown) === 'Swipeable');
    expect(swipeable.props.friction).toBe(1.25);
    expect(swipeable.props.leftThreshold).toBe(72);
    expect(swipeable.props.rightThreshold).toBe(72);
    expect(swipeable.props.dragOffsetFromLeftEdge).toBe(28);
    expect(swipeable.props.dragOffsetFromRightEdge).toBe(28);
    expect(swipeable.props.overshootLeft).toBe(false);
    expect(swipeable.props.overshootRight).toBe(false);
  });

it('uses the shared rounded star treatment for focused tasks', () => {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <SwipeableTaskItem
        task={{
          id: 'task-1',
          title: 'File taxes',
          status: 'next',
          isFocusedToday: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as any}
        isDark={true}
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
        showFocusToggle
      />
    );
  });

  const focusButton = tree.root.find((node) => node.props.accessibilityLabel === 'Remove from focus');
  const focusButtonStyle = Array.isArray(focusButton.props.style)
    ? Object.assign({}, ...focusButton.props.style.filter(Boolean))
    : focusButton.props.style;
  expect(focusButtonStyle).not.toHaveProperty('backgroundColor');
  expect(hasText(tree, '★')).toBe(false);

  const star = tree.root.find((node) => (node.type as unknown) === 'Star');
  expect(star.props.color).toBe('#F59E0B');
  expect(star.props.fill).toBe('#F59E0B');
  expect(star.props.strokeWidth).toBe(2);
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

  it('exposes the long-press row action through accessibility actions', () => {
    const onLongPressAction = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
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
          onLongPressAction={onLongPressAction}
          onLongPressActionLabel="Defer until"
        />
      );
    });

    const row = tree.root.find((node) => (
      node.props.accessibilityLabel === 'Plan release. Status: Next'
      && Array.isArray(node.props.accessibilityActions)
    ));

    expect(row.props.accessibilityActions).toEqual(expect.arrayContaining([
      { name: 'longPressAction', label: 'Defer until' },
    ]));

    renderer.act(() => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'longPressAction' } });
    });

    expect(onLongPressAction).toHaveBeenCalledTimes(1);
  });

  it('shows recurring task metadata in the mobile row', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Water plants',
            status: 'next',
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=3' },
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

    expect(hasText(tree, 'Daily · Repeat every 3 day(s)')).toBe(true);
    expect(tree.root.findAll((node) => (node.type as unknown) === 'Repeat')).toHaveLength(1);
    expect(tree.root.findAll((node) => (
      node.props.accessibilityLabel === 'Water plants. Status: Next. Recurrence: Daily · Repeat every 3 day(s)'
      && Array.isArray(node.props.accessibilityActions)
    )).length).toBeGreaterThan(0);
  });

  it('uses long press to toggle selection when no custom long-press action is present', () => {
    const onToggleSelect = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
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
          onToggleSelect={onToggleSelect}
        />
      );
    });

    const row = tree.root.find((node) => (
      node.props.accessibilityLabel === 'Plan release. Status: Next'
      && typeof node.props.onLongPress === 'function'
    ));

    renderer.act(() => {
      row.props.onLongPress();
    });

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('shows a date-coherence indicator when a task starts after its due date', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
            dueDate: '2026-04-24',
            startTime: '2026-04-25',
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

    expect(hasText(tree, 'Starts after due date')).toBe(true);
  });

  it('shows scheduled date and time metadata for tasks with a start time', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Client call',
            status: 'next',
            startTime: '2026-05-12T08:30:00.000Z',
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

    expect(hasText(tree, 'Start: May 12, 2026, 8:30 AM')).toBe(true);

    const row = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'Client call. Status: Next. Start: May 12, 2026, 8:30 AM'
    ));
    expect(row).toBeTruthy();
    expect(safeFormatDate).toHaveBeenCalledWith(expect.any(Date), 'Pp');
  });

  it('colors due date metadata by urgency', () => {
    safeFormatDate.mockReturnValue('Due date');
    const renderDueTask = (urgency: string) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <SwipeableTaskItem
            task={{
              id: `task-${urgency}`,
              title: 'Plan release',
              status: 'next',
              dueDate: '2026-05-12',
              urgency,
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
              danger: '#b91c1c',
            } as any}
            onPress={vi.fn()}
            onStatusChange={vi.fn()}
            onDelete={vi.fn()}
          />
        );
      });
      return tree;
    };

    expect(getTextColor(renderDueTask('normal'), 'Due date')).toBe('#999999');
    expect(getTextColor(renderDueTask('upcoming'), 'Due date')).toBe('#f59e0b');
    expect(getTextColor(renderDueTask('urgent'), 'Due date')).toBe('#f59e0b');
    expect(getTextColor(renderDueTask('overdue'), 'Due date')).toBe('#b91c1c');
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

  it('can hide project meta when the task is already shown inside that project', () => {
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
            status: 'next',
            projectId: 'project-1',
            contexts: ['@work'],
            tags: [],
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
          hideProjectMeta
        />
      );
    });

    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'Open project Mindwtr')).toThrow();
    expect(hasText(tree, '@work')).toBe(true);
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

  it('shows task age when enabled in appearance settings', () => {
    storeState.settings = { features: {}, appearance: { showTaskAge: true } };
    getTaskAgeLabel.mockReturnValue('2 days old');
    getTaskStaleness.mockReturnValue('fresh');

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

    expect(hasText(tree, '2 days old')).toBe(true);
  });

  it('renders compact description markdown without raw block or inline markers', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Prepare notes',
            description: '# Review **draft** [spec](https://example.com)',
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
            cardBg: '#111111',
            filterBg: '#222222',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const renderedText = flattenText(tree.toJSON());
    expect(renderedText).toContain('Review draft spec');
    expect(renderedText).not.toContain('# Review');
    expect(renderedText).not.toContain('**draft**');
    expect(renderedText).not.toContain('](');
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

  it('offers reference in the mobile status menu', () => {
    const onStatusChange = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Keep notes',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            cardBg: '#111111',
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

    const statusBadge = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Change status. Current status: inbox'
    );
    renderer.act(() => {
      statusBadge.props.onPress({ stopPropagation: vi.fn() });
    });

    expect(hasText(tree, 'Reference')).toBe(true);

    const referenceAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Reference' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      referenceAction.props.onPress();
    });

    expect(onStatusChange).toHaveBeenCalledWith('reference');
  });

  it('renders the status control as an icon button on single-status lists and still opens the menu', () => {
    const onStatusChange = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Capture idea',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            cardBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
          statusBadgeAsIcon
        />
      );
    });

    // Icon variant renders the status dot, not the redundant "Inbox" label.
    expect(tree.root.findAll((node) => (node.type as unknown) === 'CircleDot')).toHaveLength(1);
    const statusControl = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Change status. Current status: inbox'
    );
    expect(flattenText(statusControl.props.children)).not.toContain('Inbox');

    // Tapping the icon still opens the quick-status menu.
    renderer.act(() => {
      statusControl.props.onPress({ stopPropagation: vi.fn() });
    });
    expect(hasText(tree, 'Change Status')).toBe(true);

    const nextAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Next' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      nextAction.props.onPress();
    });
    expect(onStatusChange).toHaveBeenCalledWith('next');
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

  it('does not open the next-action prompt when the completion update fails', async () => {
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
    const onStatusChange = vi.fn(async () => ({ success: false, error: 'Maximum focus limit reached' }));

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

    expect(hasText(tree, "What's the next action?")).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Maximum focus limit reached',
      tone: 'error',
    }));
  });

  it('keeps the next-action prompt open when promoting a candidate fails', async () => {
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
    updateTask.mockResolvedValueOnce({ success: false, error: 'Project is locked' });
    const onStatusChange = vi.fn((status: string) => {
      const updatedTask = { ...task, status };
      storeState._allTasks = [updatedTask, candidate];
      storeState._tasksById = new Map([[updatedTask.id, updatedTask], [candidate.id, candidate]]);
      return Promise.resolve({ success: true });
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

    const candidateAction = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      candidateAction.props.onPress();
      await Promise.resolve();
    });

    expect(hasText(tree, "What's the next action?")).toBe(true);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Project is locked',
      tone: 'error',
    }));
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

  it('keeps reference checklists non-actionable in task rows', () => {
    const task = {
      id: 'task-1',
      title: 'Reference checklist',
      status: 'reference',
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
        />
      );
    });

    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress')).toThrow();
    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'Book van')).toThrow();
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
