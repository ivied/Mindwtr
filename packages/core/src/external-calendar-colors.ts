export const EXTERNAL_CALENDAR_COLORS = [
    '#2563EB',
    '#7C3AED',
    '#DB2777',
    '#EA580C',
    '#059669',
    '#0891B2',
    '#4F46E5',
    '#65A30D',
] as const;

export type ExternalCalendarColor = typeof EXTERNAL_CALENDAR_COLORS[number];

export function normalizeExternalCalendarColor(value: unknown): ExternalCalendarColor | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toUpperCase();
    return (EXTERNAL_CALENDAR_COLORS as readonly string[]).includes(normalized)
        ? normalized as ExternalCalendarColor
        : undefined;
}

export function getExternalCalendarColorForId(sourceId: string): ExternalCalendarColor {
    let hash = 0;
    for (let index = 0; index < sourceId.length; index += 1) {
        hash = ((hash << 5) - hash) + sourceId.charCodeAt(index);
        hash |= 0;
    }
    return EXTERNAL_CALENDAR_COLORS[Math.abs(hash) % EXTERNAL_CALENDAR_COLORS.length] ?? EXTERNAL_CALENDAR_COLORS[0];
}
