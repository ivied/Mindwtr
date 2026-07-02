import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
    buildRRuleString,
    parseRRuleString,
    createNextRecurringTask,
    createCurrentRecurringCalendarTask,
    expandCalendarRecurringTasks,
    createProjectedRecurringTask,
    formatRecurrenceLabel,
    getProjectedRecurringTaskCalendarDate,
    getProjectedRecurringTaskId,
    getTaskCalendarOccurrenceDate,
    isProjectedRecurringTask,
    normalizeRecurrenceForLoad,
} from './recurrence';
import type { Task, TaskStatus } from './types';

type LocalApiRecurrenceParityCase = {
    name: string;
    completedAt: string;
    previousStatus: TaskStatus;
    task: Task;
    expected: Record<string, unknown> | null;
};

const localApiRecurrenceParityCases = JSON.parse(
    readFileSync(new URL('./recurrence-local-api-parity.fixtures.json', import.meta.url), 'utf8')
) as LocalApiRecurrenceParityCase[];

const toLocalApiRecurrenceParitySnapshot = (task: Task | null): Record<string, unknown> | null => {
    if (!task) return null;
    return {
        status: task.status,
        ...(task.startTime ? { startTime: task.startTime } : {}),
        ...(task.dueDate ? { dueDate: task.dueDate } : {}),
        ...(task.reviewAt ? { reviewAt: task.reviewAt } : {}),
        ...(task.recurrence ? { recurrence: task.recurrence } : {}),
    };
};

