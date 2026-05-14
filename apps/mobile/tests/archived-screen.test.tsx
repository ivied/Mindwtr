import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArchivedScreen from '../app/(drawer)/archived';

const mocks = vi.hoisted(() => {
  const updateTask = vi.fn();
  const purgeTask = vi.fn();
  const setHighlightTask = vi.fn();
  return {
    updateTask,
    purgeTask,
    setHighlightTask,
    storeState: {
      _allTasks: [] as any[],
      projects: [] as any[],
      updateTask,
      purgeTask,
      highlightTaskId: null as string | null,
      setHighlightTask,
    },
  };
});

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

vi.mock('@mindwtr/core', () => ({
  useTaskStore: () => mocks.storeState,
  safeFormatDate: vi.fn(() => 'May 12, 2026, 8:30 AM'),
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => ({
      'archived.empty': 'No archived tasks',
      'archived.emptyHint': 'Archived tasks appear here',
      'common.tasks': 'tasks',
      'list.done': 'Completed',
    }[key] ?? key),
  }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000000',
    taskItemBg: '#111111',
    text: '#ffffff',
    secondaryText: '#999999',
    tint: '#3b82f6',
  }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({
    areaById: new Map(),
    resolvedAreaFilter: '__all__',
  }),
}));

vi.mock('@/lib/area-filter', () => ({
  taskMatchesAreaFilter: () => true,
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: vi.fn(),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children, ...props }: any) => (
    React.createElement('GestureHandlerRootView', props, children)
  ),
  Swipeable: ({ children, renderLeftActions, renderRightActions }: any) => (
    React.createElement(
      'Swipeable',
      {},
      renderLeftActions?.(),
      renderRightActions?.(),
      children,
    )
  ),
}));

vi.mock('lucide-react-native', () => ({
  Archive: (props: any) => React.createElement('Archive', props),
}));

describe('ArchivedScreen', () => {
  const taskEditModalType = 'TaskEditModal' as unknown as React.ElementType;
  const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    return '';
  };
  const hasText = (tree: renderer.ReactTestRenderer, text: string) =>
    tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.projects = [];
    mocks.storeState.highlightTaskId = null;
    mocks.storeState._allTasks = [
      {
        id: 'task-1',
        title: 'Archived task',
        description: 'Full archived details',
        status: 'archived',
        completedAt: '2026-05-12T08:30:00.000Z',
        createdAt: '2026-05-10T08:30:00.000Z',
        updatedAt: '2026-05-12T08:30:00.000Z',
      },
    ];
  });

  it('opens archived task details from the row and saves through the task editor', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<ArchivedScreen />);
    });

    let modal = tree.root.findByType(taskEditModalType);
    expect(modal.props.visible).toBe(false);
    expect(modal.props.defaultTab).toBe('view');
    expect(hasText(tree, 'Completed: May 12, 2026, 8:30 AM')).toBe(true);

    const row = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Open archived task details: Archived task',
    );

    renderer.act(() => {
      row.props.onPress();
    });

    modal = tree.root.findByType(taskEditModalType);
    expect(modal.props.visible).toBe(true);
    expect(modal.props.task).toMatchObject({
      id: 'task-1',
      title: 'Archived task',
      description: 'Full archived details',
    });

    renderer.act(() => {
      modal.props.onSave('task-1', { description: 'Updated archived details' });
    });

    expect(mocks.updateTask).toHaveBeenCalledWith('task-1', { description: 'Updated archived details' });
    modal = tree.root.findByType(taskEditModalType);
    expect(modal.props.visible).toBe(false);
  });
});
