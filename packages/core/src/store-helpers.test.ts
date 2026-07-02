import { describe, expect, it } from 'vitest';
import {
    buildEntityMap,
    clearDeletedTaskProjectArchiveMetadata,
    computeProjectDerivedState,
    computeTaskDerivedState,
    createProjectOrderReserver,
    applyTaskUpdates,
    getNextProjectOrder,
    hasSameEntityIdentity,
    reconcileEntityCollection,
    replaceEntitiesInArray,
    replaceEntitiesInMap,
    replaceEntityInArray,
    replaceEntityInMap,
    restoreSectionFromProjectArchive,
    restoreTaskFromProjectArchive,
    reuseArrayIfShallowEqual,
} from './store-helpers';
import type { Project, Section, Task } from './types';

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

const createProject = (id: string, overrides: Partial<Project> = {}): Project => ({
    id,
    title: `Project ${id}`,
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const createSection = (
    id: string,
    projectId = 'project-1',
    order = 0,
    overrides: Partial<Section> = {}
): Section => ({
    id,
    projectId,
    title: `Section ${id}`,
    order,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});


describe('relative start updates', () => {
    it('recomputes startTime from the stored due-date offset when dueDate changes', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            dueDate: '2026-05-01',
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.dueDate).toBe('2026-05-01');
        expect(updatedTask.startTime).toBe('2026-04-28');
        expect((updatedTask as Task & { relativeStartOffset?: unknown }).relativeStartOffset).toEqual({
            amount: -3,
            unit: 'day',
        });
    });

    it('sets startTime when a relative offset is added to a task with a dueDate', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: undefined,
        });

        const { updatedTask } = applyTaskUpdates(task, {
            relativeStartOffset: { amount: -1, unit: 'week' },
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.startTime).toBe('2026-04-17');
        expect(updatedTask.relativeStartOffset).toEqual({ amount: -1, unit: 'week' });
    });

    it('recomputes when full-form saves include an unchanged startTime', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            dueDate: '2026-05-01',
            startTime: '2026-04-21',
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.startTime).toBe('2026-04-28');
        expect(updatedTask.relativeStartOffset).toEqual({ amount: -3, unit: 'day' });
    });

    it('clears the relative start link when startTime is edited directly', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            startTime: '2026-04-22',
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.startTime).toBe('2026-04-22');
        expect((updatedTask as Task & { relativeStartOffset?: unknown }).relativeStartOffset).toBeUndefined();
    });

    it('keeps the current startTime as absolute when dueDate is removed', () => {
        const task = createTask('t1', undefined, undefined, {
            dueDate: '2026-04-24',
            startTime: '2026-04-21',
            relativeStartOffset: { amount: -3, unit: 'day' },
        } as Partial<Task>);

        const { updatedTask } = applyTaskUpdates(task, {
            dueDate: undefined,
        }, '2026-04-20T10:00:00.000Z');

        expect(updatedTask.dueDate).toBeUndefined();
        expect(updatedTask.startTime).toBe('2026-04-21');
        expect((updatedTask as Task & { relativeStartOffset?: unknown }).relativeStartOffset).toBeUndefined();
    });
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

    it('patches one array slot while preserving unchanged refs', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const changed = createTask('t2', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });

        const next = replaceEntityInArray([first, second], second.id, changed);

        expect(next).toEqual([first, changed]);
        expect(next[0]).toBe(first);
    });

    it('patches one map entry while preserving unchanged values', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const changed = createTask('t2', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const previous = buildEntityMap([first, second]);

        const next = replaceEntityInMap(previous, changed);

        expect(next).not.toBe(previous);
        expect(next.get(first.id)).toBe(first);
        expect(next.get(second.id)).toBe(changed);
    });

    it('patches multiple array slots while preserving unchanged refs', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const changedFirst = createTask('t1', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const changedThird = createTask('t3', 'project-1', 0, { updatedAt: '2026-01-03T00:00:00.000Z' });

        const next = replaceEntitiesInArray([first, second, third], [changedFirst, changedThird]);

        expect(next).toEqual([changedFirst, second, changedThird]);
        expect(next[1]).toBe(second);
    });

    it('patches multiple map entries while preserving unchanged values', () => {
        const first = createTask('t1');
        const second = createTask('t2');
        const third = createTask('t3');
        const changedFirst = createTask('t1', 'project-1', 0, { updatedAt: '2026-01-02T00:00:00.000Z' });
        const changedThird = createTask('t3', 'project-1', 0, { updatedAt: '2026-01-03T00:00:00.000Z' });
        const previous = buildEntityMap([first, second, third]);

        const next = replaceEntitiesInMap(previous, [changedFirst, changedThird]);

        expect(next).not.toBe(previous);
        expect(next.get(first.id)).toBe(changedFirst);
        expect(next.get(second.id)).toBe(second);
        expect(next.get(third.id)).toBe(changedThird);
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

describe('project archive restore helpers', () => {
    it('restores reversible task archive metadata and bumps sync identity', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const restoredAt = '2026-01-06T00:00:00.000Z';
        const task = createTask('restore-task', 'project-1', 0, {
            status: 'done',
            completedAt: archivedAt,
            isFocusedToday: false,
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: '2026-01-03T00:00:00.000Z',
            isFocusedTodayBeforeProjectArchive: true,
            projectArchivedAt: archivedAt,
            rev: 4,
        });

        const restored = restoreTaskFromProjectArchive(task, restoredAt, 'device-b');

        expect(restored).not.toBe(task);
        expect(restored.status).toBe('next');
        expect(restored.completedAt).toBe('2026-01-03T00:00:00.000Z');
        expect(restored.isFocusedToday).toBe(true);
        expect(restored.statusBeforeProjectArchive).toBeUndefined();
        expect(restored.completedAtBeforeProjectArchive).toBeUndefined();
        expect(restored.isFocusedTodayBeforeProjectArchive).toBeUndefined();
        expect(restored.projectArchivedAt).toBeUndefined();
        expect(restored.updatedAt).toBe(restoredAt);
        expect(restored.rev).toBe(5);
        expect(restored.revBy).toBe('device-b');
    });

    it('does not rewrite deleted project-archive task snapshots', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const task = createTask('deleted-task', 'project-1', 0, {
            status: 'done',
            completedAt: archivedAt,
            deletedAt: '2026-01-05T12:00:00.000Z',
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
            projectArchivedAt: archivedAt,
            rev: 4,
            updatedAt: archivedAt,
        });

        expect(restoreTaskFromProjectArchive(task, '2026-01-06T00:00:00.000Z', 'device-b')).toBe(task);
    });

    it('clears project-archive metadata from deleted task tombstones without bumping sync identity', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const task = createTask('deleted-task', 'project-1', 0, {
            status: 'done',
            completedAt: archivedAt,
            deletedAt: '2026-01-05T12:00:00.000Z',
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
            projectArchivedAt: archivedAt,
            rev: 4,
            updatedAt: archivedAt,
        });

        const cleaned = clearDeletedTaskProjectArchiveMetadata(task);

        expect(cleaned).not.toBe(task);
        expect(cleaned.deletedAt).toBe(task.deletedAt);
        expect(cleaned.updatedAt).toBe(task.updatedAt);
        expect(cleaned.rev).toBe(task.rev);
        expect(cleaned.revBy).toBe(task.revBy);
        expect(cleaned.statusBeforeProjectArchive).toBeUndefined();
        expect(cleaned.completedAtBeforeProjectArchive).toBeUndefined();
        expect(cleaned.isFocusedTodayBeforeProjectArchive).toBeUndefined();
        expect(cleaned.projectArchivedAt).toBeUndefined();
    });

    it('does not rewrite manually changed project-archive task snapshots', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const task = createTask('changed-task', 'project-1', 0, {
            status: 'done',
            completedAt: '2026-01-05T12:00:00.000Z',
            statusBeforeProjectArchive: 'waiting',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
            projectArchivedAt: archivedAt,
            rev: 4,
            updatedAt: '2026-01-05T12:00:00.000Z',
        });

        expect(restoreTaskFromProjectArchive(task, '2026-01-06T00:00:00.000Z', 'device-b')).toBe(task);
    });

    it('restores only sections hidden by project archive', () => {
        const archivedAt = '2026-01-05T00:00:00.000Z';
        const restoredAt = '2026-01-06T00:00:00.000Z';
        const hiddenSection = createSection('restore-section', 'project-1', 0, {
            deletedAt: archivedAt,
            deletedAtBeforeProjectArchive: null,
            projectArchivedAt: archivedAt,
            rev: 7,
        });
        const preDeletedSection = createSection('deleted-section', 'project-1', 1, {
            deletedAt: '2026-01-04T00:00:00.000Z',
            deletedAtBeforeProjectArchive: '2026-01-04T00:00:00.000Z',
            projectArchivedAt: archivedAt,
            rev: 7,
        });

        const restored = restoreSectionFromProjectArchive(hiddenSection, restoredAt, 'device-b');

        expect(restored).not.toBe(hiddenSection);
        expect(restored.deletedAt).toBeUndefined();
        expect(restored.deletedAtBeforeProjectArchive).toBeUndefined();
        expect(restored.projectArchivedAt).toBeUndefined();
        expect(restored.updatedAt).toBe(restoredAt);
        expect(restored.rev).toBe(8);
        expect(restored.revBy).toBe('device-b');
        expect(restoreSectionFromProjectArchive(preDeletedSection, restoredAt, 'device-b')).toBe(preDeletedSection);
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

    it('reserves unique project orders with an explicit reserver', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];
        const reserveProjectOrder = createProjectOrderReserver(tasks);

        expect(reserveProjectOrder('project-1')).toBe(2);
        expect(reserveProjectOrder('project-1')).toBe(3);
        expect(reserveProjectOrder('project-2')).toBe(0);
        expect(reserveProjectOrder('project-2')).toBe(1);
    });

    it('does not carry reserved orders across reserver instances', () => {
        const tasks = [
            createTask('t1', 'project-1', 0),
            createTask('t2', 'project-1', 1),
        ];

        expect(createProjectOrderReserver(tasks)('project-1')).toBe(2);

        const refreshedTasks = tasks.map((task) => ({ ...task }));
        expect(createProjectOrderReserver(refreshedTasks)('project-1')).toBe(2);
    });
});

