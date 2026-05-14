import { fireEvent, render } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { ContextsView } from './ContextsView';

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
});
