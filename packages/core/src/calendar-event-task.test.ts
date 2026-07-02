import { describe, expect, it } from 'vitest';
import type { ExternalCalendarEvent } from './ics';
import { buildCalendarEventTaskDraft } from './calendar-scheduling';

const event = (overrides: Partial<ExternalCalendarEvent>): ExternalCalendarEvent => ({
    id: 'event-1',
    sourceId: 'work',
    title: 'Planning session',
    start: '2026-04-06T13:00:00.000Z',
    end: '2026-04-06T14:15:00.000Z',
    allDay: false,
    ...overrides,
});

describe('calendar event task drafts', () => {
    it('creates a scheduled task draft from a timed calendar event', () => {
        const draft = buildCalendarEventTaskDraft(event({
            description: 'Bring roadmap notes.',
            location: 'Room 4',
        }), { calendarName: 'Work' });

        expect(draft).toEqual({
            title: 'Planning session',
            initialProps: {
                status: 'next',
                startTime: '2026-04-06T13:00:00.000Z',
                timeEstimate: 'custom:75',
                description: 'Bring roadmap notes.\n\nCalendar: Work',
                location: 'Room 4',
            },
        });
    });

    it('creates a dated task draft from an all-day calendar event', () => {
        const draft = buildCalendarEventTaskDraft(event({
            allDay: true,
            description: undefined,
            end: '2026-04-07T00:00:00.000Z',
            location: undefined,
            start: '2026-04-06T00:00:00.000Z',
            title: '',
        }));

        expect(draft).toEqual({
            title: 'Calendar event',
            initialProps: {
                status: 'next',
                dueDate: '2026-04-06',
            },
        });
    });
});
