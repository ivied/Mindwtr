import React from 'react';
import { TouchableOpacity } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';

const mocks = vi.hoisted(() => {
  const batchUpdateTasks = vi.fn(async () => undefined);
  const batchMoveTasks = vi.fn(async () => undefined);
  const batchDeleteTasks = vi.fn(async () => undefined);
  const updateTask = vi.fn(async () => undefined);
  const deleteTask = vi.fn(async () => undefined);
  const modalPropsSpy = vi.fn();

  return {
    batchDeleteTasks,
    batchMoveTasks,
    batchUpdateTasks,
    deleteTask,
    modalPropsSpy,
    updateTask,
    storeState: {
      tasks: [] as Task[],
      projects: [] as Project[],
      areas: [] as Area[],
      settings: {
        appearance: {},
        taskSortBy: 'default',
      },
      batchDeleteTasks,
      batchMoveTasks,
      batchUpdateTasks,
      deleteTask,
      updateTask,
    },
  };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    shallow: Object.is,
    useTaskStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
  };
});

vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => undefined,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'bulk.addTag': 'Add tag',
      'bulk.delete': 'Delete',
      'bulk.moveTo': 'Move to',
      'bulk.organize': 'Organize',
      'bulk.selected': 'selected',
      'common.cancel': 'Cancel',
      'common.share': 'Share',
      'common.tasks': 'tasks',
      'dailyReview.title': 'Daily Review',
      'review.activeTasks': 'active tasks',
      'review.expandAreas': 'Expand areas',
      'review.expandEverything': 'Expand projects',
      'review.hasNextAction': 'Has next action',
      'review.needsAction': 'Needs action',
      'review.needsActionSummary': 'needs action',
      'review.noArea': 'No area',
      'review.noTasks': 'No tasks',
      'review.openGuide': 'Guided review',
      'review.projectsLabel': 'projects',
      'review.singleActions': 'Single actions',
      'review.startReview': 'Start Review',
      'review.unassigned': 'Unassigned',
      'review.withoutArea': 'without an area',
      'status.done': 'Done',
      'status.inbox': 'Inbox',
      'status.next': 'Next',
      'status.reference': 'Reference',
      'status.someday': 'Someday',
      'status.waiting': 'Waiting',
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
    inputBg: '#ffffff',
    onTint: '#ffffff',
    secondaryText: '#64748b',
    taskItemBg: '#ffffff',
    text: '#0f172a',
    tint: '#2563eb',
  }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({
    areaById: new Map(mocks.storeState.areas.map((area) => [area.id, area])),
    resolvedAreaFilter: '__all__',
    sortedAreas: mocks.storeState.areas,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('@/components/review-modal', () => ({
  ReviewModal: (props: any) => React.createElement('ReviewModal', props),
}));

vi.mock('@/components/swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('@/components/task-list/TaskListBulkOrganizeModal', () => ({
  TaskListBulkOrganizeModal: (props: any) => {
    mocks.modalPropsSpy(props);
    return React.createElement('TaskListBulkOrganizeModal', props);
  },
}));

vi.mock('lucide-react-native', () => ({
  ChevronDown: (props: any) => React.createElement('ChevronDown', props),
  ChevronRight: (props: any) => React.createElement('ChevronRight', props),
  ChevronsDown: (props: any) => React.createElement('ChevronsDown', props),
  ChevronsUp: (props: any) => React.createElement('ChevronsUp', props),
}));

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    BackHandler: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    },
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
    Share: {
      share: vi.fn().mockResolvedValue({ action: 'sharedAction' }),
    },
  };
});

import ReviewScreen from '../app/(drawer)/review';

const now = '2026-06-11T00:00:00.000Z';

const makeArea = (id: string, name: string): Area => ({
  id,
  name,
  color: '#2563eb',
  order: 0,
  createdAt: now,
  updatedAt: now,
});

const makeTask = (id: string, title: string, updates: Partial<Task> = {}): Task => ({
  id,
  title,
  status: 'next',
  contexts: [],
  tags: [],
  createdAt: now,
  updatedAt: now,
  ...updates,
});

const flattenText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
  if (React.isValidElement<{ children?: unknown }>(value)) return flattenText(value.props.children);
  return '';
};

const pressButtonWithText = (tree: ReactTestRenderer, text: string) => {
  const button = tree.root.findAllByType(TouchableOpacity).find((node) => (
    flattenText(node.props.children).includes(text)
  ));
  expect(button).toBeTruthy();
  act(() => {
    button?.props.onPress();
  });
};

const pressButtonWithLabel = (tree: ReactTestRenderer, label: string) => {
  const button = tree.root.findAllByType(TouchableOpacity).find((node) => (
    node.props.accessibilityLabel === label
  ));
  expect(button).toBeTruthy();
  act(() => {
    button?.props.onPress();
  });
};

describe('ReviewScreen bulk organize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.areas = [makeArea('area-work', 'Work')];
    mocks.storeState.projects = [];
    mocks.storeState.tasks = [makeTask('task-1', 'Loose next action')];
  });

  it('bulk-applies an area from the review selection organize modal', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<ReviewScreen />);
    });

    pressButtonWithLabel(tree, 'Expand areas');
    pressButtonWithLabel(tree, 'Expand projects');

    const row = tree.root.findByType('SwipeableTaskItem' as unknown as React.ElementType);
    act(() => {
      row.props.onLongPressAction();
    });

    pressButtonWithText(tree, 'Organize');
    const modalProps = mocks.modalPropsSpy.mock.calls.at(-1)?.[0];
    expect(modalProps.visible).toBe(true);
    expect(modalProps.areas.map((area: Area) => area.id)).toEqual(['area-work']);

    await act(async () => {
      await modalProps.onApply({ status: 'next', areaId: 'area-work' });
    });

    expect(mocks.batchUpdateTasks).toHaveBeenCalledWith([
      {
        id: 'task-1',
        updates: expect.objectContaining({
          areaId: 'area-work',
          projectId: undefined,
          status: 'next',
        }),
      },
    ]);
  });
});
