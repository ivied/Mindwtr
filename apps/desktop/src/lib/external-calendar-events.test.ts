import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCalendarsMock = vi.hoisted(() => vi.fn());
const fetchSystemCalendarEventsMock = vi.hoisted(() => vi.fn());
const isTauriRuntimeMock = vi.hoisted(() => vi.fn(() => false));
const readTextFileMock = vi.hoisted(() => vi.fn());

vi.mock('./external-calendar-service', () => ({
    ExternalCalendarService: {
        getCalendars: getCalendarsMock,
    },
}));

vi.mock('./runtime', () => ({
    isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
    readTextFile: readTextFileMock,
}));

vi.mock('./system-calendar', () => ({
    fetchSystemCalendarEvents: fetchSystemCalendarEventsMock,
}));

const workIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:work-1',
    'SUMMARY:Team Meeting',
    'DTSTART:20260426T090000Z',
    'DTEND:20260426T100000Z',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\n');

const yearlyHolidayIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:holiday-1',
    'SUMMARY:New Years Day',
    'DTSTART;VALUE=DATE:20250101',
    'RRULE:FREQ=YEARLY;COUNT=5',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\n');

describe('external calendar events', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const { __externalCalendarEventsTestUtils } = await import('./external-calendar-events');
        __externalCalendarEventsTestUtils.clearCache();
        isTauriRuntimeMock.mockReturnValue(false);
        readTextFileMock.mockReset();
        getCalendarsMock.mockResolvedValue([]);
        fetchSystemCalendarEventsMock.mockResolvedValue({
            permission: 'unsupported',
            calendars: [],
            events: [],
        });
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url === 'https://calendar.example/work.ics') {
                return new Response(workIcs, { status: 200 });
            }
            return new Response(workIcs, { status: 200 });
        }));
    });

    it('skips subscribed Mindwtr mirror calendars by default', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
        getCalendarsMock.mockResolvedValue([
            { id: 'mirror', name: 'Mindwtr', url: 'https://calendar.example/mindwtr.ics', enabled: true },
            { id: 'work', name: 'Work', url: 'https://calendar.example/work.ics', enabled: true },
        ]);

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('https://calendar.example/work.ics', expect.anything());
        expect(result.calendars.map((calendar) => calendar.id)).toEqual(['work']);
        expect(result.events.map((event) => event.title)).toEqual(['Team Meeting']);
    });

    it('caches subscribed ICS calendars by month for adjacent visible ranges', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
        getCalendarsMock.mockResolvedValue([
            { id: 'work', name: 'Work', url: 'https://calendar.example/work.ics', enabled: true },
        ]);

        await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );
        await fetchExternalCalendarEvents(
            new Date('2026-04-27T00:00:00.000Z'),
            new Date('2026-04-28T00:00:00.000Z'),
        );

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('loads yearly recurring subscribed ICS events in the visible desktop range', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
        getCalendarsMock.mockResolvedValue([
            { id: 'holiday', name: 'US Holidays', url: 'https://calendar.example/holidays.ics', enabled: true },
        ]);
        vi.mocked(fetch).mockResolvedValue(new Response(yearlyHolidayIcs, { status: 200 }));

        const result = await fetchExternalCalendarEvents(
            new Date('2026-01-01T00:00:00.000Z'),
            new Date('2026-01-02T00:00:00.000Z'),
        );

        expect(result.warnings).toEqual([]);
        expect(result.events.map((event) => event.title)).toEqual(['New Years Day']);
        expect(result.events[0].start.slice(0, 10)).toBe('2026-01-01');
    });

    it('loads local ICS calendar files through the desktop filesystem API', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
        isTauriRuntimeMock.mockReturnValue(true);
        readTextFileMock.mockResolvedValue(workIcs);
        getCalendarsMock.mockResolvedValue([
            { id: 'local-work', name: 'Local Work', url: 'file:///home/user/agenda.ics', enabled: true },
        ]);

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(readTextFileMock).toHaveBeenCalledWith('file:///home/user/agenda.ics');
        expect(fetch).not.toHaveBeenCalled();
        expect(result.warnings).toEqual([]);
        expect(result.events.map((event) => event.title)).toEqual(['Team Meeting']);
    });

    it('filters system Mindwtr mirror calendars and prefixed pushed events', async () => {
        const { fetchExternalCalendarEvents } = await import('./external-calendar-events');
        fetchSystemCalendarEventsMock.mockResolvedValue({
            permission: 'granted',
            calendars: [
                { id: 'system:mindwtr', name: 'Mindwtr', url: 'system://mindwtr', enabled: true },
                { id: 'system:personal', name: 'Personal', url: 'system://personal', enabled: true },
            ],
            events: [
                {
                    id: 'system:mindwtr:event-1:2026-04-26T09:00:00.000Z',
                    sourceId: 'system:mindwtr',
                    title: 'Write release notes',
                    start: '2026-04-26T09:00:00.000Z',
                    end: '2026-04-26T09:30:00.000Z',
                    allDay: false,
                },
                {
                    id: 'system:personal:event-2:2026-04-26T10:00:00.000Z',
                    sourceId: 'system:personal',
                    title: 'Mindwtr: Schedule review',
                    start: '2026-04-26T10:00:00.000Z',
                    end: '2026-04-26T10:30:00.000Z',
                    allDay: false,
                },
                {
                    id: 'system:personal:event-3:2026-04-26T11:00:00.000Z',
                    sourceId: 'system:personal',
                    title: 'Dentist',
                    start: '2026-04-26T11:00:00.000Z',
                    end: '2026-04-26T12:00:00.000Z',
                    allDay: false,
                },
            ],
        });

        const result = await fetchExternalCalendarEvents(
            new Date('2026-04-26T00:00:00.000Z'),
            new Date('2026-04-27T00:00:00.000Z'),
        );

        expect(result.calendars.map((calendar) => calendar.id)).toEqual(['system:personal']);
        expect(result.events.map((event) => event.title)).toEqual(['Dentist']);
    });
});
