import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@mindwtr/core';

import { shouldShowProjectWorkspaceTask } from './ProjectWorkspace';

const project = (status: Project['status']): Project => ({
    id: 'project-1',
    title: 'Launch',
    color: '#3b82f6',
    order: 0,
    status,
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

const task = (status: Task['status'], overrides: Partial<Task> = {}): Task => ({
    id: `task-${status}`,
    title: `${status} task`,
    status,
    projectId: 'project-1',
    tags: [],
    contexts: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
});

describe('shouldShowProjectWorkspaceTask', () => {
    it('shows completed linked tasks when the selected project is archived', () => {
        expect(shouldShowProjectWorkspaceTask(task('done'), project('archived'))).toBe(true);
        expect(shouldShowProjectWorkspaceTask(task('archived'), project('archived'))).toBe(true);
    });

    it('keeps completed linked tasks out of active project task lists', () => {
        expect(shouldShowProjectWorkspaceTask(task('done'), project('active'))).toBe(false);
        expect(shouldShowProjectWorkspaceTask(task('archived'), project('active'))).toBe(false);
    });

    it('does not show reference or deleted tasks in archived project task lists', () => {
        expect(shouldShowProjectWorkspaceTask(task('reference'), project('archived'))).toBe(false);
        expect(shouldShowProjectWorkspaceTask(
            task('archived', { deletedAt: '2026-05-12T01:00:00.000Z' }),
            project('archived'),
        )).toBe(false);
    });
});
