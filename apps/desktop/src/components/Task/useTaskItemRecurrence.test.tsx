import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { useTaskItemRecurrence } from './useTaskItemRecurrence';

const baseTask: Task = {
    id: 'task-1',
    title: 'Monthly check',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
};

describe('useTaskItemRecurrence', () => {
    it('anchors custom monthly recurrence controls to the start date when no due date is set', () => {
        const setEditRecurrence = vi.fn();
        const setEditRecurrenceRRule = vi.fn();
        const { result } = renderHook(() => useTaskItemRecurrence({
            task: {
                ...baseTask,
                startTime: '2026-06-04T09:00',
            },
            editStartTime: '2026-06-04T09:00',
            editDueDate: '',
            editRecurrence: 'monthly',
            editRecurrenceRRule: '',
            setEditRecurrence,
            setEditRecurrenceRRule,
        }));

        act(() => {
            result.current.openCustomRecurrence();
        });

        expect(result.current.customMonthDay).toBe(4);
        expect(result.current.customWeekday).toBe('TH');

        act(() => {
            result.current.setCustomMode('nth');
        });
        act(() => {
            result.current.applyCustomRecurrence();
        });

        expect(setEditRecurrence).toHaveBeenCalledWith('monthly');
        expect(setEditRecurrenceRRule).toHaveBeenCalledWith('FREQ=MONTHLY;BYDAY=1TH');
    });
});
