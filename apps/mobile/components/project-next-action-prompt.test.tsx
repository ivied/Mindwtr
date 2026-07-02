import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { Text } from 'react-native';

import {
    buildProjectNextActionPromptState,
    presentProjectNextActionPrompt,
    ProjectNextActionPromptProvider,
} from './project-next-action-prompt';

const { addTask, updateTask, showToast, storeState } = vi.hoisted(() => ({
    addTask: vi.fn(),
    updateTask: vi.fn(),
    showToast: vi.fn(),
    storeState: {
        addTask: vi.fn(),
        updateTask: vi.fn(),
        projects: [] as any[],
        _allProjects: [] as any[],
        tasks: [] as any[],
        _allTasks: [] as any[],
        _tasksById: new Map<string, any>(),
    },
}));

const translate = vi.hoisted(() => {
    const labels: Record<string, string> = {
        'common.skip': 'Skip',
        'projects.nextActionPromptTitle': "What's the next action?",
        'projects.nextActionPromptDesc': 'Choose or add the next action for {{project}}.',
        'projects.nextActionPromptChooseExisting': 'Choose an existing task',
        'projects.nextActionPromptAddNew': 'Add a new next action',
        'projects.nextActionPromptPlaceholder': 'New next action...',
        'projects.nextActionPromptAddButton': 'Add next action',
        'status.waiting': 'Waiting',
    };
    return (key: string) => labels[key] ?? key;
});

vi.mock('@mindwtr/core', () => {
    storeState.addTask = addTask;
    storeState.updateTask = updateTask;
    const useTaskStore = Object.assign(
        (selector?: (state: typeof storeState) => unknown) =>
            selector ? selector(storeState) : storeState,
        {
            getState: () => storeState,
        },
    );

    return {
        useTaskStore,
        shallow: (value: unknown) => value,
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
        tFallback: (t: (key: string) => string, key: string, fallback: string) => {
            const value = t(key);
            return value && value !== key ? value : fallback;
        },
    };
});

vi.mock('../contexts/language-context', () => ({
    useLanguage: () => ({ t: translate }),
}));

vi.mock('../hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        cardBg: '#ffffff',
        text: '#111111',
        secondaryText: '#666666',
        border: '#dddddd',
        inputBg: '#f3f4f6',
        filterBg: '#e5e7eb',
        tint: '#2563eb',
        onTint: '#ffffff',
    }),
}));

vi.mock('../contexts/toast-context', () => ({
    useToast: () => ({
        showToast,
    }),
}));

describe('ProjectNextActionPromptProvider', () => {
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

    const currentTask = {
        id: 'current',
        title: 'Finish current step',
        status: 'next',
        projectId: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const candidateTask = {
        id: 'candidate',
        title: 'Draft follow-up',
        status: 'waiting',
        projectId: 'project-1',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
    };

    const project = {
        id: 'project-1',
        title: 'Launch plan',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        storeState.projects = [project];
        storeState._allProjects = [project];
        storeState.tasks = [currentTask, candidateTask];
        storeState._allTasks = [currentTask, candidateTask];
        storeState._tasksById = new Map([
            [currentTask.id, currentTask],
            [candidateTask.id, candidateTask],
        ]);
        addTask.mockResolvedValue({ success: true, id: 'created-task' });
        updateTask.mockResolvedValue({ success: true });
    });

    it('builds prompt data from an optimistic completed task snapshot', () => {
        const promptState = buildProjectNextActionPromptState({
            ...currentTask,
            status: 'done',
        } as any);

        expect(promptState?.projectId).toBe('project-1');
        expect(promptState?.candidates.map((task) => task.id)).toEqual(['candidate']);
    });

    it('keeps the prompt mounted after the triggering row unmounts', async () => {
        function Trigger({ visible }: { visible: boolean }) {
            if (!visible) return null;
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger visible />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        expect(hasText(tree, "What's the next action?")).toBe(true);
        expect(hasText(tree, 'Draft follow-up')).toBe(true);

        await renderer.act(async () => {
            tree.update(
                <ProjectNextActionPromptProvider>
                    <Trigger visible={false} />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        expect(hasText(tree, 'Draft follow-up')).toBe(true);

        const candidate = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up');
        await renderer.act(async () => {
            candidate.props.onPress();
            await Promise.resolve();
        });

        expect(updateTask).toHaveBeenCalledWith('candidate', { status: 'next' });
    });

    it('keeps the prompt open and reports failed next-action updates', async () => {
        updateTask.mockResolvedValueOnce({ success: false, error: 'Project is locked' });

        function Trigger() {
            return (
                <Text
                    accessibilityLabel="Open next action prompt"
                    onPress={() => presentProjectNextActionPrompt({ ...currentTask, status: 'done' } as any)}
                >
                    Open
                </Text>
            );
        }

        let tree!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            tree = renderer.create(
                <ProjectNextActionPromptProvider>
                    <Trigger />
                </ProjectNextActionPromptProvider>,
            );
            await Promise.resolve();
        });

        const trigger = tree.root.find((node) => node.props.accessibilityLabel === 'Open next action prompt');
        await renderer.act(async () => {
            trigger.props.onPress();
            await Promise.resolve();
        });

        const candidate = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up');
        await renderer.act(async () => {
            candidate.props.onPress();
            await Promise.resolve();
        });

        expect(hasText(tree, "What's the next action?")).toBe(true);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            message: 'Project is locked',
            tone: 'error',
        }));
    });
});
