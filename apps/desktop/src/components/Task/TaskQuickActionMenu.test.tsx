import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
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

const renderMenu = (overrides: Partial<ComponentProps<typeof TaskQuickActionMenu>> = {}) => {
    const props: ComponentProps<typeof TaskQuickActionMenu> = {
        task,
        x: 16,
        y: 16,
        t,
        nativeDateInputLocale: 'en-US',
        contextOptions: [],
        areas: [],
        readOnly: false,
        onClose: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onCreateArea: vi.fn(async () => null),
        onUpdateTask: vi.fn(async () => ({ success: true })),
        ...overrides,
    };
    render(<TaskQuickActionMenu {...props} />);
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

        const dueButton = screen.getByRole('menuitem', { name: /due date/i });
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
        fireEvent.click(screen.getByRole('menuitem', { name: /due date/i }));

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: /due date/i })).not.toBeInTheDocument();

        fireEvent.keyDown(window, { key: 'Escape' });
        expect(props.onClose).toHaveBeenCalledTimes(1);
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
});
