import { describe, expect, it } from 'vitest';

import {
    buildProjectTaskReorderGroups,
    getBulkActionFailureMessage,
    sortProjectTasksByOrder,
} from './task-list-utils';

describe('getBulkActionFailureMessage', () => {
    it('returns the error message when one exists', () => {
        expect(getBulkActionFailureMessage(new Error('Tasks not found: t1'), 'Move failed.')).toBe('Tasks not found: t1');
    });

    it('uses the fallback when the error message is empty', () => {
        expect(getBulkActionFailureMessage(new Error('   '), 'Delete failed.')).toBe('Delete failed.');
    });
});

describe('buildProjectTaskReorderGroups', () => {
    it('groups tasks by section for section-scoped dragging', () => {
        const groups = buildProjectTaskReorderGroups([
            { type: 'section' as const, id: 'section-a', title: 'First' },
            { type: 'task' as const, task: { id: 'a1' } },
            { type: 'task' as const, task: { id: 'a2' } },
            { type: 'section' as const, id: 'section-b', title: 'Second' },
            { type: 'task' as const, task: { id: 'b1' } },
            { type: 'section' as const, id: 'empty', title: 'Empty' },
            { type: 'section' as const, id: 'no-section', title: 'No Section', muted: true },
            { type: 'task' as const, task: { id: 'u1' } },
        ]);

        expect(groups.map((group) => ({
            id: group.id,
            sectionId: group.sectionId,
            taskIds: group.tasks.map((task) => task.id),
            title: group.title,
            muted: group.muted,
        }))).toEqual([
            { id: 'section-a', sectionId: 'section-a', taskIds: ['a1', 'a2'], title: 'First', muted: undefined },
            { id: 'section-b', sectionId: 'section-b', taskIds: ['b1'], title: 'Second', muted: undefined },
            { id: 'no-section', sectionId: null, taskIds: ['u1'], title: 'No Section', muted: true },
        ]);
    });

    it('keeps unsectioned project tasks in a single project-level group', () => {
        const groups = buildProjectTaskReorderGroups([
            { type: 'task' as const, reorderSectionId: undefined, task: { id: 'first' } },
            { type: 'task' as const, reorderSectionId: undefined, task: { id: 'second' } },
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0]?.sectionId).toBeUndefined();
        expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['first', 'second']);
    });
});

describe('sortProjectTasksByOrder', () => {
    it('sorts by order values before falling back to created time', () => {
        expect(sortProjectTasksByOrder([
            { id: 'no-order-old', createdAt: '2026-01-01T00:00:00.000Z' },
            { id: 'second', order: 2, createdAt: '2026-01-02T00:00:00.000Z' },
            { id: 'first', orderNum: 1, createdAt: '2026-01-03T00:00:00.000Z' },
            { id: 'no-order-new', createdAt: '2026-01-04T00:00:00.000Z' },
        ]).map((task) => task.id)).toEqual(['first', 'second', 'no-order-old', 'no-order-new']);
    });

    it('falls back to created time when no task has an order value', () => {
        expect(sortProjectTasksByOrder([
            { id: 'newer', createdAt: '2026-01-02T00:00:00.000Z' },
            { id: 'older', createdAt: '2026-01-01T00:00:00.000Z' },
        ]).map((task) => task.id)).toEqual(['older', 'newer']);
    });
});
