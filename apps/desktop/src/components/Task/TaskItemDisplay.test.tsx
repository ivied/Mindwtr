import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { safeFormatDate, useTaskStore } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { TaskItemDisplay } from './TaskItemDisplay';

const initialTaskState = useTaskStore.getState();

const baseTask: Task = {
    id: 'task-1',
    title: 'Localized age',
    status: 'inbox',
    tags: [],
    contexts: [],
    createdAt: new Date(Date.now() - (15 * 24 * 60 * 60 * 1000)).toISOString(),
    updatedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
};

describe('TaskItemDisplay', () => {
    beforeEach(() => {
        act(() => {
            useTaskStore.setState(initialTaskState, true);
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders task age in Chinese when language is zh', () => {
        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    language="zh"
                    selectionMode={false}
                    isViewOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    showTaskAge
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByText('2周前')).toBeInTheDocument();
    });

    it('hides task age by default', () => {
        const { queryByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    language="zh"
                    selectionMode={false}
                    isViewOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(queryByText('2周前')).not.toBeInTheDocument();
    });

    it('shows the completion date and time for completed tasks when compact details are off', () => {
        const completedTask: Task = {
            ...baseTask,
            title: 'Completed task',
            status: 'done',
            completedAt: '2026-05-12T08:30:00.000Z',
            updatedAt: '2026-05-12T08:30:00.000Z',
        };
        const completionLabel = safeFormatDate(completedTask.completedAt, 'Pp');

        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={completedTask}
                    language="en"
                    selectionMode={false}
                    isViewOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    compactMetaEnabled={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByText(`Completed: ${completionLabel}`)).toBeInTheDocument();
    });

    it('keeps board overlay tags in the metadata row instead of the absolute action controls', () => {
        const taggedTask: Task = {
            ...baseTask,
            tags: ['#board-tag'],
        };

        const { getByText, queryByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={taggedTask}
                    language="en"
                    selectionMode={false}
                    isViewOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    showStatusSelect={false}
                    readOnly={false}
                    actionsOverlay
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByText('#board-tag')).toBeInTheDocument();
        expect(queryByText('board-tag')).not.toBeInTheDocument();
    });

    it('keeps the condensed tag summary for non-overlay task rows', () => {
        const taggedTask: Task = {
            ...baseTask,
            tags: ['#list-tag'],
        };

        const { getByText, queryByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={taggedTask}
                    language="en"
                    selectionMode={false}
                    isViewOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    showStatusSelect={false}
                    readOnly={false}
                    compactMetaEnabled={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByText('list-tag')).toBeInTheDocument();
        expect(queryByText('#list-tag')).not.toBeInTheDocument();
    });

    it('only renders the task description when the row is expanded', () => {
        const taskWithDescription: Task = {
            ...baseTask,
            description: 'Expanded task note',
        };

        const { queryByText, rerender } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={taskWithDescription}
                    language="en"
                    selectionMode={false}
                    isViewOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(queryByText('Expanded task note')).not.toBeInTheDocument();

        rerender(
            <LanguageProvider>
                <TaskItemDisplay
                    task={taskWithDescription}
                    language="en"
                    selectionMode={false}
                    isViewOpen
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(queryByText('Expanded task note')).toBeInTheDocument();
    });

    it('renders internal markdown task links in expanded details', () => {
        act(() => {
            useTaskStore.setState((state) => ({
                ...state,
                tasks: [baseTask, {
                    ...baseTask,
                    id: 'task-2',
                    title: 'Referenced task',
                }],
                _allTasks: [baseTask, {
                    ...baseTask,
                    id: 'task-2',
                    title: 'Referenced task',
                }],
                projects: [],
                _allProjects: [],
            }));
        });

        const { getByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{
                        ...baseTask,
                        description: 'See [[task:task-2|Referenced task]]',
                    }}
                    language="en"
                    selectionMode={false}
                    isViewOpen
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByRole('button', { name: 'Referenced task' })).toBeInTheDocument();
    });

    it('exposes the quick actions trigger as a menu popup', () => {
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    language="en"
                    selectionMode={false}
                    isViewOpen={false}
                    quickActionsOpen={false}
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        onOpenQuickActions: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        const trigger = getByRole('button', { name: 'More options' });
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveClass('focus-visible:ring-2');
    });

    it('opens external URL notes from expanded task details', () => {
        const open = vi.fn(() => ({}));
        vi.stubGlobal('open', open);

        const { getByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{
                        ...baseTask,
                        description: 'https://example.com',
                    }}
                    language="en"
                    selectionMode={false}
                    isViewOpen
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment: vi.fn(),
                    }}
                    visibleAttachments={[]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        fireEvent.click(getByRole('link', { name: 'https://example.com' }));

        expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    });

    it('renders inline image attachment previews in expanded details', () => {
        const openAttachment = vi.fn();
        const imageAttachment = {
            id: 'attachment-1',
            kind: 'file' as const,
            title: 'Sunset',
            uri: 'file:///tmp/sunset.png',
            mimeType: 'image/png',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        };

        const { getByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    language="en"
                    selectionMode={false}
                    isViewOpen
                    actions={{
                        onToggleView: vi.fn(),
                        onEdit: vi.fn(),
                        onDelete: vi.fn(),
                        onDuplicate: vi.fn(),
                        onStatusChange: vi.fn(),
                        openAttachment,
                    }}
                    visibleAttachments={[imageAttachment]}
                    recurrenceRule=""
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByRole('img', { name: 'Sunset' })).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'attachments.open: Sunset' }));

        expect(openAttachment).toHaveBeenCalledWith(imageAttachment);
    });
});
