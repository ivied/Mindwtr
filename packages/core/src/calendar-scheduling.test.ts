import { describe, expect, it } from 'vitest';

import {
    addCalendarMinutes,
    findFreeSlotForDay,
    formatCalendarDurationLabel,
    formatCalendarTimeInputValue,
    isSlotFreeForDay,
    minutesToTimeEstimate,
    normalizeCalendarDurationMinutes,
    parseCalendarTimeOnDate,
    timeEstimateToMinutes,
} from './calendar-scheduling';
import type { ExternalCalendarEvent, Task } from './index';

const task = (overrides: Partial<Task>): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
    ...overrides,
});

const event = (overrides: Partial<ExternalCalendarEvent>): ExternalCalendarEvent => ({
    id: 'event-1',
    sourceId: 'work',
    title: 'Event',
    start: '2026-04-26T09:00:00.000Z',
    end: '2026-04-26T10:00:00.000Z',
    allDay: false,
    ...overrides,
});

describe('calendar scheduling helpers', () => {
    it('maps Mindwtr time estimates to calendar minutes', () => {
        expect(timeEstimateToMinutes('5min')).toBe(5);
        expect(timeEstimateToMinutes('1hr')).toBe(60);
        expect(timeEstimateToMinutes('4hr+')).toBe(240);
        expect(timeEstimateToMinutes(undefined)).toBe(30);
        expect(timeEstimateToMinutes('2hr', { enabled: false })).toBe(30);
    });

    it('maps calendar minutes back to Mindwtr time estimates', () => {
        expect(minutesToTimeEstimate(15)).toBe('15min');
        expect(minutesToTimeEstimate(45)).toBe('1hr');
        expect(minutesToTimeEstimate(241)).toBe('4hr+');
    });

    it('normalizes arbitrary calendar durations to supported estimate buckets', () => {
        expect(normalizeCalendarDurationMinutes(44)).toBe(60);
        expect(normalizeCalendarDurationMinutes(241)).toBe(240);
    });

    it('formats and parses calendar time inputs on a given day', () => {
        const base = new Date(2026, 3, 26, 8, 5);
        expect(formatCalendarTimeInputValue(base)).toBe('08:05');
        expect(addCalendarMinutes(base, 35).getHours()).toBe(8);
        expect(addCalendarMinutes(base, 35).getMinutes()).toBe(40);

        const parsed = parseCalendarTimeOnDate(base, '9:30');
        expect(parsed?.getFullYear()).toBe(2026);
        expect(parsed?.getHours()).toBe(9);
        expect(parsed?.getMinutes()).toBe(30);
        expect(parseCalendarTimeOnDate(base, '9:30 AM')?.getHours()).toBe(9);
        expect(parseCalendarTimeOnDate(base, '9 PM')?.getHours()).toBe(21);
        expect(parseCalendarTimeOnDate(base, '12:15 am')?.getHours()).toBe(0);
        expect(parseCalendarTimeOnDate(base, '12:15 pm')?.getHours()).toBe(12);
        expect(parseCalendarTimeOnDate(base, '24:00')).toBeNull();
        expect(parseCalendarTimeOnDate(base, '13:00 PM')).toBeNull();
    });

    it('formats duration labels', () => {
        expect(formatCalendarDurationLabel(30)).toBe('30m');
        expect(formatCalendarDurationLabel(90)).toBe('1.5h');
        expect(formatCalendarDurationLabel(120)).toBe('2h');
    });

    it('finds the first open slot around external events and scheduled tasks', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T09:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [
                task({
                    id: 'task-2',
                    startTime: '2026-04-26T09:00:00',
                    timeEstimate: '30min',
                }),
            ],
        });

        expect(slot?.getHours()).toBe(9);
        expect(slot?.getMinutes()).toBe(30);
    });

    it('clamps timed external events that started before the selected day', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-25T22:00:00',
                    end: '2026-04-26T08:45:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(45);
    });

    it('returns null when external events fill the available workday', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            dayEndHour: 10,
            dayStartHour: 8,
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T10:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot).toBeNull();
    });

    it('ignores all-day external events for free-slot detection', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    allDay: true,
                    start: '2026-04-26T00:00:00',
                    end: '2026-04-27T00:00:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(0);
    });

    it('ignores date-only task starts for free-slot detection', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            now: new Date(2026, 3, 25, 12, 0),
            tasks: [
                task({
                    id: 'task-date-only',
                    startTime: '2026-04-26',
                    timeEstimate: '4hr',
                }),
            ],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(0);
    });

    it('rounds today slots forward to the configured snap interval', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            now: new Date(2026, 3, 26, 8, 7),
            tasks: [],
        });

        expect(slot?.getHours()).toBe(8);
        expect(slot?.getMinutes()).toBe(10);
    });

    it('rounds free slots after busy intervals forward to the configured snap interval', () => {
        const slot = findFreeSlotForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T08:00:00',
                    end: '2026-04-26T10:07:00',
                }),
            ],
            now: new Date(2026, 3, 25, 12, 0),
            snapMinutes: 15,
            tasks: [],
        });

        expect(slot?.getHours()).toBe(10);
        expect(slot?.getMinutes()).toBe(15);
    });

    it('checks candidate slots against blocking intervals', () => {
        const base = {
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [
                event({
                    start: '2026-04-26T10:00:00',
                    end: '2026-04-26T11:00:00',
                }),
            ],
            tasks: [],
        };

        expect(isSlotFreeForDay({
            ...base,
            startTime: new Date(2026, 3, 26, 9, 30),
        })).toBe(true);
        expect(isSlotFreeForDay({
            ...base,
            startTime: new Date(2026, 3, 26, 10, 30),
        })).toBe(false);
    });

    it('allows slots outside the visible calendar window when they do not overlap', () => {
        expect(isSlotFreeForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 6, 30),
            tasks: [],
        })).toBe(true);
    });

    it('excludes the task being edited from slot collision checks', () => {
        const base = {
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 10, 0),
            tasks: [
                task({
                    id: 'task-1',
                    startTime: '2026-04-26T10:00:00',
                    timeEstimate: '30min',
                }),
            ],
        };

        expect(isSlotFreeForDay(base)).toBe(false);
        expect(isSlotFreeForDay({ ...base, excludeTaskId: 'task-1' })).toBe(true);
    });

    it('does not treat date-only task starts as timed collisions', () => {
        expect(isSlotFreeForDay({
            day: new Date(2026, 3, 26),
            durationMinutes: 30,
            events: [],
            startTime: new Date(2026, 3, 26, 8, 0),
            tasks: [
                task({
                    id: 'task-date-only',
                    startTime: '2026-04-26',
                    timeEstimate: '4hr',
                }),
            ],
        })).toBe(true);
    });
});
