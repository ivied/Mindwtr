import { describe, expect, it } from 'vitest';

import {
  buildStaticListVirtualWindow,
  buildProjectTaskReorderGroups,
  getBulkActionFailureMessage,
  resolveStaticListViewportHeight,
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

    it('can keep empty sections for section reordering', () => {
        const groups = buildProjectTaskReorderGroups([
            { type: 'section' as const, id: 'empty', title: 'Empty' },
            { type: 'section' as const, id: 'filled', title: 'Filled' },
            { type: 'task' as const, task: { id: 'task-1' } },
        ], { includeEmptySections: true });

        expect(groups.map((group) => ({
            id: group.id,
            taskIds: group.tasks.map((task) => task.id),
            title: group.title,
        }))).toEqual([
            { id: 'empty', taskIds: [], title: 'Empty' },
            { id: 'filled', taskIds: ['task-1'], title: 'Filled' },
        ]);
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

describe('buildStaticListVirtualWindow', () => {
  it('can use a fallback viewport before the scroll view reports its first measurement', () => {
    const items = Array.from({ length: 138 }, (_, index) => index);
    const viewportHeight = resolveStaticListViewportHeight(0, 844);

    const window = buildStaticListVirtualWindow(items, {
      listOffsetY: 0,
      overscan: 8,
      rowEstimate: 88,
      scrollOffsetY: 0,
      viewportHeight,
    });

    expect(viewportHeight).toBe(844);
    expect(window.startIndex).toBe(0);
    expect(window.items.length).toBeLessThan(40);
    expect(window.items).toEqual(items.slice(0, window.items.length));
    expect(window.bottomSpacerHeight).toBeGreaterThan(0);
  });

  it('returns a bounded visible slice with spacers for large static lists', () => {
    const items = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));

    const window = buildStaticListVirtualWindow(items, {
      listOffsetY: 120,
      overscan: 8,
      rowEstimate: 88,
      scrollOffsetY: 120 + 88 * 50,
      viewportHeight: 704,
    });

    expect(window.startIndex).toBe(42);
    expect(window.items).toHaveLength(24);
    expect(window.items[0]?.id).toBe('item-42');
    expect(window.items.at(-1)?.id).toBe('item-65');
    expect(window.topSpacerHeight).toBe(42 * 88);
    expect(window.bottomSpacerHeight).toBe((200 - 66) * 88);
  });

  it('clamps the first window at the top of the list', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);

    const window = buildStaticListVirtualWindow(items, {
      listOffsetY: 300,
      overscan: 4,
      rowEstimate: 50,
      scrollOffsetY: 0,
      viewportHeight: 200,
    });

    expect(window.startIndex).toBe(0);
    expect(window.items).toEqual(items.slice(0, 12));
    expect(window.topSpacerHeight).toBe(0);
  });
});
