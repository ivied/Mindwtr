import { describe, expect, it } from 'vitest';
import {
    buildEntityMap,
    getNextProjectOrder,
    hasSameEntityIdentity,
    reconcileEntityCollection,
    reserveNextProjectOrder,
    reuseArrayIfShallowEqual,
} from './store-helpers';
import type { Task } from './types';

const createTask = (
    id: string,
    projectId = 'project-1',
    orderNum = 0,
    overrides: Partial<Task> = {}
): Task => ({
    id,
    title: `Task ${id}`,
    status: 'inbox',
    tags: [],
    contexts: [],
    projectId,
    orderNum,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

describe('entity collection helpers', () => {
    it('reuses the previous array when items are shallow-equal', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const previous = [first, second];
        const next = [first, second];

        expect(reuseArrayIfShallowEqual(previous, next)).toBe(previous);
    });

    it('falls back to the next array when any item ref changes', () => {
        const previous = [createTask('t1'), createTask('t2')];
        const changed = createTask('t2', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const next = [previous[0], changed];

        expect(reuseArrayIfShallowEqual(previous, next)).toBe(next);
    });

    it('compares entity identity only through sync-tracked fields', () => {
        const base = createTask('t1');

        expect(hasSameEntityIdentity(base, { ...base, title: 'Updated title' })).toBe(true);
        expect(hasSameEntityIdentity(base, { ...base, rev: 2 })).toBe(false);
        expect(hasSameEntityIdentity(base, { ...base, revBy: 'device-b' })).toBe(false);
        expect(hasSameEntityIdentity(base, { ...base, deletedAt: '2026-01-03T00:00:00.000Z' })).toBe(false);
        expect(hasSameEntityIdentity(base, { ...base, purgedAt: '2026-01-03T00:00:00.000Z' })).toBe(false);
    });

    it('reuses previous refs and map when incoming entities are unchanged', () => {
        const existing = [createTask('t1'), createTask('t2')];
        const existingById = buildEntityMap(existing);
        const incoming = existing.map((task) => ({ ...task }));

        const result = reconcileEntityCollection(existing, existingById, incoming);

        expect(result.items).toBe(existing);
        expect(result.byId).toBe(existingById);
        expect(result.items[0]).toBe(existing[0]);
        expect(result.items[1]).toBe(existing[1]);
    });

    it('keeps unchanged refs when one task changes', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const existing = [first, second, third];
        const existingById = buildEntityMap(existing);
        const changedSecond = createTask('t2', 'project-1', 0, {
            title: 'Task t2 updated',
            updatedAt: '2026-01-02T00:00:00.000Z',
            rev: 2,
        });

        const result = reconcileEntityCollection(existing, existingById, [
            { ...first },
            changedSecond,
            { ...third },
        ]);

        expect(result.items[0]).toBe(first);
        expect(result.items[1]).toBe(changedSecond);
        expect(result.items[2]).toBe(third);
        expect(result.byId.get(first.id)).toBe(first);
        expect(result.byId.get(second.id)).toBe(changedSecond);
        expect(result.byId.get(third.id)).toBe(third);
    });

    it('removes deleted items from the rebuilt map', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const existing = [first, second];
        const existingById = buildEntityMap(existing);

        const result = reconcileEntityCollection(existing, existingById, [{ ...first }]);

        expect(result.items).toEqual([first]);
        expect(result.byId.has(second.id)).toBe(false);
        expect(result.byId.get(first.id)).toBe(first);
    });

    it('preserves stable refs by id when incoming items are reordered', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const existing = [first, second, third];
        const existingById = buildEntityMap(existing);

        const result = reconcileEntityCollection(existing, existingById, [
            { ...third },
            { ...first },
            { ...second },
        ]);

        expect(result.items).toEqual([third, first, second]);
        expect(result.items[0]).toBe(third);
        expect(result.items[1]).toBe(first);
        expect(result.items[2]).toBe(second);
        expect(result.byId.get(first.id)).toBe(first);
        expect(result.byId.get(second.id)).toBe(second);
        expect(result.byId.get(third.id)).toBe(third);
    });
});

describe('getNextProjectOrder', () => {
    it('returns deterministic next project order without mutating shared cache', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
        expect(getNextProjectOrder('project-1', tasks)).toBe(2);
    });

    it('starts from zero for unseen projects on repeated calls', () => {
        const tasks = [createTask('t1', 'project-1', 0)];

        expect(getNextProjectOrder('project-2', tasks)).toBe(0);
        expect(getNextProjectOrder('project-2', tasks)).toBe(0);
    });

    it('reserves unique project orders against the same snapshot', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(reserveNextProjectOrder('project-1', tasks)).toBe(2);
        expect(reserveNextProjectOrder('project-1', tasks)).toBe(3);
        expect(reserveNextProjectOrder('project-2', tasks)).toBe(0);
        expect(reserveNextProjectOrder('project-2', tasks)).toBe(1);
    });

    it('does not carry reserved orders across new task snapshots', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(reserveNextProjectOrder('project-1', tasks)).toBe(2);

        const refreshedTasks = tasks.map((task) => ({ ...task }));
        expect(reserveNextProjectOrder('project-1', refreshedTasks)).toBe(2);
    });
});
