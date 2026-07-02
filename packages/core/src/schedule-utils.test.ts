import { describe, expect, it } from 'vitest';

import {
    getDueReminderRepeatTimes,
    getNextScheduledAt,
    normalizeRepeatReminderMinutes,
    REPEAT_REMINDER_INTERVAL_OPTIONS,
} from './schedule-utils';
import type { Task } from './types';

const buildTask = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Reminder',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-16T12:00:00.000Z',
    updatedAt: '2026-03-16T12:00:00.000Z',
    ...overrides,
});

describe('schedule-utils', () => {
    it('skips date-only start reminders', () => {
        const task = buildTask({ startTime: '2026-03-17' });
        const now = new Date(2026, 2, 16, 20, 0, 0, 0);

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('skips date-only due reminders', () => {
        const task = buildTask({ dueDate: '2026-03-17' });
        const now = new Date(2026, 2, 16, 20, 0, 0, 0);

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('keeps explicit start times unchanged', () => {
        const task = buildTask({ startTime: '2026-03-17T14:30:00.000Z' });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now);

        expect(next?.toISOString()).toBe('2026-03-17T14:30:00.000Z');
    });

    it('can ignore start reminders while keeping due reminders', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-18T09:00:00.000Z',
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now, { includeStartTime: false });

        expect(next?.toISOString()).toBe('2026-03-18T09:00:00.000Z');
    });

    it('can ignore due reminders while keeping start reminders', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-16T14:00:00.000Z',
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now, { includeDueDate: false });

        expect(next?.toISOString()).toBe('2026-03-17T14:30:00.000Z');
    });

    it('suppresses task start and due reminders when calendar handoff is enabled', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-18T09:00:00.000Z',
            suppressMindwtrReminders: true,
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now);

        expect(next).toBeNull();
    });

    it('keeps review reminders when task reminders are handed off to calendar', () => {
        const task = buildTask({
            startTime: '2026-03-17T14:30:00.000Z',
            dueDate: '2026-03-18T09:00:00.000Z',
            reviewAt: '2026-03-19T10:00:00.000Z',
            suppressMindwtrReminders: true,
        });
        const now = new Date('2026-03-16T12:00:00.000Z');

        const next = getNextScheduledAt(task, now, { includeReviewAt: true });

        expect(next?.toISOString()).toBe('2026-03-19T10:00:00.000Z');
    });
});

describe('normalizeRepeatReminderMinutes', () => {
    it('accepts the allowed presets', () => {
        for (const n of REPEAT_REMINDER_INTERVAL_OPTIONS) {
            expect(normalizeRepeatReminderMinutes(n)).toBe(n);
        }
    });

    it('rejects non-presets, junk, and falsy values', () => {
        for (const bad of [0, 1, 7, 45, 61, -5, NaN, '10', null, undefined, {}]) {
            expect(normalizeRepeatReminderMinutes(bad)).toBeUndefined();
        }
    });
});

describe('getDueReminderRepeatTimes', () => {
    const dueTask = (overrides: Partial<Task> = {}): Task =>
        buildTask({
            status: 'next',
            dueDate: '2026-06-17T09:00:00.000Z',
            repeatReminderMinutes: 10,
            ...overrides,
        });
    const dueMs = new Date('2026-06-17T09:00:00.000Z').getTime();

    it('returns [] when no repeat interval set', () => {
        expect(getDueReminderRepeatTimes(dueTask({ repeatReminderMinutes: undefined }))).toEqual([]);
    });

    it('returns [] for a date-only due date', () => {
        expect(getDueReminderRepeatTimes(dueTask({ dueDate: '2026-06-17' }))).toEqual([]);
    });

    it('returns [] when reminders are suppressed', () => {
        expect(getDueReminderRepeatTimes(dueTask({ suppressMindwtrReminders: true }))).toEqual([]);
    });

    it('returns [] when due-date notifications are disabled via options', () => {
        expect(getDueReminderRepeatTimes(dueTask(), { includeDueDate: false })).toEqual([]);
    });

    it.each(['done', 'archived', 'reference'] as const)('returns [] for %s tasks', (status) => {
        expect(getDueReminderRepeatTimes(dueTask({ status }))).toEqual([]);
    });

    it('returns [] for soft-deleted tasks', () => {
        expect(getDueReminderRepeatTimes(dueTask({ deletedAt: '2026-06-17T01:00:00.000Z' }))).toEqual([]);
    });

    it('caps by occurrence ceiling for short intervals (5min -> 8 occurrences over 40min)', () => {
        const times = getDueReminderRepeatTimes(dueTask({ repeatReminderMinutes: 5 }));
        expect(times).toHaveLength(8);
        expect(times[0].getTime()).toBe(dueMs + 5 * 60_000); // index 1, not the due moment
        expect(times[7].getTime()).toBe(dueMs + 40 * 60_000);
    });

    it('caps by window for long intervals (60min -> 2 occurrences over 120min)', () => {
        const times = getDueReminderRepeatTimes(dueTask({ repeatReminderMinutes: 60 }));
        expect(times.map((d) => d.getTime() - dueMs)).toEqual([60 * 60_000, 120 * 60_000]);
    });
});
