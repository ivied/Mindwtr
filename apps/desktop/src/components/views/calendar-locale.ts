import { getLocalizedWeekdayLabels, resolveDateLocaleTag, type RecurrenceWeekday } from '@mindwtr/core';

const WEEKDAY_ORDER: RecurrenceWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MONTH_REFERENCE_DATES = Array.from({ length: 12 }, (_, index) => new Date(2024, index, 1, 12, 0, 0));

export function resolveCalendarLocale(params: {
    language?: string | null;
    dateFormat?: string | null;
    calendarSystem?: string | null;
    systemLocale?: string | null;
}): string {
    return resolveDateLocaleTag(params);
}

export function getCalendarWeekdayHeaders(locale: string, weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6): string[] {
    const labels = getLocalizedWeekdayLabels(locale, 'short');
    const startIndex = Math.max(0, Math.min(WEEKDAY_ORDER.length - 1, weekStartsOn));
    const order = [...WEEKDAY_ORDER.slice(startIndex), ...WEEKDAY_ORDER.slice(0, startIndex)];
    return order.map((weekday) => labels[weekday]);
}

export function getCalendarMonthNames(locale: string): string[] {
    try {
        const formatter = new Intl.DateTimeFormat(locale || 'en-US', { month: 'long' });
        return MONTH_REFERENCE_DATES.map((date) => formatter.format(date));
    } catch {
        const fallbackFormatter = new Intl.DateTimeFormat('en-US', { month: 'long' });
        return MONTH_REFERENCE_DATES.map((date) => fallbackFormatter.format(date));
    }
}
