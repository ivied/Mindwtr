import { describe, expect, it } from 'vitest';

import {
    applyFilter,
    hasActiveFilterCriteria,
    markSavedFilterDeleted,
    normalizeSavedFilters,
    SAVED_FILTER_NO_PROJECT_ID,
} from './saved-filters';
import type { Task } from './types';

const task = (overrides: Partial<Task>): Task => ({
    id: overrides.id ?? 'task',
    title: overrides.title ?? 'Task',
    status: overrides.status ?? 'next',
    tags: overrides.tags ?? [],
    contexts: overrides.contexts ?? [],
    createdAt: overrides.createdAt ?? '2026-05-01T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-01T10:00:00.000Z',
    ...overrides,
});

describe('saved filters', () => {
    it('combines criteria with AND and values within a criterion with OR', () => {
        const tasks = [
            task({ id: 'desk-high', contexts: ['@desk'], tags: ['#urgent'], priority: 'high' }),
            task({ id: 'phone-high', contexts: ['@phone'], tags: ['#later'], priority: 'high' }),
            task({ id: 'desk-low', contexts: ['@desk'], tags: ['#urgent'], priority: 'low' }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk', '@phone'],
            tags: ['#urgent'],
            priority: ['high'],
        });

        expect(filtered.map((item) => item.id)).toEqual(['desk-high']);
    });

    it('can require every selected token for Focus chip filters', () => {
        const tasks = [
            task({ id: 'desk-phone', contexts: ['@desk', '@phone'] }),
            task({ id: 'desk', contexts: ['@desk'] }),
            task({ id: 'phone', contexts: ['@phone'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk', '@phone'],
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['desk-phone']);
    });

    it('supports due date presets and no-project filters', () => {
        const now = new Date('2026-05-09T12:00:00.000Z');
        const tasks = [
            task({ id: 'today', dueDate: '2026-05-09', projectId: undefined }),
            task({ id: 'tomorrow', dueDate: '2026-05-10', projectId: undefined }),
            task({ id: 'project', dueDate: '2026-05-09', projectId: 'project-1' }),
        ];

        const filtered = applyFilter(tasks, {
            dueDateRange: { preset: 'today' },
            projects: [SAVED_FILTER_NO_PROJECT_ID],
        }, { now });

        expect(filtered.map((item) => item.id)).toEqual(['today']);
    });

    it('supports time estimate ranges and empty priority matching', () => {
        const tasks = [
            task({ id: 'short', timeEstimate: '10min' }),
            task({ id: 'medium', timeEstimate: '1hr' }),
            task({ id: 'prioritized', priority: 'high', timeEstimate: '30min' }),
        ];

        const filtered = applyFilter(tasks, {
            priority: ['none'],
            timeEstimateRange: { min: 30, max: 90 },
        });

        expect(filtered.map((item) => item.id)).toEqual(['medium']);
    });

    it('normalizes saved filter payloads for settings sync and storage', () => {
        const filters = normalizeSavedFilters([
            {
                id: 'filter-1',
                name: ' Desk ',
                view: 'focus',
                criteria: {
                    contexts: ['desk', '@desk'],
                    priority: ['high', 'invalid'],
                },
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
                deletedAt: '2026-05-03T00:00:00.000Z',
            },
            { id: '', name: 'Invalid', view: 'focus', criteria: {} },
        ]);

        expect(filters).toHaveLength(1);
        expect(filters[0]).toMatchObject({
            id: 'filter-1',
            name: 'Desk',
            criteria: {
                contexts: ['@desk'],
                priority: ['high'],
            },
            deletedAt: '2026-05-03T00:00:00.000Z',
        });
        expect(hasActiveFilterCriteria(filters[0]?.criteria)).toBe(true);
    });

    it('marks saved filters as tombstones instead of removing them', () => {
        const filters = markSavedFilterDeleted([
            {
                id: 'filter-1',
                name: 'Desk',
                view: 'focus',
                criteria: { contexts: ['@desk'] },
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ], 'filter-1', '2026-05-03T00:00:00.000Z');

        expect(filters).toEqual([
            expect.objectContaining({
                id: 'filter-1',
                updatedAt: '2026-05-03T00:00:00.000Z',
                deletedAt: '2026-05-03T00:00:00.000Z',
            }),
        ]);
    });
});
