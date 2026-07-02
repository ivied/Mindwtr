import { describe, expect, it } from 'vitest';

import {
    buildBulkOrganizeTaskUpdate,
    buildBulkOrganizeTaskUpdates,
    parseBulkOrganizeTokenInput,
    type BulkOrganizeTaskUpdateInput,
} from './bulk-organize';
import type { Task } from './types';

const baseTask = (id: string): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    contexts: ['@home'],
    tags: ['#alpha'],
    description: `Description ${id}`,
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
});

describe('bulk organize', () => {
    it('builds shared organize updates without title or description', () => {
        const input: BulkOrganizeTaskUpdateInput = {
            status: 'next',
            projectId: 'project-1',
            contexts: ['@computer'],
            tags: ['#launch'],
            startTime: '2026-06-05',
            dueDate: '2026-06-10',
        };

        const updates = buildBulkOrganizeTaskUpdate(baseTask('task-1'), input);

        expect(updates).toEqual({
            status: 'next',
            projectId: 'project-1',
            areaId: undefined,
            contexts: ['@home', '@computer'],
            tags: ['#alpha', '#launch'],
            startTime: '2026-06-05',
            dueDate: '2026-06-10',
        });
        expect('title' in updates).toBe(false);
        expect('description' in updates).toBe(false);
    });

    it('lets area assignment win when no project is selected', () => {
        const updates = buildBulkOrganizeTaskUpdate(baseTask('task-1'), {
            status: 'next',
            areaId: 'area-1',
        });

        expect(updates).toMatchObject({
            status: 'next',
            areaId: 'area-1',
            projectId: undefined,
        });
    });

    it('skips missing task ids when building a batch', () => {
        const task = baseTask('task-1');
        const updates = buildBulkOrganizeTaskUpdates(['task-1', 'missing'], new Map([[task.id, task]]), {
            status: 'waiting',
            assignedTo: 'Mina',
            reviewAt: '2026-06-12',
        });

        expect(updates).toEqual([
            {
                id: 'task-1',
                updates: {
                    status: 'waiting',
                    assignedTo: 'Mina',
                    reviewAt: '2026-06-12',
                },
            },
        ]);
    });

    it('normalizes bulk token input', () => {
        expect(parseBulkOrganizeTokenInput('@home computer,computer', '@')).toEqual(['@home', '@computer']);
        expect(parseBulkOrganizeTokenInput('#launch inbox,launch', '#')).toEqual(['#launch', '#inbox']);
    });
});
