import { describe, expect, it } from 'vitest';

import {
    EXTERNAL_CALENDAR_COLORS,
    getExternalCalendarColorForId,
    normalizeExternalCalendarColor,
} from './external-calendar-colors';

describe('external calendar colors', () => {
    it('normalizes only supported palette colors', () => {
        expect(normalizeExternalCalendarColor('#2563eb')).toBe('#2563EB');
        expect(normalizeExternalCalendarColor('#000000')).toBeUndefined();
        expect(normalizeExternalCalendarColor('red')).toBeUndefined();
        expect(normalizeExternalCalendarColor(null)).toBeUndefined();
    });

    it('returns a stable palette color for a source id', () => {
        const color = getExternalCalendarColorForId('work');
        expect(EXTERNAL_CALENDAR_COLORS).toContain(color);
        expect(getExternalCalendarColorForId('work')).toBe(color);
    });
});
