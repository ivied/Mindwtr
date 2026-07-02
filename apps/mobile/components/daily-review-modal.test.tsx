import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DailyReviewScreen } from './daily-review-modal';
import { SwipeableTaskItem } from './swipeable-task-item';
import { fetchExternalCalendarEvents } from '../lib/external-calendar';

const defaultTasks = [
  {
    id: 'task-1',
    title: 'Focus me',
    status: 'next',
    contexts: [],
    tags: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  },
];

const storeState: any = {
  tasks: [...defaultTasks],
  projects: [],
  settings: {},
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
};

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    FlatList: ({ data = [], renderItem, keyExtractor, ListEmptyComponent, ...props }: any) => {
      const children = data.length > 0
        ? data.map((item: any, index: number) => (
          <React.Fragment key={keyExtractor?.(item, index) ?? item.id ?? index}>
            {renderItem?.({ item, index })}
          </React.Fragment>
        ))
        : typeof ListEmptyComponent === 'function'
          ? <ListEmptyComponent />
          : ListEmptyComponent;

      return React.createElement('FlatList', props, children);
    },
  };
});

vi.mock('@mindwtr/core', () => {
  const parseDate = (value?: string | Date | null) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  return {
    formatFocusTaskLimitText: (template: string, limit: number) => template.replace('{{count}}', String(limit)),
    shallow: Object.is,
    useTaskStore: () => storeState,
    isDueForReview: () => false,
    isTaskInActiveProject: () => true,
    normalizeFocusTaskLimit: (value?: number) => value ?? 3,
    safeFormatDate: () => '2026-03-15',
    safeParseDate: parseDate,
    safeParseDueDate: parseDate,
    shouldShowTaskForStart: (task: { startTime?: string | null }) => {
      const start = parseDate(task.startTime);
      if (!start) return true;
      return start <= new Date(2026, 2, 15, 23, 59, 59, 999);
    },
    sortTasksBy: (tasks: unknown[]) => tasks,
    tFallback: (t: (key: string) => string, key: string, fallback: string) => {
      const value = t(key);
      return value === key ? fallback : value;
    },
  };
});

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'dailyReview.title': 'Daily Review',
        'dailyReview.todayStep': 'Today',
        'dailyReview.todayDesc': 'Review today.',
        'dailyReview.focusStep': "Today's Focus",
        'dailyReview.focusDesc': 'Optional focus.',
        'dailyReview.focusSelected': 'focused',
        'dailyReview.followUpToday': 'Follow up today',
        'dailyReview.inboxStep': 'Inbox',
        'dailyReview.inboxDesc': 'Review inbox.',
        'dailyReview.waitingStep': 'Waiting',
        'dailyReview.waitingDesc': 'Review waiting.',
        'dailyReview.completeTitle': 'Done',
        'dailyReview.completeDesc': 'Done.',
        'review.step': 'Step',
        'review.of': 'of',
        'review.nextStepBtn': 'Next Step',
        'review.back': 'Back',
        'agenda.reviewDue': 'Review Due',
        'common.tasks': 'tasks',
        'calendar.events': 'Events',
        'calendar.noTasks': 'No tasks',
        'agenda.noTasks': 'No tasks',
        'agenda.focusHint': 'Pick focus tasks.',
      }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
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

vi.mock('./swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('./task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('./inbox-processing-modal', () => ({
  InboxProcessingModal: (props: any) => React.createElement('InboxProcessingModal', props),
}));

vi.mock('./ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('../lib/external-calendar', () => ({
  fetchExternalCalendarEvents: vi.fn().mockResolvedValue({ events: [] }),
}));

vi.mock('expo-router', () => ({
  router: {
    push: vi.fn(),
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
}));

const flattenText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
  return '';
};

const getAllText = (tree: ReturnType<typeof create>) => tree.root.findAll((node) => Boolean(node.props?.children))
  .map((node) => flattenText(node.props.children))
  .join('\n');

describe('DailyReviewScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchExternalCalendarEvents).mockReset();
    storeState.tasks = defaultTasks.map((task) => ({ ...task }));
    storeState.projects = [];
    storeState.settings = {};
    vi.mocked(fetchExternalCalendarEvents).mockResolvedValue({ calendars: [], events: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts on the focus step when earlier daily stages are empty', async () => {
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });

    expect(getAllText(tree)).toContain("Today's Focus");
    expect(getAllText(tree)).toContain('Today');

    const taskRows = tree.root.findAllByType(SwipeableTaskItem);
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].props.showFocusToggle).toBe(true);
    expect(taskRows[0].props.hideStatusBadge).toBe(true);
  });

  it('does not let task chips navigate away mid-review', async () => {
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });

    const rows = tree.root.findAllByType(SwipeableTaskItem);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((row) => {
      expect(typeof row.props.onPress).toBe('function');
      expect(row.props.onContextPress).toBeUndefined();
      expect(row.props.onTagPress).toBeUndefined();
      expect(row.props.onProjectPress).toBeUndefined();
    });
  });

  it('skips the focus step when daily review focus is disabled', async () => {
    storeState.tasks = [
      {
        id: 'waiting-task',
        title: 'Waiting for invoice',
        status: 'waiting',
        contexts: [],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    storeState.settings = {
      gtd: {
        dailyReview: {
          includeFocusStep: false,
        },
      },
    };
    let tree!: ReturnType<typeof create>;

    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });

    const allText = getAllText(tree);
    expect(allText).toContain('Waiting');
    expect(allText).not.toContain("Today's Focus");
  });

  it('sets a waiting item to follow up today without changing its status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 30, 0));
    storeState.tasks = [
      {
        id: 'waiting-task',
        title: 'Waiting for invoice',
        status: 'waiting',
        contexts: [],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });

    const followUpButton = tree.root.find((node) =>
      node.props?.accessibilityLabel === 'Follow up today: Waiting for invoice'
    );
    await act(async () => {
      followUpButton.props.onPress();
    });

    expect(storeState.updateTask).toHaveBeenCalledWith('waiting-task', {
      reviewAt: new Date(2026, 2, 15, 0, 0, 0, 0).toISOString(),
    });
  });

  it('collapses calendar events without hiding today tasks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0));
    storeState.tasks = [
      {
        id: 'task-due-today',
        title: 'Submit receipts',
        status: 'next',
        contexts: [],
        tags: [],
        dueDate: new Date(2026, 2, 15, 12, 0, 0).toISOString(),
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ];
    vi.mocked(fetchExternalCalendarEvents).mockResolvedValueOnce({
      events: [
        {
          id: 'event-1',
          sourceId: 'local',
          title: 'Long calendar block',
          start: new Date(2026, 2, 15, 9, 0, 0).toISOString(),
          end: new Date(2026, 2, 15, 9, 30, 0).toISOString(),
          allDay: false,
        },
      ],
      calendars: [],
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<DailyReviewScreen onClose={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getAllText(tree)).toContain('Long calendar block');

    const calendarToggle = tree.root.find((node) =>
      node.props?.accessibilityLabel === 'Events' &&
      node.props?.accessibilityState?.expanded === true
    );
    await act(async () => {
      calendarToggle.props.onPress();
    });

    expect(getAllText(tree)).not.toContain('Long calendar block');
    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(1);
  });
});
