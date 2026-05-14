import React from 'react';
import { Alert, SectionList, TextInput } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import FocusScreen from '../app/(drawer)/(tabs)/focus';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const makeProject = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Project ${id}`,
  status: 'active',
  color: '#3b82f6',
  order: 0,
  tagIds: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const storeState: {
  tasks: Task[];
  projects: unknown[];
  settings: { appearance: Record<string, unknown>; features: Record<string, unknown> };
  updateTask: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  highlightTaskId: string | null;
  setHighlightTask: ReturnType<typeof vi.fn>;
} = {
  tasks: [
    makeTask('focus-task', { isFocusedToday: true, dueDate: '2000-01-01' }),
    makeTask('next-task'),
  ],
  projects: [],
  settings: { appearance: {}, features: {} },
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  updateSettings: vi.fn(),
  highlightTaskId: null,
  setHighlightTask: vi.fn(),
};

beforeEach(() => {
  storeState.tasks = [
    makeTask('focus-task', { isFocusedToday: true, dueDate: '2000-01-01' }),
    makeTask('next-task'),
  ];
  storeState.projects = [];
  storeState.settings = { appearance: {}, features: {} };
  storeState.updateSettings.mockClear();
  storeState.highlightTaskId = null;
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  const useTaskStore = Object.assign(() => storeState, {
    getState: () => storeState,
  });

  return {
    ...actual,
    getUsedTaskTokens: (tasks: Task[], selector: (task: Task) => string[]) => {
      const tokens = new Set<string>();
      tasks.forEach((task) => {
        selector(task).forEach((token) => {
          if (token) tokens.add(token);
        });
      });
      return Array.from(tokens).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    },
    useTaskStore,
    safeParseDate: (value?: string) => (value ? new Date(value) : null),
    safeParseDueDate: (value?: string) => (value ? new Date(value) : null),
  };
});

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'common.all': 'All',
        'agenda.todaysFocus': "Today's Focus",
        'focus.schedule': 'Today',
        'focus.nextActions': 'Next Actions',
        'agenda.reviewDue': 'Review Due',
        'agenda.allClear': 'All clear',
        'agenda.noTasks': 'No tasks',
        'energyLevel.high': 'High energy',
        'filters.label': 'Filters',
        'savedFilters.save': 'Save',
      }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    taskItemBg: '#111827',
    inputBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    tint: '#3b82f6',
    onTint: '#ffffff',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  }),
}));

vi.mock('@/components/swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('@/components/pomodoro-panel', () => ({
  PomodoroPanel: (props: any) => React.createElement('PomodoroPanel', props),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ areaById: new Map(), resolvedAreaFilter: '__all__' }),
}));

vi.mock('@/lib/area-filter', () => ({
  projectMatchesAreaFilter: () => true,
  taskMatchesAreaFilter: () => true,
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

function textContent(node: any): string {
  return node.children
    .map((child: any) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function findButtonByText(tree: ReturnType<typeof create>, text: string, options: { last?: boolean } = {}) {
  const matches = tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button'
    && typeof node.props.onPress === 'function'
    && textContent(node).includes(text)
  );
  if (matches.length === 0) {
    throw new Error(`No button found with text: ${text}`);
  }
  return options.last ? matches[matches.length - 1] : matches[0];
}

function findButtonByLabel(tree: ReturnType<typeof create>, label: string, options: { last?: boolean } = {}) {
  const matches = tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button'
    && node.props.accessibilityLabel === label
    && typeof node.props.onPress === 'function'
  );
  if (matches.length === 0) {
    throw new Error(`No button found with label: ${label}`);
  }
  return options.last ? matches[matches.length - 1] : matches[0];
}

describe('FocusScreen', () => {
  it('renders starred tasks in a dedicated Today\'s Focus section', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next', 'another-next', 'plain-next']);

    expect(() =>
      tree.root.find((node) =>
        node.props.accessibilityLabel === "Today's Focus" && typeof node.props.onPress === 'function'
      )
    ).not.toThrow();
  });

  it('bounds SectionList rendering for larger Focus lists', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const list = tree.root.findByType(SectionList);
    expect(list.props.initialNumToRender).toBe(12);
    expect(list.props.maxToRenderPerBatch).toBe(12);
    expect(list.props.windowSize).toBe(5);
  });

  it('keeps Today\'s Focus visible when collapsing Next Actions', () => {
    storeState.tasks = [
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next']);
  });

  it('does not render a Today\'s Focus section when no task is starred', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(() =>
      tree.root.find((node) =>
        node.props.accessibilityLabel === "Today's Focus" && typeof node.props.onPress === 'function'
      )
    ).toThrow();
  });

  it('collapses the Next Actions section without showing the empty state', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(2);

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: false });
    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(1);
    expect(() => tree.root.findByProps({ children: 'All clear' })).toThrow();
  });

  it('renders review-due tasks in a dedicated Review Due section and allows collapsing it', () => {
    storeState.tasks = [
      makeTask('waiting-review', {
        status: 'waiting',
        title: 'Waiting review',
        reviewAt: '2000-01-01T00:00:00.000Z',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['waiting-review']);

    const reviewDueButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Review Due' && typeof node.props.onPress === 'function'
    );

    expect(reviewDueButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => {
      reviewDueButton.props.onPress();
    });

    expect(reviewDueButton.props.accessibilityState).toEqual({ expanded: false });
    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(0);
    expect(() => tree.root.findByProps({ children: 'All clear' })).toThrow();
  });

  it('does not let earlier non-Focus tasks hide the next task in a sequential project', () => {
    storeState.projects = [makeProject('project-1', { isSequential: true })];
    storeState.tasks = [
      makeTask('inbox-before', {
        status: 'inbox',
        projectId: 'project-1',
        order: 0,
        orderNum: 0,
      }),
      makeTask('available-next', {
        status: 'next',
        projectId: 'project-1',
        order: 1,
        orderNum: 1,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['available-next']);
  });

  it('does not show later sequential actions when the first action has a hidden future start', () => {
    storeState.projects = [makeProject('project-1', { isSequential: true })];
    storeState.settings = {
      appearance: { showFutureStarts: false },
      features: {},
    };
    storeState.tasks = [
      makeTask('future-first', {
        status: 'next',
        projectId: 'project-1',
        order: 0,
        orderNum: 0,
        startTime: '2099-05-03T09:00:00.000Z',
      }),
      makeTask('following-next', {
        status: 'next',
        projectId: 'project-1',
        order: 1,
        orderNum: 1,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual([]);
  });

  it('applies and clears saved Focus filters from the chip row', () => {
    storeState.settings = {
      appearance: {},
      features: {},
      savedFilters: [{
        id: 'filter-desk',
        name: 'Desk',
        view: 'focus',
        criteria: { contexts: ['@desk'] },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    } as any;
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
      makeTask('phone-task', { title: 'Phone task', contexts: ['@phone'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByText(tree, 'Desk').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['desk-task']);

    act(() => {
      findButtonByText(tree, 'All').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['desk-task', 'phone-task']);
  });

  it('deletes the active saved Focus filter from the chip row', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.settings = {
      appearance: {},
      features: {},
      savedFilters: [{
        id: 'filter-desk',
        name: 'Desk',
        view: 'focus',
        criteria: { contexts: ['@desk'] },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    } as any;
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByText(tree, 'Desk').props.onPress();
    });
    await act(async () => {
      findButtonByLabel(tree, 'Delete saved filter Desk').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [
        expect.objectContaining({
          id: 'filter-desk',
          deletedAt: expect.any(String),
        }),
      ],
    });

    alertSpy.mockRestore();
  });

  it('removes advanced synced criteria from the active saved Focus filter', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.settings = {
      appearance: {},
      features: {},
      savedFilters: [{
        id: 'filter-desk',
        name: 'Desk',
        view: 'focus',
        criteria: {
          contexts: ['@desk'],
          dueDateRange: { preset: 'this_week' },
          hasDescription: true,
        },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    } as any;
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByText(tree, 'Desk').props.onPress();
    });
    await act(async () => {
      findButtonByLabel(tree, 'Delete Due Date: This week').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        id: 'filter-desk',
        criteria: {
          contexts: ['@desk'],
          hasDescription: true,
        },
        updatedAt: expect.any(String),
      })],
    });

    alertSpy.mockRestore();
  });

  it('saves the current Focus filter from the existing filter sheet', async () => {
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.tasks = [
      makeTask('low-energy-task', { energyLevel: 'low' }),
      makeTask('high-energy-task', { energyLevel: 'high' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const filterButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Filters' && typeof node.props.onPress === 'function'
    );

    act(() => {
      filterButton.props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'High energy').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    const input = tree.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('High energy preset');
    });
    await act(async () => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        name: 'High energy preset',
        view: 'focus',
        criteria: { energy: ['high'] },
      })],
    });
  });

});