describe('derived store state helpers', () => {
    it('counts only active focused-today tasks toward the focus limit', () => {
        const derived = computeTaskDerivedState([
            createTask('active-focused', 'project-1', 0, { status: 'next', isFocusedToday: true }),
            createTask('done-focused', 'project-1', 1, { status: 'done', isFocusedToday: true }),
            createTask('reference-focused', 'project-1', 2, { status: 'reference', isFocusedToday: true }),
            createTask('deleted-focused', 'project-1', 3, {
                status: 'next',
                isFocusedToday: true,
                deletedAt: '2026-01-02T00:00:00.000Z',
            }),
        ]);

        expect(derived.focusedCount).toBe(1);
    });

    it('derives transient date-coherence issues without mutating tasks', () => {
        const incoherent = createTask('incoherent', 'project-1', 0, {
            startTime: '2026-04-25',
            dueDate: '2026-04-24',
        });
        const coherent = createTask('coherent', 'project-1', 1, {
            startTime: '2026-04-24',
            dueDate: '2026-04-24',
        });

        const derived = computeTaskDerivedState([incoherent, coherent]);

        expect(derived.dateCoherenceIssuesByTaskId.get('incoherent')).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
        expect(derived.dateCoherenceIssuesByTaskId.has('coherent')).toBe(false);
        expect(incoherent.startTime).toBe('2026-04-25');
        expect(incoherent.dueDate).toBe('2026-04-24');
    });

    it('derives query-scoped task indexes in one pass', () => {
        const nextTask = createTask('next', 'project-1', 0, {
            status: 'next',
            contexts: ['@office'],
            tags: ['#deep'],
            isFocusedToday: true,
        });
        const doneTask = createTask('done', 'project-1', 1, {
            status: 'done',
            contexts: ['@office'],
            tags: ['#done'],
            isFocusedToday: true,
        });
        const waitingTask = createTask('waiting', 'project-2', 2, {
            status: 'waiting',
            contexts: ['@home'],
            tags: ['#deep'],
        });

        const derived = computeTaskDerivedState([nextTask, doneTask, waitingTask]);

        expect(derived.tasksByProjectId.get('project-1')?.map((task) => task.id)).toEqual(['next', 'done']);
        expect(derived.tasksByContext.get('@office')?.map((task) => task.id)).toEqual(['next', 'done']);
        expect(derived.tasksByTag.get('#deep')?.map((task) => task.id)).toEqual(['next', 'waiting']);
        expect(derived.focusedTasks.map((task) => task.id)).toEqual(['next']);
        expect(derived.projectTaskSummaryById.get('project-1')).toEqual({
            activeTaskCount: 1,
            nextAction: nextTask,
        });
        expect(derived.projectTaskSummaryById.get('project-2')).toEqual({
            activeTaskCount: 1,
        });
    });

    it('derives focused project count while ignoring tombstones', () => {
        const derived = computeProjectDerivedState([
            createProject('focused-a', { isFocused: true }),
            createProject('focused-b', { isFocused: true, status: 'archived' }),
            createProject('deleted-focused', {
                isFocused: true,
                deletedAt: '2026-01-02T00:00:00.000Z',
            }),
            createProject('plain'),
        ]);

        expect(derived.focusedProjectCount).toBe(2);
    });

    it('derives section-scoped sequential project ids', () => {
        const derived = computeProjectDerivedState([
            createProject('project-wide', { isSequential: true }),
            createProject('section-wide', { isSequential: true, sequentialScope: 'section' }),
            createProject('parallel-section', { isSequential: false, sequentialScope: 'section' }),
        ]);

        expect([...derived.sequentialProjectIds]).toEqual(['project-wide', 'section-wide']);
        expect([...derived.sequentialWithinSectionProjectIds]).toEqual(['section-wide']);
    });
});
