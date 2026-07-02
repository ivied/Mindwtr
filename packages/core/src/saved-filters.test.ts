import { describe, expect, it } from 'vitest';

import {
    applyFilter,
    createTaskFilterPredicate,
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

    it('can override context matching to any while keeping tag matching strict', () => {
        const tasks = [
            task({ id: 'desk-urgent', contexts: ['@desk'], tags: ['#urgent'] }),
            task({ id: 'phone-urgent', contexts: ['@phone'], tags: ['#urgent'] }),
            task({ id: 'desk-later', contexts: ['@desk'], tags: ['#later'] }),
        ];

        const filtered = applyFilter(tasks, {
            contexts: ['@desk', '@phone'],
            contextMatchMode: 'any',
            tags: ['#urgent'],
        }, { tokenMatchMode: 'all' });

        expect(filtered.map((item) => item.id)).toEqual(['desk-urgent', 'phone-urgent']);
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

    it('matches custom time estimates by preset bucket while preserving exact ranges', () => {
        const tasks = [
            task({ id: 'preset-2h', timeEstimate: '2hr' }),
            task({ id: 'custom-150', timeEstimate: 'custom:150' }),
            task({ id: 'preset-3h', timeEstimate: '3hr' }),
        ];

        expect(applyFilter(tasks, { timeEstimates: ['3hr'] }).map((item) => item.id)).toEqual(['custom-150', 'preset-3h']);
        expect(applyFilter(tasks, { timeEstimateRange: { min: 130, max: 160 } }).map((item) => item.id)).toEqual(['custom-150']);
    });

    it('matches location criteria by case-insensitive text', () => {
        const tasks = [
            task({ id: 'office', location: 'Main Office' }),
            task({ id: 'home', location: 'Home desk' }),
            task({ id: 'none' }),
        ];

        const filtered = applyFilter(tasks, {
            locations: ['office'],
        });

        expect(filtered.map((item) => item.id)).toEqual(['office']);
    });

    it('prepares the project lookup once when applying area filters', () => {
        const OriginalMap = globalThis.Map;
        const setGlobalMap = (value: MapConstructor) => {
            (globalThis as typeof globalThis & { Map: MapConstructor }).Map = value;
        };
        let mapConstructions = 0;
        class CountingMap<K, V> extends OriginalMap<K, V> {
            constructor(entries?: Iterable<readonly [K, V]> | null) {
                mapConstructions += 1;
                super(entries);
            }
        }
        setGlobalMap(CountingMap as unknown as MapConstructor);

        try {
            const tasks = [
                task({ id: 'work-a', projectId: 'project-work' }),
                task({ id: 'work-b', projectId: 'project-work' }),
                task({ id: 'home', projectId: 'project-home' }),
            ];

            const filtered = applyFilter(tasks, {
                areas: ['area-work'],
            }, {
                projects: [
                    { id: 'project-work', title: 'Work', status: 'active', areaId: 'area-work', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                    { id: 'project-home', title: 'Home', status: 'active', areaId: 'area-home', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                ],
            });

            expect(filtered.map((item) => item.id)).toEqual(['work-a', 'work-b']);
            expect(mapConstructions).toBe(1);
        } finally {
            setGlobalMap(OriginalMap);
        }
    });

    it('creates a reusable predicate without rebuilding project lookup per task', () => {
        const OriginalMap = globalThis.Map;
        const setGlobalMap = (value: MapConstructor) => {
            (globalThis as typeof globalThis & { Map: MapConstructor }).Map = value;
        };
        let mapConstructions = 0;
        class CountingMap<K, V> extends OriginalMap<K, V> {
            constructor(entries?: Iterable<readonly [K, V]> | null) {
                mapConstructions += 1;
                super(entries);
            }
        }
        setGlobalMap(CountingMap as unknown as MapConstructor);

        try {
            const tasks = [
                task({ id: 'work-a', projectId: 'project-work' }),
                task({ id: 'work-b', projectId: 'project-work' }),
                task({ id: 'home', projectId: 'project-home' }),
            ];
            const predicate = createTaskFilterPredicate({
                areas: ['area-work'],
            }, {
                projects: [
                    { id: 'project-work', title: 'Work', status: 'active', areaId: 'area-work', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                    { id: 'project-home', title: 'Home', status: 'active', areaId: 'area-home', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z' },
                ],
            });

            expect(tasks.filter(predicate).map((item) => item.id)).toEqual(['work-a', 'work-b']);
            expect(tasks.filter(predicate).map((item) => item.id)).toEqual(['work-a', 'work-b']);
            expect(mapConstructions).toBe(1);
        } finally {
            setGlobalMap(OriginalMap);
        }
    });

    it('normalizes saved filter payloads for settings sync and storage', () => {
        const filters = normalizeSavedFilters([
            {
                id: 'filter-1',
                name: ' Desk ',
                view: 'focus',
                criteria: {
                    contexts: ['desk', '@desk'],
                    contextMatchMode: 'any',
                    priority: ['high', 'invalid'],
                    locations: [' Office ', ''],
                },
                sortBy: 'start',
                sortOrder: 'asc',
                groupBy: 'project',
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
                contextMatchMode: 'any',
                priority: ['high'],
                locations: ['Office'],
            },
            sortBy: 'start',
            sortOrder: 'asc',
            groupBy: 'project',
            deletedAt: '2026-05-03T00:00:00.000Z',
        });
        expect(hasActiveFilterCriteria(filters[0]?.criteria)).toBe(true);
    });

    it('preserves tag grouping for saved Focus filters', () => {
        const filters = normalizeSavedFilters([
            {
                id: 'filter-1',
                name: 'Tag view',
                view: 'focus',
                criteria: { tags: ['#deep'] },
                groupBy: 'tag',
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
        ]);

        expect(filters[0]?.groupBy).toBe('tag');
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
