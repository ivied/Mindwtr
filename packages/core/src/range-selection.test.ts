import { describe, expect, it } from 'vitest';
import { updateRangeSelection } from './range-selection';

describe('updateRangeSelection', () => {
    it('toggles a single target and stores it as the anchor', () => {
        const result = updateRangeSelection({
            anchorId: null,
            selectedIds: new Set(),
            targetId: 'task-2',
            visibleIds: ['task-1', 'task-2', 'task-3'],
        });

        expect(result.anchorId).toBe('task-2');
        expect(Array.from(result.selectedIds)).toEqual(['task-2']);
    });

    it('adds the contiguous visible range between anchor and target', () => {
        const result = updateRangeSelection({
            anchorId: 'task-1',
            range: true,
            selectedIds: new Set(['task-1']),
            targetId: 'task-4',
            visibleIds: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5'],
        });

        expect(Array.from(result.selectedIds)).toEqual(['task-1', 'task-2', 'task-3', 'task-4']);
        expect(result.anchorId).toBe('task-4');
    });

    it('adds a reverse contiguous range without clearing existing selection', () => {
        const result = updateRangeSelection({
            anchorId: 'task-4',
            range: true,
            selectedIds: new Set(['task-4', 'task-6']),
            targetId: 'task-2',
            visibleIds: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6'],
        });

        expect(Array.from(result.selectedIds)).toEqual(['task-4', 'task-6', 'task-2', 'task-3']);
    });

    it('range-selects only visible ids', () => {
        const result = updateRangeSelection({
            anchorId: 'task-1',
            range: true,
            selectedIds: new Set(['task-1']),
            targetId: 'task-5',
            visibleIds: ['task-1', 'task-3', 'task-5'],
        });

        expect(Array.from(result.selectedIds)).toEqual(['task-1', 'task-3', 'task-5']);
    });

    it('selects the target instead of toggling it off when range mode has no visible anchor', () => {
        const result = updateRangeSelection({
            anchorId: 'hidden-task',
            range: true,
            selectedIds: new Set(['task-2']),
            targetId: 'task-2',
            visibleIds: ['task-1', 'task-2'],
        });

        expect(Array.from(result.selectedIds)).toEqual(['task-2']);
    });
});
