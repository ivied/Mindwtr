import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewModal } from './review-modal';

const defaultTasks = [
    {
        id: 'inbox-1',
        title: 'Inbox task',
        status: 'inbox',
        contexts: [],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
    {
        id: 'waiting-1',
        title: 'Waiting task',
        status: 'waiting',
        contexts: [],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
    {
        id: 'project-task-1',
        title: 'Project task',
        status: 'next',
        projectId: 'project-1',
        contexts: ['@home'],
        tags: [],
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
];

const defaultProjects = [
    {
        id: 'project-1',
        title: 'Project One',
        status: 'active',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    },
];

const defaultSettings = {
    ai: { enabled: false },
    gtd: { weeklyReview: { includeContextStep: false } },
};

const storeState = {
    tasks: defaultTasks.map((task) => ({ ...task })),
    projects: defaultProjects.map((project) => ({ ...project })),
    areas: [],
    settings: { ...defaultSettings },
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    batchUpdateTasks: vi.fn(),
    addTask: vi.fn(),
};

vi.mock('react-native', async () => {
    const actual = await vi.importActual<any>('react-native');
    return {
        ...actual,
        FlatList: ({ data = [], renderItem, keyExtractor, ...props }: any) =>
            React.createElement(
                'FlatList',
                props,
                data.map((item: any, index: number) =>
                    React.createElement(
                        React.Fragment,
                        { key: keyExtractor?.(item, index) ?? item.id ?? index },
                        renderItem?.({ item, index }),
                    ),
                ),
            ),
    };
});

vi.mock('@mindwtr/core', () => ({
    useTaskStore: () => storeState,
    shallow: vi.fn((a, b) => a === b),
    getMindSweepGroups: vi.fn(() => [
        {
            id: 'test-group',
            scope: 'personal',
            titleKey: 'mindSweep.group.test.title',
            promptKeys: ['mindSweep.group.test.p1'],
        },
    ]),
    createAIProvider: vi.fn(),
    formatI18nTemplate: vi.fn((template: string, values: Record<string, string | number>) =>
        template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => String(values[key] ?? match))),
    getStaleItems: vi.fn(() => []),
    isDueForReview: vi.fn(() => false),
    isTaskInActiveProject: vi.fn(() => true),
    safeFormatDate: vi.fn(() => '2026-03-15'),
    safeParseDate: vi.fn((value?: string) => (value ? new Date(value) : null)),
    safeParseDueDate: vi.fn(() => null),
}));

vi.mock('../contexts/theme-context', () => ({
    useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({
        language: 'en',
        t: (key: string) => (key === 'common.close' ? 'Close' : key),
    }),
}));

vi.mock('../contexts/quick-capture-context', () => ({
    useQuickCapture: () => ({ openQuickCapture: vi.fn() }),
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

vi.mock('@/lib/task-meta-navigation', () => ({
    openContextsScreen: vi.fn(),
    openProjectScreen: vi.fn(),
}));

vi.mock('../lib/ai-config', () => ({
    buildAIConfig: vi.fn(() => ({})),
    isAIKeyRequired: vi.fn(() => false),
    loadAIKey: vi.fn().mockResolvedValue(''),
}));

vi.mock('../lib/app-log', () => ({
    logError: vi.fn(),
}));

vi.mock('../lib/external-calendar', () => ({
    fetchExternalCalendarEvents: vi.fn().mockResolvedValue({ events: [] }),
}));

vi.mock('../lib/store-review-prompt', () => ({
    maybeRequestStoreReviewAfterPositiveMoment: vi.fn().mockResolvedValue(false),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        setItem: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('lucide-react-native', () => {
    const icon = (name: string) => {
        const Icon = (props: any) => React.createElement(name, props);
        Icon.displayName = `${name}Icon`;
        return Icon;
    };
    return {
        Brain: icon('Brain'),
        X: icon('X'),
        History: icon('History'),
        Inbox: icon('Inbox'),
        Sparkles: icon('Sparkles'),
        Calendar: icon('Calendar'),
        Clock: icon('Clock'),
        Tag: icon('Tag'),
        FolderOpen: icon('FolderOpen'),
        Lightbulb: icon('Lightbulb'),
        Play: icon('Play'),
        CheckCircle2: icon('CheckCircle2'),
        PartyPopper: icon('PartyPopper'),
    };
});

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
    ErrorBoundary: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
}));

const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    return '';
};

describe('ReviewModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storeState.tasks = defaultTasks.map((task) => ({ ...task }));
        storeState.projects = defaultProjects.map((project) => ({ ...project }));
        storeState.settings = { ...defaultSettings };
    });

    it('advances and goes back through weekly review steps', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

        expect(hasText('Inbox')).toBe(true);
        expect(
            tree.root.findAll((node) => node.props?.accessibilityLabel === 'inbox.processButton').length,
        ).toBeGreaterThan(0);

        const nextLabel = tree.root.find((node) => flattenText(node.props?.children) === 'Next →');
        const nextButton = nextLabel.parent;
        if (!nextButton) {
            throw new Error('Next button not found');
        }

        await act(async () => {
            nextButton.props.onPress();
        });

        expect(hasText('Calendar')).toBe(true);

        const backLabel = tree.root.find((node) => flattenText(node.props?.children) === '← Back');
        const backButton = backLabel.parent;
        if (!backButton) {
            throw new Error('Back button not found');
        }

        await act(async () => {
            backButton.props.onPress();
        });

        expect(hasText('Inbox')).toBe(true);
    });

    it('does not let task chips navigate away mid-review', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const rows = tree.root.findAll((node) => String(node.type) === 'SwipeableTaskItem');
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(typeof row.props.onPress).toBe('function');
            expect(row.props.onContextPress).toBeUndefined();
            expect(row.props.onTagPress).toBeUndefined();
            expect(row.props.onProjectPress).toBeUndefined();
        }
    });

    it('opens mind sweep from the weekly review nudge', async () => {
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const nudge = tree.root.findByProps({ testID: 'review-mind-sweep-button' });

        await act(async () => {
            nudge.props.onPress();
        });

        expect(tree.root.findByProps({ testID: 'mind-sweep-start' })).toBeDefined();
    });

    it('starts on all clear when every weekly review stage is empty', async () => {
        storeState.tasks = [];
        storeState.projects = [];
        let tree!: ReturnType<typeof create>;

        await act(async () => {
            tree = create(<ReviewModal visible onClose={vi.fn()} />);
        });

        const hasText = (text: string) =>
            tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

        expect(hasText('Review Complete!')).toBe(true);
        expect(hasText('Inbox')).toBe(true);
        expect(hasText('Calendar')).toBe(true);
    });
});