describe('recurrence', () => {
    const t = (key: string) => ({
        'recurrence.daily': 'Daily',
        'recurrence.weekly': 'Weekly',
        'recurrence.yearly': 'Yearly',
        'recurrence.repeatEvery': 'Repeat every',
        'recurrence.dayUnit': 'day(s)',
        'recurrence.weekUnit': 'week(s)',
        'recurrence.yearUnit': 'year(s)',
        'recurrence.endsAfterCount': 'After',
        'recurrence.endsOnDate': 'On date',
        'recurrence.occurrenceUnit': 'occurrence(s)',
        'recurrence.afterCompletionShort': 'after completion',
    }[key] ?? key);

    it('formats daily recurrence intervals for display', () => {
        const label = formatRecurrenceLabel({
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=3' },
            t,
        });

        expect(label).toBe('Daily · Repeat every 3 day(s)');
    });

    it('formats long weekly and yearly recurrence intervals for display', () => {
        expect(formatRecurrenceLabel({
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=78' },
            t,
        })).toBe('Weekly · Repeat every 78 week(s)');

        expect(formatRecurrenceLabel({
            recurrence: { rule: 'yearly', rrule: 'FREQ=YEARLY;INTERVAL=2' },
            t,
        })).toBe('Yearly · Repeat every 2 year(s)');
    });

    it('formats recurrence end metadata for display', () => {
        const label = formatRecurrenceLabel({
            recurrence: { rule: 'weekly', strategy: 'fluid', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4' },
            t,
        });

        expect(label).toBe('Weekly · after completion · Repeat every 2 week(s) · After 4 occurrence(s)');
    });

    it('builds and parses weekly BYDAY rules', () => {
        const rrule = buildRRuleString('weekly', ['WE', 'MO']);
        expect(rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');

        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('weekly');
        expect(parsed.byDay).toEqual(['MO', 'WE']);
    });

    it('parses and preserves weekly WKST rules', () => {
        const parsed = parseRRuleString('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU');
        expect(parsed.weekStart).toBe('SU');

        const rrule = buildRRuleString('weekly', ['TU', 'TH'], 2, { weekStart: 'SU' });
        expect(rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU');
    });

    it('builds and parses count and until options', () => {
        const rrule = buildRRuleString('monthly', undefined, 2, {
            byMonthDay: [15],
            count: 4,
            until: '2025-06-15',
        });
        expect(rrule).toBe('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15;COUNT=4;UNTIL=20250615');

        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('monthly');
        expect(parsed.interval).toBe(2);
        expect(parsed.byMonthDay).toEqual([15]);
        expect(parsed.count).toBe(4);
        expect(parsed.until).toBe('2025-06-15');
    });

    it('builds and parses yearly interval rules', () => {
        const rrule = buildRRuleString('yearly', undefined, 2);
        expect(rrule).toBe('FREQ=YEARLY;INTERVAL=2');

        const parsed = parseRRuleString(rrule);
        expect(parsed.rule).toBe('yearly');
        expect(parsed.interval).toBe(2);
    });

    it('normalizes legacy recurrence values to object form', () => {
        expect(normalizeRecurrenceForLoad('daily')).toEqual({ rule: 'daily' });
        expect(normalizeRecurrenceForLoad('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')).toEqual({
            rule: 'weekly',
            byDay: ['MO', 'WE'],
            count: 4,
            rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
        });
        expect(normalizeRecurrenceForLoad({ rrule: 'FREQ=MONTHLY;BYDAY=1MO' })).toEqual({
            rule: 'monthly',
            byDay: ['1MO'],
            rrule: 'FREQ=MONTHLY;BYDAY=1MO',
        });
        expect(normalizeRecurrenceForLoad({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=9' })).toEqual({
            rule: 'monthly',
            byMonthDay: [9],
            rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
        });
    });

    it('creates next instance using weekly BYDAY (strict)', () => {
        const task: Task = {
            id: 't1',
            title: 'Laundry',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-06T10:00:00.000Z', // Monday
            recurrence: { rule: 'weekly', byDay: ['MO', 'WE'], strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-06T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-08T10:00:00.000Z'); // Wednesday
        expect(next?.status).toBe('next');
    });

    it('preserves text direction on the next recurring task', () => {
        const task: Task = {
            id: 't1-rtl',
            title: 'RTL reading',
            status: 'done',
            tags: [],
            contexts: [],
            textDirection: 'rtl',
            dueDate: '2025-01-06T10:00:00.000Z',
            recurrence: { rule: 'daily' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-06T12:00:00.000Z', 'done');

        expect(next?.textDirection).toBe('rtl');
    });

    it('uses completion date for fluid recurrence', () => {
        const task: Task = {
            id: 't2',
            title: 'Meditate',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'fluid' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-06T14:00:00.000Z');
    });

    it('advances date-only start dates for fluid recurrence', () => {
        const task: Task = {
            id: 't2-start-fluid-date',
            title: 'Weekly planning',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2026-06-01',
            recurrence: { rule: 'weekly', strategy: 'fluid' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2026-06-12T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2026-06-19');
        expect(next?.dueDate).toBeUndefined();
    });

    it('keeps the advanced start date when switching a strict follow-up to fluid', () => {
        const original: Task = {
            id: 't2-start-strict-to-fluid',
            title: 'Weekly reset',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2026-06-01',
            recurrence: { rule: 'weekly', strategy: 'strict' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const strictNext = createNextRecurringTask(original, '2026-06-01T12:00:00.000Z', 'done') as Task;
        const fluidTask: Task = {
            ...strictNext,
            recurrence: { rule: 'weekly', strategy: 'fluid' },
        };

        const next = createNextRecurringTask(fluidTask, '2026-06-12T12:00:00.000Z', 'next');
        expect(strictNext.startTime).toBe('2026-06-08');
        expect(next?.startTime).toBe('2026-06-19');
    });

    it('keeps dueDate unset for startTime-only recurring tasks', () => {
        const task: Task = {
            id: 't2-start-only',
            title: 'Read a book',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2025-01-02T09:00:00.000Z');
        expect(next?.dueDate).toBeUndefined();
    });

    it('carries startTime and dueDate forward for yearly strict recurrence', () => {
        const task: Task = {
            id: 't2-yearly-window',
            title: 'Annual enrollment reminder',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2027-03-01T09:00:00.000Z',
            dueDate: '2027-04-01T09:00:00.000Z',
            recurrence: { rule: 'yearly', strategy: 'strict' },
            createdAt: '2027-01-01T00:00:00.000Z',
            updatedAt: '2027-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2027-04-01T12:00:00.000Z', 'done');
        expect(next?.startTime).toBe('2028-03-01T09:00:00.000Z');
        expect(next?.dueDate).toBe('2028-04-01T09:00:00.000Z');
        expect(next?.status).toBe('next');
    });

    it('carries recurrence task metadata into the next instance', () => {
        const task: Task = {
            id: 't2-field-carry',
            title: 'Renew prescription',
            status: 'done',
            tags: [],
            contexts: [],
            taskMode: 'list',
            checklist: [{ id: 'c1', title: 'Call pharmacy', isCompleted: true }],
            startTime: '2025-01-09T09:00:00.000Z',
            relativeStartOffset: { amount: -1, unit: 'day' },
            dueDate: '2025-01-10T09:00:00.000Z',
            repeatReminderMinutes: 30,
            recurrence: { rule: 'weekly', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-10T12:00:00.000Z', 'done');

        expect(next?.taskMode).toBe('list');
        expect(next?.relativeStartOffset).toEqual({ amount: -1, unit: 'day' });
        expect(next?.repeatReminderMinutes).toBe(30);
        expect(next?.startTime).toBe('2025-01-16T09:00:00.000Z');
        expect(next?.dueDate).toBe('2025-01-17T09:00:00.000Z');
        expect(next?.checklist).toHaveLength(1);
        expect(next?.checklist?.[0]).toMatchObject({ title: 'Call pharmacy', isCompleted: false });
        expect(next?.checklist?.[0]?.id).not.toBe('c1');
    });

    it('regenerates relative start dates from the next due date across month clamps', () => {
        const task: Task = {
            id: 't2-relative-start-month-clamp',
            title: 'Month-end close prep',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2025-01-30',
            relativeStartOffset: { amount: -1, unit: 'day' },
            dueDate: '2025-01-31',
            recurrence: { rule: 'monthly', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2025-02-28');
        expect(next?.startTime).toBe('2025-02-27');
        expect(next?.relativeStartOffset).toEqual({ amount: -1, unit: 'day' });
    });

    it('respects daily interval for strict recurrence', () => {
        const task: Task = {
            id: 't2b',
            title: 'Water plants',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-04T09:00:00.000Z');
        expect(next?.startTime).toBeUndefined();
    });

    it('respects daily interval for fluid recurrence', () => {
        const task: Task = {
            id: 't2c',
            title: 'Stretching',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'daily', strategy: 'fluid', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-08T14:00:00.000Z');
        expect(next?.startTime).toBeUndefined();
    });

    it('uses completion date for fluid weekly BYDAY recurrence', () => {
        const task: Task = {
            id: 't2c-weekly-byday-fluid',
            title: 'Strength training',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-06T09:00:00.000Z',
            recurrence: {
                rule: 'weekly',
                strategy: 'fluid',
                rrule: 'FREQ=WEEKLY;BYDAY=MO,WE',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-10T14:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2025-01-13T14:00:00.000Z');
        expect(next?.startTime).toBeUndefined();
    });

    it('defers unscheduled fluid recurrence from completion date', () => {
        const task: Task = {
            id: 't2d',
            title: 'Unscheduled recurring task',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: { rule: 'daily', strategy: 'fluid', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T14:00:00.000Z', 'next');
        expect(next?.dueDate).toBeUndefined();
        expect(next?.startTime).toBe('2025-01-08T14:00:00.000Z');
        expect(next?.status).toBe('next');
    });

    it('falls back to weekly interval when BYDAY is empty', () => {
        const task: Task = {
            id: 't4',
            title: 'Weekly check-in',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-06T10:00:00.000Z', // Monday
            recurrence: { rule: 'weekly', byDay: [], strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-06T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-13T10:00:00.000Z');
    });

    it('respects weekly interval when BYDAY is provided', () => {
        const task: Task = {
            id: 't5',
            title: 'Biweekly sync',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-08T10:00:00.000Z', // Wednesday
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-08T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-20T10:00:00.000Z'); // Monday two weeks later
    });

    it('uses Monday as the default weekly interval anchor per RFC 5545', () => {
        const task: Task = {
            id: 't5-rfc-week-start',
            title: 'Every other Tue/Thu',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-05T10:00:00.000Z', // Sunday
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-14T10:00:00.000Z');
    });

    it('honors explicit weekly WKST when interval is greater than 1', () => {
        const task: Task = {
            id: 't5-wkst',
            title: 'Every other Tue/Thu with Sunday week start',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-05T10:00:00.000Z', // Sunday
            recurrence: { rule: 'weekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-05T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-07T10:00:00.000Z');
        expect(typeof next?.recurrence === 'object' ? next.recurrence.rrule : undefined).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;WKST=SU');
    });

    it('advances startTime by monthly BYDAY interval when interval is greater than 1', () => {
        const task: Task = {
            id: 't5b',
            title: 'Every two months on 2nd Thursday',
            status: 'done',
            tags: [],
            contexts: [],
            startTime: '2025-01-01',
            dueDate: '2025-01-09',
            recurrence: { rule: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=2TH', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-09T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-03-13');
        expect(next?.startTime).toBe('2025-03-13');
    });

    it('uses current month for monthly BYDAY and preserves time', () => {
        const task: Task = {
            id: 't6',
            title: 'First Monday',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: { rule: 'monthly', byDay: ['1MO'], strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-06T09:00:00.000Z');
    });

    it('checks the current month for monthly BYDAY rules with interval greater than 1', () => {
        const task: Task = {
            id: 't6-interval-current-month',
            title: 'Third Monday every two months',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-10T09:00:00.000Z',
            recurrence: { rule: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=2;BYDAY=3MO', strategy: 'strict' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-10T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-20T09:00:00.000Z');
    });

    it('stops generating tasks after the configured count', () => {
        const task: Task = {
            id: 't6-count',
            title: 'Three-time reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 3,
                completedOccurrences: 1,
                rrule: 'FREQ=DAILY;COUNT=3',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-02T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-02');
        expect(next?.recurrence).toMatchObject({
            count: 3,
            completedOccurrences: 2,
            rrule: 'FREQ=DAILY;COUNT=3',
        });

        const final = createNextRecurringTask(next as Task, '2025-01-03T12:00:00.000Z', 'done');
        expect(final).toBeNull();
    });

    it('treats RRULE COUNT without completedOccurrences as a total series count', () => {
        const task: Task = {
            id: 't6-rrule-count-unseeded',
            title: 'Two-time reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                rrule: 'FREQ=DAILY;COUNT=2',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-02');
        expect(next?.recurrence).toMatchObject({
            count: 2,
            completedOccurrences: 1,
            rrule: 'FREQ=DAILY;COUNT=2',
        });

        const final = createNextRecurringTask(next as Task, '2025-01-02T12:00:00.000Z', 'done');
        expect(final).toBeNull();
    });

    it('stops generating tasks after the until date', () => {
        const task: Task = {
            id: 't6-until',
            title: 'Temporary habit',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-02',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                until: '2025-01-03',
                rrule: 'FREQ=DAILY;UNTIL=20250103',
            },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-02T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-01-03');

        const final = createNextRecurringTask(next as Task, '2025-01-03T12:00:00.000Z', 'done');
        expect(final).toBeNull();
    });

    it('preserves date-only format for next occurrence', () => {
        const task: Task = {
            id: 't3',
            title: 'Monthly bill',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-02-01',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-02-01T08:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-03-01');
    });

    it('clamps monthly recurrence to the last day of the month', () => {
        const task: Task = {
            id: 't7',
            title: 'Month end report',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-31',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-02-28');
    });

    it('preserves the monthly anchor day across clamped hops', () => {
        const task: Task = {
            id: 't7-anchor',
            title: 'Month end report',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-31',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const february = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done') as Task;
        const march = createNextRecurringTask(february, '2025-02-28T12:00:00.000Z', 'done');

        expect(february.dueDate).toBe('2025-02-28');
        expect(march?.dueDate).toBe('2025-03-31');
    });

    it('preserves the quarterly anchor day across clamped hops', () => {
        const task: Task = {
            id: 't7-quarterly',
            title: 'Quarter close',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-31',
            recurrence: { rule: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=3' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const april = createNextRecurringTask(task, '2025-01-31T12:00:00.000Z', 'done') as Task;
        const july = createNextRecurringTask(april, '2025-04-30T12:00:00.000Z', 'done');

        expect(april.dueDate).toBe('2025-04-30');
        expect(july?.dueDate).toBe('2025-07-31');
    });

    it('carries yearly recurrence forward by the RRULE interval', () => {
        const task: Task = {
            id: 't7-biennial',
            title: 'Biennial renewal',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-06-15',
            recurrence: { rule: 'yearly', rrule: 'FREQ=YEARLY;INTERVAL=2' },
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-06-15T12:00:00.000Z', 'done');

        expect(next?.dueDate).toBe('2027-06-15');
        expect(next?.recurrence).toMatchObject({
            rule: 'yearly',
            rrule: 'FREQ=YEARLY;INTERVAL=2',
        });
    });

    it('clamps yearly recurrence for leap-day tasks', () => {
        const task: Task = {
            id: 't8',
            title: 'Leap day reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-02-29',
            recurrence: 'yearly',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2024-02-29T12:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2025-02-28');
    });

    it('preserves leap-day yearly anchors across non-leap years', () => {
        const task: Task = {
            id: 't8-anchor',
            title: 'Leap day reminder',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-02-29',
            recurrence: 'yearly',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
        };

        const year2025 = createNextRecurringTask(task, '2024-02-29T12:00:00.000Z', 'done') as Task;
        const year2026 = createNextRecurringTask(year2025, '2025-02-28T12:00:00.000Z', 'done') as Task;
        const year2027 = createNextRecurringTask(year2026, '2026-02-28T12:00:00.000Z', 'done') as Task;
        const year2028 = createNextRecurringTask(year2027, '2027-02-28T12:00:00.000Z', 'done');

        expect(year2028?.dueDate).toBe('2028-02-29');
    });

    it('preserves local time across a DST boundary (spring forward)', () => {
        const task: Task = {
            id: 't9',
            title: 'Morning check-in',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-03-09T09:30',
            recurrence: 'daily',
            createdAt: '2024-03-01T00:00:00.000Z',
            updatedAt: '2024-03-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2024-03-09T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2024-03-10T09:30');
    });

    it('preserves local time across a DST boundary (fall back)', () => {
        const task: Task = {
            id: 't10',
            title: 'Morning check-in',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2024-11-02T09:30',
            recurrence: 'daily',
            createdAt: '2024-10-01T00:00:00.000Z',
            updatedAt: '2024-10-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2024-11-02T10:00:00.000Z', 'done');
        expect(next?.dueDate).toBe('2024-11-03T09:30');
    });

    it('keeps section assignment for recurring project tasks', () => {
        const task: Task = {
            id: 't11',
            title: 'Section recurring',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: 'daily',
            projectId: 'project-1',
            sectionId: 'section-1',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T10:00:00.000Z', 'done');
        expect(next?.projectId).toBe('project-1');
        expect(next?.sectionId).toBe('section-1');
    });

    it('keeps area assignment for recurring area tasks', () => {
        const task: Task = {
            id: 't12',
            title: 'Area recurring',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: 'daily',
            areaId: 'area-1',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T10:00:00.000Z', 'done');
        expect(next?.areaId).toBe('area-1');
    });

    it('projects the next future strict recurrence without creating a real task', () => {
        const task: Task = {
            id: 't-projected-monthly',
            title: 'Monthly bill',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: 'monthly',
            showFutureRecurrence: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2025-05-27T12:00:00.000Z');

        expect(projected?.id).toBe(getProjectedRecurringTaskId(task.id));
        expect(projected?.sourceTaskId).toBe(task.id);
        expect(isProjectedRecurringTask(projected)).toBe(true);
        expect(projected?.dueDate).toBe('2025-06-01');
        expect(projected?.createdAt).toBe(task.createdAt);
        expect(projected?.updatedAt).toBe('2025-05-27T12:00:00.000Z');
    });

    it('returns the calendar occurrence date for calendar-visible tasks', () => {
        expect(getTaskCalendarOccurrenceDate({
            startTime: '2026-07-09T09:00',
            dueDate: '2026-07-10',
        })).toBe('2026-07-09T09:00');
        expect(getTaskCalendarOccurrenceDate({
            dueDate: '2026-07-10',
        })).toBe('2026-07-10');
        expect(getTaskCalendarOccurrenceDate({})).toBeUndefined();
    });

    it.each(localApiRecurrenceParityCases.map((testCase) => [testCase.name, testCase] as const))(
        'matches the local API recurrence parity fixture: %s',
        (_name, testCase) => {
            const next = createNextRecurringTask(testCase.task, testCase.completedAt, testCase.previousStatus);

            expect(toLocalApiRecurrenceParitySnapshot(next)).toEqual(testCase.expected);
        }
    );

    it('returns the projected calendar occurrence date for recurrence previews', () => {
        const task: Task = {
            id: 't-projected-date-label',
            title: 'Ninth day planning',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        expect(getProjectedRecurringTaskCalendarDate(task, '2026-06-05T12:00:00.000Z')).toBe('2026-07-09');
    });

    it('projects a start-only monthly nth-weekday recurrence into the calendar preview', () => {
        const task: Task = {
            id: 't-projected-first-thursday',
            title: 'First Thursday planning',
            status: 'next',
            tags: [],
            contexts: [],
            startTime: '2026-06-04T09:00',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byDay: ['1TH'],
                rrule: 'FREQ=MONTHLY;BYDAY=1TH',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-06-30T12:00:00.000Z');

        expect(projected?.startTime).toBe('2026-07-02T09:00');
        expect(projected?.dueDate).toBeUndefined();
    });

    it('projects a start-only monthly day-of-month recurrence into the calendar preview', () => {
        const task: Task = {
            id: 't-projected-ninth-day',
            title: 'Ninth day planning',
            status: 'next',
            tags: [],
            contexts: [],
            startTime: '2026-06-01T09:00',
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const projected = createProjectedRecurringTask(task, '2026-06-30T12:00:00.000Z');

        expect(projected?.startTime).toBe('2026-07-09T09:00');
        expect(projected?.dueDate).toBeUndefined();
    });

    it('expands an unscheduled monthly day-of-month recurrence into current and projected calendar tasks', () => {
        const task: Task = {
            id: 't-projected-unscheduled-ninth-day',
            title: 'Ninth day planning',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byMonthDay: [9],
                rrule: 'FREQ=MONTHLY;BYMONTHDAY=9',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const current = createCurrentRecurringCalendarTask(task, '2026-06-05T12:00:00.000Z');
        const projected = createProjectedRecurringTask(task, '2026-06-05T12:00:00.000Z');
        const expanded = expandCalendarRecurringTasks(task, '2026-06-05T12:00:00.000Z');

        expect(current?.id).toBe(task.id);
        expect(current?.startTime).toBe('2026-06-09');
        expect(isProjectedRecurringTask(current)).toBe(false);
        expect(projected?.id).toBe(getProjectedRecurringTaskId(task.id));
        expect(projected?.startTime).toBe('2026-07-09');
        expect(expanded.map((item) => ({
            id: item.id,
            projected: isProjectedRecurringTask(item),
            startTime: item.startTime,
        }))).toEqual([
            { id: task.id, projected: false, startTime: '2026-06-09' },
            { id: getProjectedRecurringTaskId(task.id), projected: true, startTime: '2026-07-09' },
        ]);
    });

    it('expands an unscheduled monthly nth-weekday recurrence into current and projected calendar tasks', () => {
        const task: Task = {
            id: 't-projected-unscheduled-third-thursday',
            title: 'Third Thursday planning',
            status: 'next',
            tags: [],
            contexts: [],
            recurrence: {
                rule: 'monthly',
                strategy: 'strict',
                byDay: ['3TH'],
                rrule: 'FREQ=MONTHLY;BYDAY=3TH',
            },
            showFutureRecurrence: true,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
        };

        const current = createCurrentRecurringCalendarTask(task, '2026-06-05T12:00:00.000Z');
        const projected = createProjectedRecurringTask(task, '2026-06-05T12:00:00.000Z');

        expect(current?.id).toBe(task.id);
        expect(current?.startTime).toBe('2026-06-18');
        expect(isProjectedRecurringTask(current)).toBe(false);
        expect(projected?.id).toBe(getProjectedRecurringTaskId(task.id));
        expect(projected?.startTime).toBe('2026-07-16');
        expect(projected?.dueDate).toBeUndefined();
    });

    it('does not project recurring tasks unless the calendar preview is enabled', () => {
        const task: Task = {
            id: 't-projected-disabled',
            title: 'Monthly bill',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: 'monthly',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        expect(createProjectedRecurringTask(task, '2025-05-27T12:00:00.000Z')).toBeNull();
    });

    it('does not project past the configured recurrence count', () => {
        const task: Task = {
            id: 't-projected-count',
            title: 'Three-time reminder',
            status: 'next',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: {
                rule: 'daily',
                strategy: 'strict',
                count: 3,
                completedOccurrences: 0,
                rrule: 'FREQ=DAILY;COUNT=3',
            },
            showFutureRecurrence: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        expect(createProjectedRecurringTask(task, '2025-01-04T12:00:00.000Z')).toBeNull();
    });

    it('carries the calendar projection setting to the next real recurrence', () => {
        const task: Task = {
            id: 't-projected-carry',
            title: 'Monthly bill',
            status: 'done',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01',
            recurrence: 'monthly',
            showFutureRecurrence: true,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T12:00:00.000Z', 'done');

        expect(next?.showFutureRecurrence).toBe(true);
    });

    it('keeps priority, energy level, and assignee on recurring task instances', () => {
        const task: Task = {
            id: 't13',
            title: 'High focus recurring',
            status: 'done',
            priority: 'urgent',
            energyLevel: 'high',
            assignedTo: 'Ada',
            tags: [],
            contexts: [],
            dueDate: '2025-01-01T09:00:00.000Z',
            recurrence: 'daily',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
        };

        const next = createNextRecurringTask(task, '2025-01-01T10:00:00.000Z', 'done');
        expect(next?.priority).toBe('urgent');
        expect(next?.energyLevel).toBe('high');
        expect(next?.assignedTo).toBe('Ada');
    });
});
