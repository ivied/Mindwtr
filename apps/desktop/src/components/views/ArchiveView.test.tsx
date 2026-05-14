import { render } from '@testing-library/react';
import type { Task } from '@mindwtr/core';
import { safeFormatDate, useTaskStore } from '@mindwtr/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../../contexts/language-context';
import { ArchiveView } from './ArchiveView';

const initialTaskState = useTaskStore.getState();

const archivedTask: Task = {
    id: 'task-1',
    title: 'Archived task',
    status: 'archived',
    tags: [],
    contexts: [],
    completedAt: '2026-05-12T08:30:00.000Z',
    createdAt: '2026-05-10T08:30:00.000Z',
    updatedAt: '2026-05-12T08:30:00.000Z',
};

describe('ArchiveView', () => {
    beforeEach(() => {
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            tasks: [],
            _allTasks: [archivedTask],
            settings: {},
        });
    });

    it('shows the archived task completion date and time', () => {
        const completionLabel = safeFormatDate(archivedTask.completedAt, 'Pp');

        const { getByText } = render(
            <LanguageProvider>
                <ArchiveView />
            </LanguageProvider>
        );

        expect(getByText('Archived task')).toBeInTheDocument();
        expect(getByText(`Completed: ${completionLabel}`)).toBeInTheDocument();
    });
});
