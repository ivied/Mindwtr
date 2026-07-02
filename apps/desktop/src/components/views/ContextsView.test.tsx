import { act, fireEvent, render } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { ContextsView } from './ContextsView';
import { CONTEXTS_VIEW_STATE_STORAGE_KEY, dispatchContextsTokenSelection } from '../../lib/contexts-view-state';

const initialTaskState = useTaskStore.getState();
const now = '2026-05-12T12:00:00.000Z';

const makeTask = (id: string, overrides: Partial<Task>): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
});

const renderContextsView = () => render(
    <LanguageProvider>
        <ContextsView />
    </LanguageProvider>
);

describe('ContextsView', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useTaskStore.setState(initialTaskState, true);
        const tasks = [
            makeTask('task-1', {
                title: 'Plan launch',
                contexts: ['@Office'],
                tags: ['#ERP', '#Finance'],
            }),
            makeTask('task-2', {
                title: 'Write brief',
                contexts: ['@Home'],
                tags: [],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });
    });

    it('groups context and tag filters into collapsible sections', () => {
        const { getByRole, queryByRole } = renderContextsView();

        const contextsHeader = getByRole('button', { name: 'Contexts (2)' });
        const tagsHeader = getByRole('button', { name: 'Tags (2)' });

        expect(contextsHeader).toHaveAttribute('aria-expanded', 'true');
        expect(tagsHeader).toHaveAttribute('aria-expanded', 'true');
        expect(getByRole('button', { name: '@Office (1)' })).toBeInTheDocument();
        expect(getByRole('button', { name: '@Home (1)' })).toBeInTheDocument();
        expect(getByRole('button', { name: '#ERP (1)' })).toBeInTheDocument();
        expect(getByRole('button', { name: '#Finance (1)' })).toBeInTheDocument();

        fireEvent.click(tagsHeader);

        expect(tagsHeader).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: '#ERP (1)' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: '#Finance (1)' })).not.toBeInTheDocument();
        expect(getByRole('button', { name: '@Office (1)' })).toBeInTheDocument();

        fireEvent.click(contextsHeader);

        expect(contextsHeader).toHaveAttribute('aria-expanded', 'false');
        expect(queryByRole('button', { name: '@Office (1)' })).not.toBeInTheDocument();
        expect(queryByRole('button', { name: '@Home (1)' })).not.toBeInTheDocument();
    });

    it('keeps tag filters selectable from the tag section', () => {
        const { getByRole, getByText } = renderContextsView();

        fireEvent.click(getByRole('button', { name: '#ERP (1)' }));

        expect(getByRole('heading', { name: '#ERP' })).toBeInTheDocument();
        expect(getByText('Plan launch')).toBeInTheDocument();
    });

    it('keeps the sort control labeled and visually scannable', () => {
        const { getByRole, getByTestId } = renderContextsView();

        expect(getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
        expect(getByTestId('contexts-sort-icon')).toBeInTheDocument();
    });

    it('hides done tasks from the default context filter while keeping the Done status available', () => {
        const tasks = [
            makeTask('active-office', {
                title: 'Active office task',
                contexts: ['@Office'],
            }),
            makeTask('done-office', {
                title: 'Done office task',
                status: 'done',
                contexts: ['@Office'],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });

        const { getAllByRole, getByRole, getByText, queryByText } = renderContextsView();

        expect(getByRole('button', { name: '@Office (1)' })).toBeInTheDocument();
        expect(getByText('Active office task')).toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        const doneStatusButton = getAllByRole('button', { name: 'Done' }).find(
            (button) => button.getAttribute('aria-pressed') === 'false'
        );
        expect(doneStatusButton).toBeTruthy();

        fireEvent.click(doneStatusButton!);

        expect(getByText('Done office task')).toBeInTheDocument();
        expect(queryByText('Active office task')).not.toBeInTheDocument();
    });

    it('allows multiple status filters while keeping Done hidden until selected', () => {
        const tasks = [
            makeTask('next-office', {
                title: 'Next office task',
                status: 'next',
                contexts: ['@Office'],
            }),
            makeTask('waiting-office', {
                title: 'Waiting office task',
                status: 'waiting',
                contexts: ['@Office'],
            }),
            makeTask('done-office', {
                title: 'Done office task',
                status: 'done',
                contexts: ['@Office'],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });

        const { getAllByRole, getByText, queryByText } = renderContextsView();
        const statusButton = (label: string) => {
            const button = getAllByRole('button', { name: label }).find((item) => item.hasAttribute('aria-pressed'));
            expect(button).toBeTruthy();
            return button!;
        };

        expect(getByText('Next office task')).toBeInTheDocument();
        expect(getByText('Waiting office task')).toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        const nextButton = statusButton('Next');
        fireEvent.click(nextButton);

        expect(nextButton).toHaveAttribute('aria-pressed', 'true');
        expect(nextButton).toHaveClass('bg-primary', 'text-primary-foreground');
        expect(getByText('Next office task')).toBeInTheDocument();
        expect(queryByText('Waiting office task')).not.toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        fireEvent.click(statusButton('Waiting'));

        expect(getByText('Next office task')).toBeInTheDocument();
        expect(getByText('Waiting office task')).toBeInTheDocument();
        expect(queryByText('Done office task')).not.toBeInTheDocument();

        fireEvent.click(statusButton('Done'));

        expect(getByText('Next office task')).toBeInTheDocument();
        expect(getByText('Waiting office task')).toBeInTheDocument();
        expect(getByText('Done office task')).toBeInTheDocument();
    });

    it('sorts context tasks with the shared task sort preference', () => {
        const tasks = [
            makeTask('task-b', {
                title: 'Write brief',
                contexts: ['@Office'],
            }),
            makeTask('task-a', {
                title: 'Archive notes',
                contexts: ['@Office'],
            }),
            makeTask('task-c', {
                title: 'Plan launch',
                contexts: ['@Office'],
            }),
        ];
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas: [],
            settings: {},
        });

        const { container, getByRole } = renderContextsView();

        fireEvent.change(getByRole('combobox', { name: 'Sort' }), {
            target: { value: 'title' },
        });

        const text = container.textContent ?? '';
        expect(text.indexOf('Archive notes')).toBeLessThan(text.indexOf('Plan launch'));
        expect(text.indexOf('Plan launch')).toBeLessThan(text.indexOf('Write brief'));
    });

    it('applies task token navigation while the context view is mounted', () => {
        const { getByRole, getByText } = renderContextsView();

        act(() => {
            dispatchContextsTokenSelection('#ERP');
        });

        expect(getByRole('heading', { name: '#ERP' })).toBeInTheDocument();
        expect(getByText('Plan launch')).toBeInTheDocument();
        expect(window.localStorage.getItem(CONTEXTS_VIEW_STATE_STORAGE_KEY)).toContain('"selectedContext":"#ERP"');
    });

    it('selects and clears all visible tasks in context selection mode', () => {
        const { getAllByRole, getByRole } = renderContextsView();

        fireEvent.click(getByRole('button', { name: 'Select' }));

        expect(getByRole('button', { name: 'Select All' })).toBeEnabled();
        expect(getByRole('button', { name: 'Clear' })).toBeDisabled();

        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true, true]);
        expect(getByRole('button', { name: 'Select All' })).toBeDisabled();
        expect(getByRole('button', { name: 'Clear' })).toBeEnabled();

        fireEvent.click(getByRole('button', { name: 'Clear' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([false, false]);
    });

    it('selects all only within the current context search results', () => {
        const { getAllByRole, getByPlaceholderText, getByRole, getByText, queryByText } = renderContextsView();

        fireEvent.change(getByPlaceholderText('Search...'), {
            target: { value: 'Plan' },
        });
        expect(getByText('Plan launch')).toBeInTheDocument();
        expect(queryByText('Write brief')).not.toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'Select' }));
        fireEvent.click(getByRole('button', { name: 'Select All' }));

        expect(getAllByRole('checkbox', { name: 'Select task' }).map((checkbox) => (
            (checkbox as HTMLInputElement).checked
        ))).toEqual([true]);
    });
});
