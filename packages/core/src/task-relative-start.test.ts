import { describe, expect, it } from 'vitest';

import { computeRelativeStartTime, resolveRelativeStartUpdates } from './task-relative-start';

describe('relative task starts', () => {
    it('does not create midnight-anchored sub-day starts from date-only due dates', () => {
        expect(computeRelativeStartTime('2026-03-12', { amount: -30, unit: 'minute' })).toBeUndefined();
        expect(computeRelativeStartTime('2026-03-12', { amount: -2, unit: 'hour' })).toBeUndefined();
    });

    it('preserves date-only starts for day and week offsets from date-only due dates', () => {
        expect(computeRelativeStartTime('2026-03-12', { amount: -1, unit: 'day' })).toBe('2026-03-11');
        expect(computeRelativeStartTime('2026-03-12', { amount: -1, unit: 'week' })).toBe('2026-03-05');
    });

    it('allows sub-day starts from timed due dates', () => {
        expect(computeRelativeStartTime('2026-03-12T09:30', { amount: -30, unit: 'minute' })).toBe('2026-03-12T09:00');
        expect(computeRelativeStartTime('2026-03-12T09:30', { amount: -2, unit: 'hour' })).toBe('2026-03-12T07:30');
    });

    it('clears invalid sub-day relative offsets when a due date is date-only', () => {
        expect(resolveRelativeStartUpdates(
            { dueDate: '2026-03-12', startTime: undefined, relativeStartOffset: undefined },
            { relativeStartOffset: { amount: -30, unit: 'minute' } }
        )).toEqual({ relativeStartOffset: undefined });
    });
});
