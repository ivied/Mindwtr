import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';

import {
  buildTimedCalendarLayouts,
  buildScheduledTasksByDate,
  calendarDateKey,
  isAllDayScheduledTask,
  isTimedScheduledTask,
} from './calendar-task-items';

const task = (overrides: Partial<Task>): Task => ({
  id: overrides.id ?? 'task-1',
  title: overrides.title ?? 'Task',
  status: overrides.status ?? 'next',
  contexts: [],
  tags: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

describe('calendar task item grouping', () => {
  it('indexes date-only start dates on their local calendar day', () => {
    const dateOnly = task({ id: 'date-only', startTime: '2026-04-20' });
    const timed = task({ id: 'timed', startTime: '2026-04-20T09:00:00' });

    const grouped = buildScheduledTasksByDate([dateOnly, timed]);

    expect(grouped.get(calendarDateKey(new Date(2026, 3, 20)))?.map((item) => item.id)).toEqual([
      'date-only',
      'timed',
    ]);
    expect(isAllDayScheduledTask(dateOnly)).toBe(true);
    expect(isTimedScheduledTask(dateOnly)).toBe(false);
    expect(isTimedScheduledTask(timed)).toBe(true);
  });

  it('places same-slot timed items in separate columns', () => {
    const layouts = buildTimedCalendarLayouts([
      { id: 'long-event', startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { id: 'short-event', startMinutes: 9 * 60, endMinutes: 9 * 60 + 15 },
    ]);

    const longEvent = layouts.get('long-event');
    const shortEvent = layouts.get('short-event');

    expect(longEvent?.columnCount).toBe(2);
    expect(shortEvent?.columnCount).toBe(2);
    expect(longEvent?.widthPercent).toBeCloseTo(50);
    expect(shortEvent?.widthPercent).toBeCloseTo(50);
    expect(longEvent?.columnIndex).not.toBe(shortEvent?.columnIndex);
    expect(new Set([longEvent?.leftPercent, shortEvent?.leftPercent])).toEqual(new Set([0, 50]));
  });

  it('keeps back-to-back timed items full width', () => {
    const layouts = buildTimedCalendarLayouts([
      { id: 'morning', startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { id: 'next', startMinutes: 10 * 60, endMinutes: 11 * 60 },
    ]);

    expect(layouts.get('morning')).toMatchObject({
      columnCount: 1,
      columnIndex: 0,
      leftPercent: 0,
      widthPercent: 100,
    });
    expect(layouts.get('next')).toMatchObject({
      columnCount: 1,
      columnIndex: 0,
      leftPercent: 0,
      widthPercent: 100,
    });
  });

  it('reuses a column inside a chained overlap group', () => {
    const layouts = buildTimedCalendarLayouts([
      { id: 'a', startMinutes: 9 * 60, endMinutes: 10 * 60 },
      { id: 'b', startMinutes: 9 * 60 + 30, endMinutes: 10 * 60 + 30 },
      { id: 'c', startMinutes: 10 * 60, endMinutes: 11 * 60 },
    ]);

    expect(layouts.get('a')).toMatchObject({ columnCount: 2, columnIndex: 0 });
    expect(layouts.get('b')).toMatchObject({ columnCount: 2, columnIndex: 1 });
    expect(layouts.get('c')).toMatchObject({ columnCount: 2, columnIndex: 0 });
  });
});
