import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { useTaskStore, type Task } from '@mindwtr/core';
import { ReviewTaskList } from './ReviewTaskList';

const scrollIntoViewMock = vi.fn();

vi.mock('../../TaskItem', () => ({
    TaskItem: ({ task }: { task: Task }) => <div data-task-id={task.id}>{task.title}</div>,
}));

const makeTask = (id: string, title: string): Task => ({
    id,
    title,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
});

describe('ReviewTaskList', () => {
    beforeEach(() => {
        scrollIntoViewMock.mockReset();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value: scrollIntoViewMock,
        });
        useTaskStore.setState((state) => ({
            ...state,
            tasks: [],
            _allTasks: [],
            projects: [],
            _allProjects: [],
            sections: [],
            _allSections: [],
            areas: [],
            _allAreas: [],
        }));
    });

    it('scrolls highlighted task into view', async () => {
        const tasks = [
            makeTask('task-1', 'Task 1'),
            makeTask('task-2', 'Task 2'),
            makeTask('task-3', 'Task 3'),
        ];

        useTaskStore.setState((state) => ({
            ...state,
            tasks,
            _allTasks: tasks,
        }));

        render(
            <ReviewTaskList
                tasks={tasks}
                showListDetails
                selectionMode={false}
                multiSelectedIds={new Set()}
                highlightTaskId="task-3"
                onToggleSelect={vi.fn()}
                t={(key) => key}
            />
        );

        await waitFor(() => {
            expect(scrollIntoViewMock).toHaveBeenCalled();
            expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'start' });
        });
    });
});
