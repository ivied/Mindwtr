import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import type { Project, Task } from '@mindwtr/core';
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

const baseProject: Project = {
    id: 'project-1',
    title: 'Project Alpha',
    color: '#3b82f6',
    order: 0,
    status: 'active',
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

    it('shows a calm date-coherence indicator when a task starts after its due date', () => {
        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{
                        ...baseTask,
                        startTime: '2026-04-25',
                        dueDate: '2026-04-24',
                    }}
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

        expect(getByText('Starts after due date')).toBeInTheDocument();
    });

    it('shows the daily recurrence interval in task metadata', () => {
        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{
                        ...baseTask,
                        recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=3' },
                    }}
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
                    recurrenceRule="daily"
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => ({
                        'recurrence.daily': 'Daily',
                        'recurrence.repeatEvery': 'Repeat every',
                        'recurrence.dayUnit': 'day(s)',
                    }[key] ?? key)}
                />
            </LanguageProvider>
        );

        expect(getByText('Daily · Repeat every 3 day(s)')).toBeInTheDocument();
    });

    it('shows the projected recurrence date in task preview metadata', () => {
        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{
                        ...baseTask,
                        dueDate: '2026-06-09',
                        recurrence: {
                            rule: 'monthly',
                            strategy: 'strict',
                            byMonthDay: [9],
                            rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
                        },
                        showFutureRecurrence: true,
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
                    recurrenceRule="monthly"
                    recurrenceStrategy="strict"
                    prioritiesEnabled={false}
                    timeEstimatesEnabled={false}
                    isStagnant={false}
                    showQuickDone={false}
                    readOnly={false}
                    t={(key: string) => ({
                        'recurrence.monthly': 'Monthly',
                        'recurrence.nextCalendarPreview': 'Next calendar preview',
                    }[key] ?? key)}
                />
            </LanguageProvider>
        );

        expect(getByText('Monthly · Next calendar preview: Jul 9, 2026')).toBeInTheDocument();
    });

    it('wraps long task titles instead of truncating them', () => {
        const longTitle = 'This is a task for a project in a narrow split-screen workspace';

        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{ ...baseTask, title: longTitle }}
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

        expect(getByText(longTitle)).toHaveClass('task-item-display__title');
        expect(getByText(longTitle)).toHaveClass('break-words');
        expect(getByText(longTitle)).not.toHaveClass('truncate');
    });

    it('renders a one-line markdown description preview in collapsed rows', () => {
        const { getByText, queryByText, container } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{ ...baseTask, description: '- [ ] **Call** the vendor\nSecond line' }}
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

        const preview = container.querySelector('.task-item-display__description-preview');
        expect(preview).not.toBeNull();
        expect(preview).toHaveClass('truncate');
        expect(getByText('Call').tagName).toBe('STRONG');
        expect(queryByText(/\*\*Call\*\*/)).toBeNull();
        expect(queryByText(/\[ \]/)).toBeNull();
        expect(queryByText('Second line')).toBeNull();
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

    it('can suppress the expanded details project badge independently of action badges', () => {
        const { getByText, queryByText, rerender } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    project={baseProject}
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
                    showProjectBadgeInActions={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(getByText('Project Alpha')).toBeInTheDocument();

        rerender(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    project={baseProject}
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
                    showProjectBadgeInActions={false}
                    showProjectBadgeInMetadata={false}
                    readOnly={false}
                    t={(key: string) => key}
                />
            </LanguageProvider>
        );

        expect(queryByText('Project Alpha')).not.toBeInTheDocument();
    });

    it('renders inline markdown inside expanded checklist item titles', () => {
        const markdownChecklistTask: Task = {
            ...baseTask,
            status: 'next',
            checklist: [
                { id: 'item-1', title: '**Draft** [spec](https://example.com)', isCompleted: false },
            ],
        };

        const { container, queryByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={markdownChecklistTask}
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
                        onToggleChecklistItem: vi.fn(),
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

        expect(queryByRole('link', { name: 'spec' })).toBeNull();
        expect(container.textContent).toContain('Draft spec');
        expect(container.textContent).not.toContain('**');
        expect(container.textContent).not.toContain('](');
    });

    it('wraps expanded context and tag metadata groups', () => {
        const metadataHeavyTask: Task = {
            ...baseTask,
            contexts: ['@desk', '@phone', '@errands', '@deep-work'],
            tags: ['#home', '#finance', '#writing', '#admin'],
        };

        const { getByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={metadataHeavyTask}
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

        expect(getByText('@deep-work').closest('.metadata-badge')?.parentElement).toHaveClass('flex-wrap', 'min-w-0', 'max-w-full');
        expect(getByText('#admin').closest('.metadata-badge')?.parentElement).toHaveClass('flex-wrap', 'min-w-0', 'max-w-full');
    });

    it('opens context and tag metadata tokens from task badges', () => {
        const onOpenContextToken = vi.fn();
        const taggedTask: Task = {
            ...baseTask,
            contexts: ['@desk'],
            tags: ['#admin'],
        };

        const { getByRole } = render(
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
                        onOpenContextToken,
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

        fireEvent.click(getByRole('button', { name: 'Filter tasks: @desk' }));
        fireEvent.keyDown(getByRole('button', { name: 'Filter tasks: #admin' }), { key: 'Enter' });

        expect(onOpenContextToken).toHaveBeenNthCalledWith(1, '@desk');
        expect(onOpenContextToken).toHaveBeenNthCalledWith(2, '#admin');
    });

    it('keeps the hover hint out of the row text layout', () => {
        const { getByRole, queryByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
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

        expect(queryByText('Click to toggle details / Double-click to edit')).not.toBeInTheDocument();
        expect(getByRole('button', { name: 'task.toggleDetails' })).toHaveAttribute(
            'title',
            'Click to toggle details / Double-click to edit',
        );
    });

    it('shows a truncated description preview collapsed and the full description expanded', () => {
        const taskWithDescription: Task = {
            ...baseTask,
            description: 'Expanded task note\nSecond note line',
        };

        const { container, queryByText, rerender } = render(
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

        expect(queryByText(/Expanded task note/)).toBeInTheDocument();
        expect(container.querySelector('.task-item-display__description-preview')).toHaveClass('truncate');
        expect(queryByText(/Second note line/)).not.toBeInTheDocument();

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

        expect(queryByText(/Expanded task note/)).toBeInTheDocument();
        expect(queryByText(/Second note line/)).toBeInTheDocument();
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

    it('keeps quick actions above expanded task details', () => {
        const { getByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={{
                        ...baseTask,
                        description: 'Expanded task note',
                    }}
                    language="en"
                    selectionMode={false}
                    isViewOpen
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

        const actions = getByRole('button', { name: 'More options' }).closest('.task-item-display__actions');

        expect(actions).toHaveClass('z-20');
    });

    it('keeps secondary active task actions off the row', () => {
        const { getByRole, queryByRole } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={baseTask}
                    language="en"
                    selectionMode={false}
                    isViewOpen={false}
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

        expect(getByRole('button', { name: 'More options' })).toBeInTheDocument();
        const statusSelect = getByRole('combobox', { name: 'task.aria.status' });
        expect(statusSelect).toBeInTheDocument();
        expect(statusSelect).toHaveClass('text-blue-700', 'dark:text-primary');
        expect(queryByRole('button', { name: 'task.convertToReference' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: 'task.aria.delete' })).not.toBeInTheDocument();
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

    it('keeps preserved reference checklists hidden from row progress and toggles', () => {
        const referenceTask: Task = {
            ...baseTask,
            title: 'Reference checklist',
            status: 'reference',
            checklist: [{ id: 'item-1', title: 'Reference step', isCompleted: false }],
        };

        const { queryByText } = render(
            <LanguageProvider>
                <TaskItemDisplay
                    task={referenceTask}
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
                        onToggleChecklistItem: vi.fn(),
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

        expect(queryByText('0/1')).not.toBeInTheDocument();
        expect(queryByText('Reference step')).not.toBeInTheDocument();
    });
});
