import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';

import {
    buildDesktopTaskNotificationBody,
    resolveDesktopTaskReminderKind,
    resolveDueRepeatToFire,
} from './notification-service';

const baseTask: Task = {
    id: 'task-1',
    title: 'Prepare report',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
};

const translations = {
    'settings.startDateNotifications': 'Start date reminders',
    'settings.dueDateNotifications': 'Due date reminders',
    'settings.reviewAtNotifications': 'Review date reminders',
    'settings.notifications': 'Notifications',
};

describe('desktop notification service', () => {
    it('identifies start, due, and review task reminder kinds', () => {
        const task: Task = {
            ...baseTask,
            startTime: '2026-05-23T09:00:00.000Z',
            dueDate: '2026-05-23T17:00:00.000Z',
            reviewAt: '2026-05-24T10:00:00.000Z',
        };

        expect(resolveDesktopTaskReminderKind(task, new Date('2026-05-23T09:00:00.000Z'))).toBe('start');
        expect(resolveDesktopTaskReminderKind(task, new Date('2026-05-23T17:00:00.000Z'))).toBe('due');
        expect(resolveDesktopTaskReminderKind(task, new Date('2026-05-24T10:00:00.000Z'))).toBe('review');
    });

    it('includes the reminder type before the task description', () => {
        const task: Task = {
            ...baseTask,
            dueDate: '2026-05-23T17:00:00.000Z',
            description: '**Bring** notes',
        };

        expect(buildDesktopTaskNotificationBody(
            task,
            new Date('2026-05-23T17:00:00.000Z'),
            translations,
        )).toBe('Due date reminders\nBring notes');
    });

    it('still shows the reminder type when the task has no description', () => {
        const task: Task = {
            ...baseTask,
            startTime: '2026-05-23T09:00:00.000Z',
        };

        expect(buildDesktopTaskNotificationBody(
            task,
            new Date('2026-05-23T09:00:00.000Z'),
            translations,
        )).toBe('Start date reminders');
    });
});

describe('resolveDueRepeatToFire', () => {
    const repeatTask: Task = {
        ...baseTask,
        status: 'next',
        dueDate: '2026-06-17T09:00:00.000Z',
        repeatReminderMinutes: 10,
    };
    const opts = { includeDueDate: true };

    it('fires the occurrence just reached, within one poll window', () => {
        // due+20min occurrence (index 2), now is 5s past it -> within the 15s catch-up
        const now = new Date('2026-06-17T09:20:05.000Z');
        expect(resolveDueRepeatToFire(repeatTask, now, undefined, opts)).toEqual({
            key: '2026-06-17T09:00:00.000Z#2',
            index: 2,
        });
    });

    it('does not re-fire the same occurrence (dedup by key)', () => {
        const now = new Date('2026-06-17T09:20:05.000Z');
        expect(resolveDueRepeatToFire(repeatTask, now, '2026-06-17T09:00:00.000Z#2', opts)).toBeNull();
    });

    it('invalidates dedup when the due time changes', () => {
        const moved = { ...repeatTask, dueDate: '2026-06-17T10:00:00.000Z' };
        const now = new Date('2026-06-17T10:20:05.000Z');
        // old key was for the 09:00 dueISO; the new dueISO must still fire
        expect(resolveDueRepeatToFire(moved, now, '2026-06-17T09:00:00.000Z#2', opts)).toEqual({
            key: '2026-06-17T10:00:00.000Z#2',
            index: 2,
        });
    });

    it('returns null before the first repeat occurrence', () => {
        const now = new Date('2026-06-17T09:05:00.000Z'); // < due + 10min
        expect(resolveDueRepeatToFire(repeatTask, now, undefined, opts)).toBeNull();
    });

    it('skips an occurrence missed beyond the poll window (desktop was not polling)', () => {
        // due+10min occurrence is 30s stale (> 15s catch-up), due+20min not yet reached
        const now = new Date('2026-06-17T09:10:30.000Z');
        expect(resolveDueRepeatToFire(repeatTask, now, undefined, opts)).toBeNull();
    });

    it('returns null when due-date notifications are disabled', () => {
        const now = new Date('2026-06-17T09:20:05.000Z');
        expect(resolveDueRepeatToFire(repeatTask, now, undefined, { includeDueDate: false })).toBeNull();
    });
});
