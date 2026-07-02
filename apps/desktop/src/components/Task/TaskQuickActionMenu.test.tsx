import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState, type ComponentProps } from 'react';
import type { Task } from '@mindwtr/core';

import { TaskQuickActionMenu } from './TaskQuickActionMenu';

const now = '2026-02-01T00:00:00.000Z';

const task: Task = {
    id: 'task-1',
    title: 'Task',
    status: 'next',
    contexts: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
};

const t = (key: string) => ({
    'areas.create': 'Create area',
    'areas.search': 'Search areas',
    'common.cancel': 'Cancel',
    'common.clear': 'Clear',
    'common.delete': 'Delete',
    'common.noMatches': 'No matches',
    'common.save': 'Save',
    'projects.duplicate': 'Duplicate',
    'review.markReviewed': 'Mark reviewed',
    'task.convertToReference': 'Convert to Reference',
    'task.createProjectFromTask': 'Create project from task',
    'task.aria.dueTime': 'Due time',
    'task.aria.reviewTime': 'Review time',
    'task.aria.startTime': 'Start time',
    'taskEdit.areaLabel': 'Area',
    'taskEdit.contextsLabel': 'Contexts',
    'taskEdit.dueDateLabel': 'Due Date',
    'taskEdit.moreOptions': 'More options',
    'taskEdit.noAreaOption': 'No Area',
    'taskEdit.reviewDateLabel': 'Review Date',
    'taskEdit.startDateLabel': 'Start Date',
}[key] ?? key);

const createMenuProps = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}): ComponentProps<typeof TaskQuickActionMenu> => ({
    task,
    x: 16,
    y: 16,
    t,
    dateFormatSetting: 'system',
    nativeDateInputLocale: 'en-US',
    contextOptions: [],
    areas: [],
    readOnly: false,
    onClose: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onStatusChange: vi.fn(),
    onCreateArea: vi.fn(async () => null),
    onUpdateTask: vi.fn(async () => ({ success: true })),
    ...overrides,
});

const renderMenu = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}) => {
    const props = createMenuProps(overrides);
    render(<TaskQuickActionMenu {...props} />);
    return props;
};

const renderClosableMenu = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}) => {
    const props = createMenuProps(overrides);
    function Harness() {
        const [open, setOpen] = useState(true);
        return open ? (
            <TaskQuickActionMenu
                {...props}
                onClose={() => {
                    props.onClose();
                    setOpen(false);
                }}
            />
        ) : null;
    }
    render(<Harness />);
    return props;
};

