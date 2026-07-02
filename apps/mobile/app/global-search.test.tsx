import React from 'react';
import { FlatList, Text, TouchableOpacity } from 'react-native';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

const routerPushMock = vi.hoisted(() => vi.fn());
const setHighlightTaskMock = vi.hoisted(() => vi.fn());
const taskEditModalPropsSpy = vi.hoisted(() => vi.fn());
const updateTaskMock = vi.hoisted(() => vi.fn());
const routeParams = vi.hoisted(() => ({ q: 'Launch' as string | undefined }));
const storageAdapterState = vi.hoisted(() => ({
    searchAll: undefined as undefined | ((query: string) => Promise<any>),
}));
const storeState = vi.hoisted(() => ({
    _allTasks: [] as Task[],
    projects: [],
    areas: [],
    settings: {
        savedSearches: [],
    },
    updateSettings: vi.fn(),
    updateTask: updateTaskMock,
    setHighlightTask: setHighlightTaskMock,
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return {
        ...actual,
        getStorageAdapter: () => (storageAdapterState.searchAll ? { searchAll: storageAdapterState.searchAll } : {}),
        shallow: Object.is,
        useTaskStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
    };
});

vi.mock('expo-router', () => ({
    useLocalSearchParams: () => routeParams,
    useRouter: () => ({ push: routerPushMock }),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => children,
}));

vi.mock('@/components/task-edit-modal', () => ({
    TaskEditModal: (props: any) => {
        taskEditModalPropsSpy(props);
        return React.createElement('TaskEditModal', {
            taskId: props.task?.id,
            visible: props.visible,
        });
    },
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

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({
        t: (key: string) => ({
            'common.cancel': 'Cancel',
            'common.clear': 'Clear',
            'common.close': 'Close',
            'common.save': 'Save',
            'common.search': 'Search',
            'filters.label': 'Filters',
            'search.helpOperators': 'Use operators',
            'search.inProjectSuffix': 'in project',
            'search.noResults': 'No results',
            'search.placeholder': 'Search',
            'search.resultTask': 'Task',
            'search.saveSearch': 'Save search',
            'search.searching': 'Searching',
        }[key] ?? key),
    }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
    openContextsScreen: vi.fn(),
    openProjectScreen: vi.fn(),
}));

const nowIso = '2026-06-01T12:00:00.000Z';

const makeTask = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
});

import SearchScreen from './global-search';

describe('SearchScreen task results', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        routeParams.q = 'Launch';
        storageAdapterState.searchAll = undefined;
        const tasks = [
            makeTask('task-1', 'Launch checklist'),
            makeTask('task-2', 'Home errands'),
        ];
        storeState._allTasks = tasks;
        storeState.projects = [];
        storeState.areas = [];
        storeState.settings = { savedSearches: [] };
        storeState.updateSettings = vi.fn();
        storeState.updateTask = updateTaskMock;
        storeState.setHighlightTask = setHighlightTaskMock;
    });

    it('opens the task editor when pressing a task search result', () => {
        let tree!: ReturnType<typeof create>;

        act(() => {
            tree = create(<SearchScreen />);
        });

        const resultList = tree.root.findByType(FlatList);
        expect(resultList.props.data.map((result: any) => result.item.id)).toEqual(['task-1']);

        const resultRow = resultList.props.renderItem({
            item: resultList.props.data[0],
            index: 0,
        });

        act(() => {
            resultRow.props.onPress();
        });

        expect(setHighlightTaskMock).toHaveBeenCalledWith('task-1');
        expect(routerPushMock).not.toHaveBeenCalled();
        expect(taskEditModalPropsSpy.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
            visible: true,
            task: expect.objectContaining({ id: 'task-1' }),
        }));
    });

    it('shows matching tasks when only a tag filter is selected', () => {
        routeParams.q = '';
        storeState._allTasks = [
            makeTask('task-1', 'Client launch', { tags: ['#client'] }),
            makeTask('task-2', 'Home errands', { tags: ['#home'] }),
        ];

        let tree!: ReturnType<typeof create>;
        act(() => {
            tree = create(<SearchScreen />);
        });

        const filterButton = tree.root
            .findAllByType(TouchableOpacity)
            .find((node) => node.props.accessibilityLabel === 'Filters');
        expect(filterButton).toBeDefined();

        act(() => {
            filterButton!.props.onPress();
        });

        const tagChip = tree.root.findAllByType(TouchableOpacity).find((node) => (
            node.findAllByType(Text).some((textNode) => textNode.props.children === '#client')
        ));
        expect(tagChip).toBeDefined();

        act(() => {
            tagChip!.props.onPress();
        });

        const resultList = tree.root.findByType(FlatList);
        expect(resultList.props.data.map((result: any) => result.item.id)).toEqual(['task-1']);
    });

    it('keeps literal CJK substring matches when SQLite search returns partial token matches', async () => {
        vi.useFakeTimers();
        try {
            routeParams.q = '搬家';
            const tasks = [
                makeTask('task-1', '準備搬家了'),
                makeTask('task-2', '列出需要處理的搬家物品'),
                makeTask('task-3', '搬家到新住處'),
            ];
            storeState._allTasks = tasks;
            storageAdapterState.searchAll = vi.fn(async () => ({
                tasks: [tasks[2]],
                projects: [],
            }));

            let tree!: ReturnType<typeof create>;
            await act(async () => {
                tree = create(<SearchScreen />);
            });

            await act(async () => {
                vi.advanceTimersByTime(250);
                await Promise.resolve();
            });

            const resultList = tree.root.findByType(FlatList);
            expect(resultList.props.data.map((result: any) => result.item.id)).toEqual([
                'task-3',
                'task-1',
                'task-2',
            ]);
            expect(storageAdapterState.searchAll).toHaveBeenCalledWith('搬家');
        } finally {
            vi.useRealTimers();
        }
    });
});
