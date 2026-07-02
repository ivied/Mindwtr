import { isAfter } from 'date-fns';
import { hasTimeComponent, safeParseDate } from './date';
import type { Task } from './types';

type ScheduleOptions = {
    includeStartTime?: boolean;
    includeDueDate?: boolean;
    includeReviewAt?: boolean;
};

export const REPEAT_REMINDER_INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;
export const REPEAT_REMINDER_MAX_WINDOW_MINUTES = 120;
export const REPEAT_REMINDER_MAX_OCCURRENCES = 8;

const REPEAT_REMINDER_INTERVAL_SET: ReadonlySet<number> = new Set(REPEAT_REMINDER_INTERVAL_OPTIONS);

/**
 * Coerce a stored repeat-reminder interval to an allowed preset, or undefined when off/invalid.
 */
export function normalizeRepeatReminderMinutes(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return REPEAT_REMINDER_INTERVAL_SET.has(value) ? value : undefined;
}

function parseExplicitReminderDate(value: string | undefined | null): Date | null {
    if (!hasTimeComponent(value ?? undefined)) {
        return null;
    }
    return safeParseDate(value ?? undefined);
}

/**
 * Returns the next future scheduled time for a task, based on startTime/dueDate.
 * Used by apps to drive local notification scheduling.
 */
export function getNextScheduledAt(task: Task, now: Date = new Date(), options: ScheduleOptions = {}): Date | null {
    if (task.deletedAt) return null;
    if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return null;

    const candidates: Date[] = [];
    const includeTaskReminders = task.suppressMindwtrReminders !== true;
    const includeStartTime = includeTaskReminders && options.includeStartTime !== false;
    const includeDueDate = includeTaskReminders && options.includeDueDate !== false;
    const start = includeStartTime ? parseExplicitReminderDate(task.startTime) : null;
    const due = includeDueDate ? parseExplicitReminderDate(task.dueDate) : null;
    const review = options.includeReviewAt ? parseExplicitReminderDate(task.reviewAt) : null;

    if (start && isAfter(start, now)) candidates.push(start);
    if (due && isAfter(due, now)) candidates.push(due);
    if (review && isAfter(review, now)) candidates.push(review);

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0];
}

/**
 * Returns the bounded repeat-reminder occurrence times for a task's due time.
 *
 * Repeats anchor on the explicit due *time* only and start at index 1 (`due + N`); the due moment
 * itself stays the task's single due reminder, so callers never double-fire. Returns `[]` when the
 * task is inactive, has no explicit due time, suppresses reminders, has due reminders disabled, or
 * has no valid repeat interval. The occurrence count is bounded by both a window and a hard ceiling:
 * `min(REPEAT_REMINDER_MAX_OCCURRENCES, floor(REPEAT_REMINDER_MAX_WINDOW_MINUTES / interval))`.
 *
 * Pure: callers filter by `now` for delivery.
 */
export function getDueReminderRepeatTimes(task: Task, options: ScheduleOptions = {}): Date[] {
    if (task.deletedAt) return [];
    if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return [];
    if (task.suppressMindwtrReminders === true) return [];
    if (options.includeDueDate === false) return [];

    const interval = normalizeRepeatReminderMinutes(task.repeatReminderMinutes);
    if (!interval) return [];

    const due = parseExplicitReminderDate(task.dueDate);
    if (!due) return [];

    const count = Math.min(
        REPEAT_REMINDER_MAX_OCCURRENCES,
        Math.floor(REPEAT_REMINDER_MAX_WINDOW_MINUTES / interval),
    );
    const times: Date[] = [];
    for (let i = 1; i <= count; i += 1) {
        times.push(new Date(due.getTime() + i * interval * 60_000));
    }
    return times;
}

export function getUpcomingSchedules(tasks: Task[], now: Date = new Date(), options: ScheduleOptions = {}) {
    return tasks
        .map((task) => {
            const scheduledAt = getNextScheduledAt(task, now, options);
            return scheduledAt ? { task, scheduledAt } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (a!.scheduledAt.getTime() - b!.scheduledAt.getTime()));
}

export function isDueWithinMinutes(task: Task, minutes: number, now: Date = new Date(), options: ScheduleOptions = {}): boolean {
    const next = getNextScheduledAt(task, now, options);
    if (!next) return false;
    const diffMs = next.getTime() - now.getTime();
    return diffMs >= 0 && diffMs <= minutes * 60 * 1000;
}

export function parseTimeOfDay(value: string | undefined, fallback: { hour: number; minute: number }) {
    if (!value) return fallback;
    const [h, m] = value.split(':');
    const hour = Number.parseInt(h, 10);
    const minute = Number.parseInt(m, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
    if (hour < 0 || hour > 23) return fallback;
    if (minute < 0 || minute > 59) return fallback;
    return { hour, minute };
}