describe('TaskQuickActionMenu', () => {
    it('opens one panel at a time and exposes dialog state without pressed state', () => {
        renderMenu();

        expect(screen.getByRole('menu', { name: /more options/i })).toBeInTheDocument();
        const startButton = screen.getByRole('menuitem', { name: /start date/i });
        expect(startButton).toHaveAttribute('aria-haspopup', 'dialog');
        expect(startButton).toHaveAttribute('aria-expanded', 'false');
        expect(startButton).not.toHaveAttribute('aria-pressed');
        expect(startButton).toHaveClass('focus-visible:ring-2');

        fireEvent.click(startButton);

        expect(startButton).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: /start date/i }))
            .toHaveClass('w-[min(30rem,calc(100vw-1rem))]');

        const dueButton = screen.getByRole('menuitem', { name: 'Due Date…' });
        fireEvent.click(dueButton);

        expect(dueButton).toHaveAttribute('aria-haspopup', 'dialog');
        expect(startButton).toHaveAttribute('aria-expanded', 'false');
        expect(dueButton).toHaveAttribute('aria-expanded', 'true');
        expect(dueButton).not.toHaveAttribute('aria-pressed');
        expect(dueButton).toHaveClass('focus-visible:ring-2');
        expect(screen.getByRole('dialog', { name: /due date/i })).toBeInTheDocument();

        const reviewButton = screen.getByRole('menuitem', { name: /review date/i });
        fireEvent.click(reviewButton);

        expect(dueButton).toHaveAttribute('aria-expanded', 'false');
        expect(reviewButton).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('dialog', { name: /review date/i })).toBeInTheDocument();
    });

    it('uses Escape to close the active panel before closing the menu', () => {
        const props = renderMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: /due date/i })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when clicking outside an open date panel', () => {
        const props = renderMenu();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        fireEvent.mouseDown(document.body);

        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('ignores the initial layout scroll after opening but closes on later scrolls', () => {
        vi.useFakeTimers();
        try {
            const props = renderMenu();

            fireEvent.scroll(window);
            expect(props.onClose).not.toHaveBeenCalled();

            vi.advanceTimersByTime(160);
            fireEvent.scroll(window);

            expect(props.onClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('closes the due date mini calendar when clicking elsewhere in the quick panel', () => {
        const props = renderMenu({ task: { ...task, dueDate: '2026-04-12' } });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));

        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        fireEvent.focus(within(panel).getByLabelText('Due Date'));
        fireEvent.click(within(panel).getByRole('button', { name: 'Due Date calendar' }));
        expect(screen.getByRole('dialog', { name: 'Due Date calendar' })).toBeInTheDocument();

        fireEvent.pointerDown(within(panel).getByRole('button', { name: 'Cancel' }));

        expect(screen.queryByRole('dialog', { name: 'Due Date calendar' })).not.toBeInTheDocument();
        expect(props.onClose).not.toHaveBeenCalled();
    });

    it('saves a start date from the quick action panel', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({ onUpdateTask });

        fireEvent.click(screen.getByRole('menuitem', { name: /start date/i }));

        const dialog = screen.getByRole('dialog', { name: /start date/i });
        fireEvent.change(within(dialog).getByLabelText('Start Date'), {
            target: { value: '2026-02-04' },
        });
        fireEvent.change(within(dialog).getByLabelText('Start time'), {
            target: { value: '09:30' },
        });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ startTime: '2026-02-04T09:30' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('applies a due date from the mini calendar and closes the menu', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, dueDate: '2026-04-12' },
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));
        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        fireEvent.focus(within(panel).getByLabelText('Due Date'));
        fireEvent.click(within(panel).getByRole('button', { name: 'Due Date calendar' }));

        fireEvent.pointerDown(screen.getByRole('button', { name: /April 19, 2026/i }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ dueDate: '2026-04-19' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('uses the configured date format when saving quick action date text', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, dueDate: '2026-04-12' },
            dateFormatSetting: 'dmy',
            nativeDateInputLocale: 'en-GB-u-fw-mon',
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Due Date…' }));
        const panel = screen.getByRole('dialog', { name: 'Due Date' });
        const input = within(panel).getByLabelText('Due Date') as HTMLInputElement;

        expect(input.value).toBe('12/04/2026');
        fireEvent.change(input, { target: { value: '19/04/2026' } });
        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ dueDate: '2026-04-19' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('marks a review-due task reviewed from the quick action menu', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, reviewAt: '2000-01-01T00:00:00.000Z' },
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Mark reviewed' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ reviewAt: undefined });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('advances a review-due task one week from the quick action menu', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderMenu({
            task: { ...task, reviewAt: '2000-01-01' },
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Review in 1 week' }));

        const expected = new Date();
        expected.setDate(expected.getDate() + 7);
        const expectedDate = `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`;
        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ reviewAt: expectedDate });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('does not show mark reviewed for future review dates', () => {
        renderMenu({
            task: { ...task, reviewAt: '2999-01-01T00:00:00.000Z' },
        });

        expect(screen.queryByRole('menuitem', { name: 'Mark reviewed' })).not.toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Review in 1 week' })).not.toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: /review date/i })).toBeInTheDocument();
    });

    it('keeps the menu open while selecting an area from the selector dropdown', async () => {
        const onUpdateTask = vi.fn(async () => ({ success: true as const }));
        const props = renderClosableMenu({
            areas: [{
                id: 'area-work',
                name: 'Work',
                color: '#2563eb',
                order: 0,
                createdAt: now,
                updatedAt: now,
            }],
            onUpdateTask,
        });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Area…' }));
        fireEvent.click(screen.getByRole('button', { name: 'No Area' }));

        const option = screen.getByRole('option', { name: 'Work' });
        fireEvent.mouseDown(option);
        expect(props.onClose).not.toHaveBeenCalled();

        fireEvent.click(option);
        const panel = screen.getByRole('dialog', { name: 'Area' });
        expect(within(panel).getByRole('button', { name: 'Work' })).toBeInTheDocument();

        fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));

        await waitFor(() => {
            expect(onUpdateTask).toHaveBeenCalledWith({ areaId: 'area-work' });
        });
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps secondary task row actions in the quick menu', () => {
        const onStatusChange = vi.fn();
        const props = renderMenu({ onStatusChange });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Convert to Reference' }));
        expect(onStatusChange).toHaveBeenCalledWith('reference');
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('runs the promote-to-project action from the quick menu', () => {
        const onPromoteToProject = vi.fn();
        const props = renderMenu({ onPromoteToProject });

        fireEvent.click(screen.getByRole('menuitem', { name: 'Create project from task' }));

        expect(onPromoteToProject).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('runs the focus action from the quick menu and closes it', () => {
        const onToggle = vi.fn();
        const props = renderMenu({
            focusAction: {
                isFocused: false,
                canToggle: true,
                label: "Add to today's focus",
                title: "Add to today's focus",
                onToggle,
            },
        });

        fireEvent.click(screen.getByRole('menuitem', { name: /add to today's focus/i }));

        expect(onToggle).toHaveBeenCalledTimes(1);
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it('shows disabled focus actions with a reason', () => {
        const onToggle = vi.fn();
        const reason = 'Clarify this task before adding it to Focus.';
        const props = renderMenu({
            focusAction: {
                isFocused: false,
                canToggle: false,
                label: "Add to today's focus",
                title: reason,
                onToggle,
            },
        });

        const focusAction = screen.getByRole('menuitem', { name: /add to today's focus/i });
        expect(focusAction).toBeDisabled();
        expect(focusAction).toHaveAttribute('title', reason);

        fireEvent.click(focusAction);

        expect(onToggle).not.toHaveBeenCalled();
        expect(props.onClose).not.toHaveBeenCalled();
    });
});
