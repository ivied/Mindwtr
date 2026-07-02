import { addDays, addMonths, addWeeks, format } from 'date-fns';

import { safeFormatDate, safeParseDate } from './date';
import { generateUUID as uuidv4 } from './uuid';
import { computeRelativeStartTime } from './task-relative-start';
import type { Recurrence, RecurrenceByDay, RecurrenceRule, RecurrenceStrategy, RecurrenceWeekday, Task, TaskStatus, ChecklistItem, Attachment } from './types';

export const RECURRENCE_RULES: RecurrenceRule[] = ['daily', 'weekly', 'monthly', 'yearly'];
export const RECURRENCE_INTERVAL_MAX = 999;

const WEEKDAY_ORDER: RecurrenceWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function isRecurrenceRule(value: string | undefined | null): value is RecurrenceRule {
    return !!value && (RECURRENCE_RULES as readonly string[]).includes(value);
}

const RRULE_FREQ_MAP: Record<string, RecurrenceRule> = {
    DAILY: 'daily',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    YEARLY: 'yearly',
};

type ParsedRRule = {
    rule?: RecurrenceRule;
    byDay?: RecurrenceByDay[];
    byMonthDay?: number[];
    interval?: number;
    weekStart?: RecurrenceWeekday;
    count?: number;
    until?: string;
};

type BuildRRuleOptions = {
    byMonthDay?: number[];
    weekStart?: RecurrenceWeekday;
    count?: number;
    until?: string;
};

type FormatRecurrenceLabelOptions = {
    recurrence: Task['recurrence'];
    t: (key: string) => string;
    formatDate?: (value: string) => string;
};

export type ProjectedRecurringTask = Task & {
    isProjectedRecurringTask: true;
    sourceTaskId: string;
};

const PROJECTED_RECURRENCE_ID_SUFFIX = ':projected-recurrence';

export const getProjectedRecurringTaskId = (taskId: string): string => (
    `${taskId}${PROJECTED_RECURRENCE_ID_SUFFIX}`
);

export const isProjectedRecurringTaskId = (taskId: string | undefined | null): boolean => (
    typeof taskId === 'string' && taskId.endsWith(PROJECTED_RECURRENCE_ID_SUFFIX)
);

export const isProjectedRecurringTask = (task: Partial<Task> | null | undefined): task is ProjectedRecurringTask => (
    Boolean(
        task
        && (task as Partial<ProjectedRecurringTask>).isProjectedRecurringTask === true
        && typeof (task as Partial<ProjectedRecurringTask>).sourceTaskId === 'string'
    )
);

export const getTaskCalendarOccurrenceDate = (task: Pick<Task, 'startTime' | 'dueDate'>): string | undefined => (
    task.startTime ?? task.dueDate
);

const parseByDayToken = (token: string): RecurrenceByDay | null => {
    const trimmed = token.toUpperCase().trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(-1|1|2|3|4)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) return null;
    const ordinal = match[1];
    const weekday = match[2] as RecurrenceWeekday;
    if (ordinal) {
        return `${ordinal}${weekday}` as RecurrenceByDay;
    }
    return weekday;
};

const normalizeWeekdays = (days?: string[] | null): RecurrenceByDay[] | undefined => {
    if (!days || days.length === 0) return undefined;
    const normalized = days
        .map(parseByDayToken)
        .filter((day): day is RecurrenceByDay => Boolean(day));
    return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
};

const normalizeWeekStart = (value?: string | null): RecurrenceWeekday | undefined => {
    const parsed = parseByDayToken(String(value || ''));
    return parsed && WEEKDAY_ORDER.includes(parsed as RecurrenceWeekday)
        ? parsed as RecurrenceWeekday
        : undefined;
};

const normalizeMonthDays = (days?: string[] | null): number[] | undefined => {
    if (!days || days.length === 0) return undefined;
    const normalized = days
        .map((day) => Number(day))
        .filter((day) => Number.isFinite(day) && day >= 1 && day <= 31);
    const unique = Array.from(new Set(normalized)).sort((a, b) => a - b);
    return unique.length > 0 ? unique : undefined;
};

const normalizeAnchorDay = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const day = Math.floor(value);
    return day >= 1 && day <= 31 ? day : undefined;
};

const parseUntilToken = (value: string | undefined): string | undefined => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return undefined;
    const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
    if (dateOnlyMatch) {
        const [, year, month, day] = dateOnlyMatch;
        return `${year}-${month}-${day}`;
    }

    const dateTimeMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(trimmed);
    if (!dateTimeMatch) return undefined;

    const [, year, month, day, hour, minute, second = '00', isUtc] = dateTimeMatch;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${isUtc ? 'Z' : ''}`;
    const parsed = safeParseDate(iso);
    if (!parsed) return undefined;
    return isUtc ? parsed.toISOString() : format(parsed, "yyyy-MM-dd'T'HH:mm:ss");
};

const formatUntilToken = (until: string | undefined): string | undefined => {
    const trimmed = String(until || '').trim();
    if (!trimmed) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed.replace(/-/g, '');
    }
    const parsed = safeParseDate(trimmed);
    if (!parsed) return undefined;
    const year = String(parsed.getUTCFullYear()).padStart(4, '0');
    const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const day = String(parsed.getUTCDate()).padStart(2, '0');
    const hour = String(parsed.getUTCHours()).padStart(2, '0');
    const minute = String(parsed.getUTCMinutes()).padStart(2, '0');
    const second = String(parsed.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}T${hour}${minute}${second}Z`;
};

export function parseRRuleString(rrule: string): ParsedRRule {
    if (!rrule) return {};
    const tokens = rrule.split(';').reduce<Record<string, string>>((acc, part) => {
        const [key, value] = part.split('=');
        if (key && value) acc[key.toUpperCase()] = value;
        return acc;
    }, {});
    const freq = tokens.FREQ ? RRULE_FREQ_MAP[tokens.FREQ.toUpperCase()] : undefined;
    const byDay = tokens.BYDAY ? normalizeWeekdays(tokens.BYDAY.split(',')) : undefined;
    const byMonthDay = tokens.BYMONTHDAY ? normalizeMonthDays(tokens.BYMONTHDAY.split(',')) : undefined;
    const interval = tokens.INTERVAL ? Number(tokens.INTERVAL) : undefined;
    const weekStart = normalizeWeekStart(tokens.WKST);
    const count = tokens.COUNT ? Number(tokens.COUNT) : undefined;
    const until = parseUntilToken(tokens.UNTIL);
    return {
        rule: freq,
        byDay,
        byMonthDay,
        interval: interval && interval > 0 ? interval : undefined,
        weekStart,
        count: count && count > 0 ? Math.round(count) : undefined,
        until,
    };
}

export function normalizeRecurrenceForLoad(value: unknown): Recurrence | undefined {
    if (!value) return undefined;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        if (isRecurrenceRule(trimmed)) return { rule: trimmed };
        const parsed = parseRRuleString(trimmed);
        return parsed.rule
            ? {
                rule: parsed.rule,
                ...(parsed.byDay ? { byDay: parsed.byDay } : {}),
                ...(parsed.byMonthDay ? { byMonthDay: parsed.byMonthDay } : {}),
                ...(parsed.weekStart ? { weekStart: parsed.weekStart } : {}),
                ...(parsed.count ? { count: parsed.count } : {}),
                ...(parsed.until ? { until: parsed.until } : {}),
                rrule: trimmed,
            }
            : undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) return undefined;

    const recurrence = value as Partial<Recurrence>;
    const rrule = typeof recurrence.rrule === 'string' && recurrence.rrule.trim().length > 0
        ? recurrence.rrule.trim()
        : undefined;
    const parsed = rrule ? parseRRuleString(rrule) : {};
    const rule = isRecurrenceRule(recurrence.rule) ? recurrence.rule : parsed.rule;
    if (!rule) return undefined;

    const strategy = recurrence.strategy === 'fluid' || recurrence.strategy === 'strict'
        ? recurrence.strategy
        : undefined;
    const explicitByDay = Array.isArray(recurrence.byDay)
        ? normalizeWeekdays(recurrence.byDay)
        : undefined;
    const byDay = explicitByDay ?? parsed.byDay;
    const explicitByMonthDay = Array.isArray(recurrence.byMonthDay)
        ? normalizeMonthDays(recurrence.byMonthDay.map(String))
        : undefined;
    const byMonthDay = explicitByMonthDay ?? parsed.byMonthDay;
    const weekStart = normalizeWeekStart(recurrence.weekStart) ?? parsed.weekStart;
    const count = typeof recurrence.count === 'number' && Number.isFinite(recurrence.count) && recurrence.count > 0
        ? Math.round(recurrence.count)
        : parsed.count;
    const until = typeof recurrence.until === 'string' && recurrence.until.trim().length > 0
        ? recurrence.until
        : parsed.until;
    const completedOccurrences =
        typeof recurrence.completedOccurrences === 'number'
        && Number.isFinite(recurrence.completedOccurrences)
        && recurrence.completedOccurrences >= 0
            ? Math.floor(recurrence.completedOccurrences)
            : undefined;
    const anchorDay = normalizeAnchorDay(recurrence.anchorDay);
    const startAnchorDay = normalizeAnchorDay(recurrence.startAnchorDay);
    const dueAnchorDay = normalizeAnchorDay(recurrence.dueAnchorDay);
    const reviewAnchorDay = normalizeAnchorDay(recurrence.reviewAnchorDay);

    return {
        rule,
        ...(strategy ? { strategy } : {}),
        ...(byDay ? { byDay } : {}),
        ...(byMonthDay ? { byMonthDay } : {}),
        ...(weekStart ? { weekStart } : {}),
        ...(count ? { count } : {}),
        ...(until ? { until } : {}),
        ...(completedOccurrences !== undefined ? { completedOccurrences } : {}),
        ...(anchorDay ? { anchorDay } : {}),
        ...(startAnchorDay ? { startAnchorDay } : {}),
        ...(dueAnchorDay ? { dueAnchorDay } : {}),
        ...(reviewAnchorDay ? { reviewAnchorDay } : {}),
        ...(rrule ? { rrule } : {}),
    };
}

const normalizeWeeklyByDay = (days?: RecurrenceByDay[] | null): RecurrenceWeekday[] | undefined => {
    const normalized = normalizeWeekdays(days as string[] | null);
    if (!normalized) return undefined;
    const weekly = normalized.filter((day) => WEEKDAY_ORDER.includes(day as RecurrenceWeekday)) as RecurrenceWeekday[];
    return weekly.length > 0 ? Array.from(new Set(weekly)) : undefined;
};

export function buildRRuleString(
    rule: RecurrenceRule,
    byDay?: RecurrenceByDay[],
    interval?: number,
    options: BuildRRuleOptions = {}
): string {
    const parts = [`FREQ=${rule.toUpperCase()}`];
    if (interval && interval > 1) {
        parts.push(`INTERVAL=${interval}`);
    }
    const normalizedDays = normalizeWeekdays(byDay as string[] | null);
    if (normalizedDays && normalizedDays.length > 0) {
        if (rule === 'weekly') {
            const weeklyDays = normalizeWeeklyByDay(normalizedDays);
            if (weeklyDays && weeklyDays.length > 0) {
                const ordered = WEEKDAY_ORDER.filter((day) => weeklyDays.includes(day));
                parts.push(`BYDAY=${ordered.join(',')}`);
            }
        } else if (rule === 'monthly') {
            const ordered = normalizedDays
                .filter(Boolean)
                .sort((a, b) => String(a).localeCompare(String(b)));
            parts.push(`BYDAY=${ordered.join(',')}`);
        }
    } else if (rule === 'monthly') {
        const normalizedMonthDays = normalizeMonthDays((options.byMonthDay || []).map(String));
        if (normalizedMonthDays && normalizedMonthDays.length > 0) {
            parts.push(`BYMONTHDAY=${normalizedMonthDays.join(',')}`);
        }
    }
    if (options.count && options.count > 0) {
        parts.push(`COUNT=${Math.round(options.count)}`);
    }
    const weekStart = normalizeWeekStart(options.weekStart);
    if (rule === 'weekly' && weekStart) {
        parts.push(`WKST=${weekStart}`);
    }
    const untilToken = formatUntilToken(options.until);
    if (untilToken) {
        parts.push(`UNTIL=${untilToken}`);
    }
    return parts.join(';');
}

function getRecurrenceRule(value: Task['recurrence']): RecurrenceRule | null {
    if (!value) return null;
    if (typeof value === 'string') {
        return isRecurrenceRule(value) ? value : null;
    }
    if (typeof value === 'object') {
        const rule = (value as Recurrence).rule;
        if (isRecurrenceRule(rule)) return rule;
        if ((value as Recurrence).rrule) {
            const parsed = parseRRuleString((value as Recurrence).rrule || '');
            if (parsed.rule) return parsed.rule;
        }
    }
    return null;
}

function getRecurrenceStrategy(value: Task['recurrence']): RecurrenceStrategy {
    if (value && typeof value === 'object' && value.strategy === 'fluid') {
        return 'fluid';
    }
    return 'strict';
}

function getRecurrenceByDay(value: Task['recurrence']): RecurrenceByDay[] | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const explicit = normalizeWeekdays(recurrence.byDay);
    if (explicit && explicit.length > 0) return explicit;
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        return parsed.byDay;
    }
    return undefined;
}

function getRecurrenceByMonthDay(value: Task['recurrence']): number[] | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const explicit = Array.isArray(recurrence.byMonthDay)
        ? normalizeMonthDays(recurrence.byMonthDay.map(String))
        : undefined;
    if (explicit && explicit.length > 0) return explicit;
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        return parsed.byMonthDay;
    }
    return undefined;
}

function getRecurrenceInterval(value: Task['recurrence']): number {
    if (!value || typeof value === 'string') return 1;
    const recurrence = value as Recurrence;
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        if (parsed.interval && parsed.interval > 0) return parsed.interval;
    }
    return 1;
}

function getRecurrenceWeekStart(value: Task['recurrence']): RecurrenceWeekday | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const explicit = normalizeWeekStart(recurrence.weekStart);
    if (explicit) return explicit;
    if (recurrence.rrule) {
        return parseRRuleString(recurrence.rrule).weekStart;
    }
    return undefined;
}

export function getRecurrenceCountValue(value: Task['recurrence']): number | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    if (typeof recurrence.count === 'number' && recurrence.count > 0) {
        return Math.round(recurrence.count);
    }
    if (recurrence.rrule) {
        const parsed = parseRRuleString(recurrence.rrule);
        if (parsed.count && parsed.count > 0) return parsed.count;
    }
    return undefined;
}

export function getRecurrenceUntilValue(value: Task['recurrence']): string | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    if (recurrence.until) return recurrence.until;
    if (recurrence.rrule) {
        return parseRRuleString(recurrence.rrule).until;
    }
    return undefined;
}

export function getRecurrenceCompletedOccurrencesValue(value: Task['recurrence']): number | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    if (typeof recurrence.completedOccurrences !== 'number' || recurrence.completedOccurrences < 0) {
        return undefined;
    }
    return Math.floor(recurrence.completedOccurrences);
}

export function formatRecurrenceLabel({ recurrence, t, formatDate }: FormatRecurrenceLabelOptions): string {
    const rule = getRecurrenceRule(recurrence);
    if (!rule) return '';

    const strategy = getRecurrenceStrategy(recurrence);
    const interval = getRecurrenceInterval(recurrence);
    const until = getRecurrenceUntilValue(recurrence);
    const count = getRecurrenceCountValue(recurrence);
    const unitKey = rule === 'daily'
        ? 'recurrence.dayUnit'
        : rule === 'weekly'
            ? 'recurrence.weekUnit'
            : rule === 'monthly'
                ? 'recurrence.monthUnit'
                : rule === 'yearly'
                    ? 'recurrence.yearUnit'
                    : undefined;

    return [
        `${t(`recurrence.${rule}`) || rule}${strategy === 'fluid' ? ` · ${t('recurrence.afterCompletionShort')}` : ''}`,
        unitKey && interval > 1
            ? `${t('recurrence.repeatEvery')} ${interval} ${t(unitKey)}`
            : undefined,
        until ? `${t('recurrence.endsOnDate')} ${(formatDate ?? ((value: string) => safeFormatDate(value, 'P')))(until)}` : undefined,
        count ? `${t('recurrence.endsAfterCount')} ${count} ${t('recurrence.occurrenceUnit')}` : undefined,
    ].filter(Boolean).join(' · ');
}

function getRecurrenceFieldAnchorDay(
    value: Task['recurrence'],
    field: 'startTime' | 'dueDate' | 'reviewAt'
): number | undefined {
    if (!value || typeof value === 'string') return undefined;
    const recurrence = value as Recurrence;
    const fieldAnchor = field === 'startTime'
        ? recurrence.startAnchorDay
        : field === 'dueDate'
            ? recurrence.dueAnchorDay
            : recurrence.reviewAnchorDay;
    return normalizeAnchorDay(fieldAnchor) ?? normalizeAnchorDay(recurrence.anchorDay);
}

const getDateDay = (value: string | undefined): number | undefined => {
    const parsed = safeParseDate(value);
    return parsed ? parsed.getDate() : undefined;
};

function getNextRecurrenceAnchorDays(task: Task, rule: RecurrenceRule) {
    if (rule !== 'monthly' && rule !== 'yearly') return {};

    const startAnchorDay = getRecurrenceFieldAnchorDay(task.recurrence, 'startTime')
        ?? getDateDay(task.startTime);
    const dueAnchorDay = getRecurrenceFieldAnchorDay(task.recurrence, 'dueDate')
        ?? getDateDay(task.dueDate);
    const reviewAnchorDay = getRecurrenceFieldAnchorDay(task.recurrence, 'reviewAt')
        ?? getDateDay(task.reviewAt);
    const anchorDay = normalizeAnchorDay(
        typeof task.recurrence === 'object' ? task.recurrence.anchorDay : undefined
    ) ?? dueAnchorDay ?? startAnchorDay ?? reviewAnchorDay;

    return {
        ...(anchorDay ? { anchorDay } : {}),
        ...(startAnchorDay ? { startAnchorDay } : {}),
        ...(dueAnchorDay ? { dueAnchorDay } : {}),
        ...(reviewAnchorDay ? { reviewAnchorDay } : {}),
    };
}

function addInterval(base: Date, rule: RecurrenceRule, interval: number = 1, anchorDay?: number): Date {
    switch (rule) {
        case 'daily':
            return addDays(base, interval);
        case 'weekly':
            return addWeeks(base, interval);
        case 'monthly':
            return addMonthsClamped(base, interval, anchorDay);
        case 'yearly':
            return addYearsClamped(base, interval, anchorDay);
    }
}

const weekdayIndex = (weekday: RecurrenceWeekday): number => WEEKDAY_ORDER.indexOf(weekday);

const getLastDayOfMonth = (year: number, month: number): number => {
    return new Date(year, month + 1, 0).getDate();
};

const buildDateWithTime = (year: number, month: number, day: number, base: Date): Date => {
    return new Date(
        year,
        month,
        day,
        base.getHours(),
        base.getMinutes(),
        base.getSeconds(),
        base.getMilliseconds()
    );
};

const addMonthsClamped = (base: Date, interval: number, anchorDay?: number): Date => {
    const seed = new Date(
        base.getFullYear(),
        base.getMonth() + interval,
        1,
        base.getHours(),
        base.getMinutes(),
        base.getSeconds(),
        base.getMilliseconds()
    );
    const year = seed.getFullYear();
    const month = seed.getMonth();
    const lastDay = getLastDayOfMonth(year, month);
    const day = Math.min(anchorDay ?? base.getDate(), lastDay);
    return buildDateWithTime(year, month, day, base);
};

const addYearsClamped = (base: Date, interval: number, anchorDay?: number): Date => {
    const year = base.getFullYear() + interval;
    const month = base.getMonth();
    const lastDay = getLastDayOfMonth(year, month);
    const day = Math.min(anchorDay ?? base.getDate(), lastDay);
    return buildDateWithTime(year, month, day, base);
};

const orderWeekdaysByWeekStart = (weekStart: RecurrenceWeekday): RecurrenceWeekday[] => {
    const startIndex = WEEKDAY_ORDER.indexOf(weekStart);
    if (startIndex < 0) return WEEKDAY_ORDER;
    return [...WEEKDAY_ORDER.slice(startIndex), ...WEEKDAY_ORDER.slice(0, startIndex)];
};

function nextWeeklyByDay(
    base: Date,
    byDay: RecurrenceByDay[],
    interval: number = 1,
    weekStart: RecurrenceWeekday = 'MO'
): Date {
    const normalizedDays = normalizeWeeklyByDay(byDay);
    if (!normalizedDays || normalizedDays.length === 0) {
        return addWeeks(base, interval);
    }
    const safeInterval = interval > 0 ? interval : 1;
    const normalizedWeekStart = normalizeWeekStart(weekStart) ?? 'MO';
    const orderedDays = orderWeekdaysByWeekStart(normalizedWeekStart).filter((day) => normalizedDays.includes(day));
    const weekStartIndex = weekdayIndex(normalizedWeekStart);
    const anchorWeekStart = new Date(base);
    anchorWeekStart.setDate(base.getDate() - ((base.getDay() - weekStartIndex + 7) % 7));

    for (let weekOffset = 0; weekOffset <= safeInterval * 52; weekOffset += safeInterval) {
        const candidateWeekStart = addWeeks(anchorWeekStart, weekOffset);
        for (const weekday of orderedDays) {
            const dayOffset = (weekdayIndex(weekday) - weekStartIndex + 7) % 7;
            const candidate = addDays(candidateWeekStart, dayOffset);
            if (weekOffset === 0 && candidate <= base) continue;
            return candidate;
        }
    }
    return addWeeks(base, safeInterval);
}

const getNthWeekdayOfMonth = (year: number, month: number, weekday: RecurrenceWeekday, ordinal: number): Date | null => {
    if (ordinal === 0) return null;
    if (ordinal > 0) {
        const firstOfMonth = new Date(year, month, 1);
        const firstWeekday = firstOfMonth.getDay();
        const targetWeekday = weekdayIndex(weekday);
        const offset = (targetWeekday - firstWeekday + 7) % 7;
        const day = 1 + offset + (ordinal - 1) * 7;
        const candidate = new Date(year, month, day);
        return candidate.getMonth() === month ? candidate : null;
    }
    // ordinal < 0 => from end of month
    const lastOfMonth = new Date(year, month + 1, 0);
    const lastWeekday = lastOfMonth.getDay();
    const targetWeekday = weekdayIndex(weekday);
    const offset = (lastWeekday - targetWeekday + 7) % 7;
    const day = lastOfMonth.getDate() - offset;
    const candidate = new Date(year, month, day);
    return candidate.getMonth() === month ? candidate : null;
};

const parseOrdinalByDay = (token: RecurrenceByDay): { weekday: RecurrenceWeekday; ordinal?: number } | null => {
    const match = String(token).match(/^(-?\d)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) return null;
    const ordinal = match[1] ? Number(match[1]) : undefined;
    const weekday = match[2] as RecurrenceWeekday;
    return { weekday, ordinal };
};

function nextMonthlyByDay(base: Date, byDay: RecurrenceByDay[], interval: number = 1): Date {
    const normalized = normalizeWeekdays(byDay as string[] | null);
    if (!normalized || normalized.length === 0) {
        return addMonths(base, interval);
    }
    const candidates = normalized
        .map(parseOrdinalByDay)
        .filter((item): item is { weekday: RecurrenceWeekday; ordinal?: number } => Boolean(item));
    const safeInterval = interval > 0 ? interval : 1;
    for (let offset = 0; offset <= safeInterval * 12; offset += safeInterval) {
        const monthDate = addMonths(base, offset);
        const year = monthDate.getFullYear();
        const month = monthDate.getMonth();
        const monthCandidates: Date[] = [];
        candidates.forEach((candidate) => {
            if (typeof candidate.ordinal === 'number') {
                const result = getNthWeekdayOfMonth(year, month, candidate.weekday, candidate.ordinal);
                if (result) {
                    monthCandidates.push(new Date(
                        result.getFullYear(),
                        result.getMonth(),
                        result.getDate(),
                        base.getHours(),
                        base.getMinutes(),
                        base.getSeconds(),
                        base.getMilliseconds()
                    ));
                }
            }
        });
        const filtered = monthCandidates
            .filter((date) => (offset === 0 ? date > base : true))
            .sort((a, b) => a.getTime() - b.getTime());
        if (filtered.length > 0) {
            return filtered[0];
        }
    }
    return addMonths(base, safeInterval);
}

function nextMonthlyByMonthDay(base: Date, byMonthDay: number[], interval: number = 1): Date {
    const normalized = normalizeMonthDays(byMonthDay.map(String));
    if (!normalized || normalized.length === 0) {
        return addMonths(base, interval);
    }
    const safeInterval = interval > 0 ? interval : 1;
    for (let offset = 0; offset <= safeInterval * 12; offset += safeInterval) {
        const monthDate = addMonths(base, offset);
        const year = monthDate.getFullYear();
        const month = monthDate.getMonth();
        const candidates = normalized.map((day) => new Date(
            year,
            month,
            day,
            base.getHours(),
            base.getMinutes(),
            base.getSeconds(),
            base.getMilliseconds()
        ));
        const filtered = candidates
            .filter((date) => date.getMonth() === month)
            .filter((date) => (offset === 0 ? date > base : true))
            .sort((a, b) => a.getTime() - b.getTime());
        if (filtered.length > 0) return filtered[0];
    }
    return addMonths(base, safeInterval);
}

function nextIsoFrom(
    baseIso: string | undefined,
    rule: RecurrenceRule,
    fallbackBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday,
    searchBase?: Date,
    anchorDay?: number
): string | undefined {
    const parsed = safeParseDate(baseIso);
    const formatBase = parsed || fallbackBase;
    const base = searchBase ?? formatBase;
    const effectiveByDay = byDay && byDay.length > 0 ? byDay : undefined;
    const effectiveByMonthDay = byMonthDay && byMonthDay.length > 0 ? byMonthDay : undefined;
    let nextDate = rule === 'weekly' && effectiveByDay
        ? nextWeeklyByDay(base, effectiveByDay, interval, weekStart)
        : rule === 'monthly' && effectiveByDay
            ? nextMonthlyByDay(base, effectiveByDay, interval)
            : rule === 'monthly' && effectiveByMonthDay
                ? nextMonthlyByMonthDay(base, effectiveByMonthDay, interval)
                : addInterval(base, rule, interval, anchorDay ?? formatBase.getDate());

    // Preserve existing storage format:
    // - If base has timezone/offset, keep ISO (Z/offset).
    // - Otherwise, return local datetime-local compatible string.
    const isDateOnly = !!baseIso && /^\d{4}-\d{2}-\d{2}$/.test(baseIso);
    if (isDateOnly) {
        return format(nextDate, 'yyyy-MM-dd');
    }
    const hasTimezone = !!baseIso && /Z$|[+-]\d{2}:?\d{2}$/.test(baseIso);
    const hasLocalTime = !!baseIso && /[T\s]\d{2}:\d{2}/.test(baseIso);
    if (!hasTimezone && hasLocalTime) {
        nextDate = buildDateWithTime(nextDate.getFullYear(), nextDate.getMonth(), nextDate.getDate(), formatBase);
    }
    return hasTimezone ? nextDate.toISOString() : format(nextDate, "yyyy-MM-dd'T'HH:mm");
}

const preserveDateOnlyFormat = (
    nextIso: string | undefined,
    sourceIso: string | undefined
): string | undefined => {
    if (!nextIso || !sourceIso || !/^\d{4}-\d{2}-\d{2}$/.test(sourceIso)) return nextIso;
    const parsed = safeParseDate(nextIso);
    return parsed ? format(parsed, 'yyyy-MM-dd') : nextIso;
};

function resetChecklist(checklist: ChecklistItem[] | undefined): ChecklistItem[] | undefined {
    if (!checklist || checklist.length === 0) return undefined;
    return checklist.map((item) => ({
        ...item,
        id: uuidv4(),
        isCompleted: false,
    }));
}

const shouldStopAtUntil = (nextIso: string | undefined, until: string | undefined): boolean => {
    if (!nextIso || !until) return false;
    const nextDate = safeParseDate(nextIso);
    if (!nextDate) return false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
        return format(nextDate, 'yyyy-MM-dd') > until;
    }
    const untilDate = safeParseDate(until);
    if (!untilDate) return false;
    return nextDate.getTime() > untilDate.getTime();
};

type ProjectedIsoResult = {
    iso?: string;
    steps: number;
};

const emptyProjectedIsoResult = (): ProjectedIsoResult => ({ iso: undefined, steps: 0 });

const getProjectionBaseDate = (projectedAtIso: string): Date => {
    const parsed = safeParseDate(projectedAtIso);
    if (parsed) return parsed;
    const fallback = new Date(projectedAtIso);
    return Number.isNaN(fallback.getTime()) ? new Date() : fallback;
};

const hasMonthlyRuleDateAnchor = (byDay?: RecurrenceByDay[], byMonthDay?: number[]): boolean => (
    Boolean(byMonthDay?.length)
    || Boolean(byDay?.some((day) => typeof parseOrdinalByDay(day)?.ordinal === 'number'))
);

function projectStrictIsoFrom(
    baseIso: string | undefined,
    rule: RecurrenceRule,
    projectionBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday,
    anchorDay?: number
): ProjectedIsoResult {
    let nextIso = nextIsoFrom(baseIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart, undefined, anchorDay);
    if (!nextIso) return { iso: undefined, steps: 0 };

    let steps = 1;
    for (let guard = 0; guard < 1000; guard += 1) {
        const parsedNext = safeParseDate(nextIso);
        if (!parsedNext || parsedNext > projectionBase) break;
        const followingIso = nextIsoFrom(nextIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart, undefined, anchorDay);
        if (!followingIso || followingIso === nextIso) break;
        nextIso = followingIso;
        steps += 1;
    }
    return { iso: nextIso, steps };
}

function projectUnscheduledMonthlyStart(
    rule: RecurrenceRule,
    projectionBase: Date,
    byDay?: RecurrenceByDay[],
    interval: number = 1,
    byMonthDay?: number[],
    weekStart?: RecurrenceWeekday
): ProjectedIsoResult {
    if (rule !== 'monthly' || !hasMonthlyRuleDateAnchor(byDay, byMonthDay)) {
        return emptyProjectedIsoResult();
    }

    const seedIso = format(projectionBase, 'yyyy-MM-dd');
    const iso = nextIsoFrom(seedIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart);
    return iso ? { iso, steps: 1 } : emptyProjectedIsoResult();
}

/**
 * Create a read-only, calendar-only preview of the next visible occurrence.
 *
 * This never creates a persisted task. It uses a synthetic ID so calendar views
 * and device calendar push can add/update/remove the preview independently.
 */
export function createProjectedRecurringTask(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): ProjectedRecurringTask | null {
    if (!task.showFutureRecurrence) return null;
    if (isProjectedRecurringTask(task)) return null;
    if (task.deletedAt || task.status === 'done' || task.status === 'archived' || task.status === 'reference') {
        return null;
    }

    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return null;

    const strategy = getRecurrenceStrategy(task.recurrence);
    const byDay = getRecurrenceByDay(task.recurrence);
    const byMonthDay = getRecurrenceByMonthDay(task.recurrence);
    const interval = getRecurrenceInterval(task.recurrence);
    const weekStart = getRecurrenceWeekStart(task.recurrence);
    const count = getRecurrenceCountValue(task.recurrence);
    const until = getRecurrenceUntilValue(task.recurrence);
    const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    const projectionBase = getProjectionBaseDate(projectedAtIso);
    const projectionSourceTask = createCurrentRecurringCalendarTask(task, projectedAtIso) ?? task;

    const projectField = (field: 'startTime' | 'dueDate' | 'reviewAt'): ProjectedIsoResult => {
        const baseIso = projectionSourceTask[field];
        if (!baseIso) return { iso: undefined, steps: 0 };
        if (strategy === 'fluid') {
            return {
                iso: nextIsoFrom(projectedAtIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart),
                steps: 1,
            };
        }
        const anchorDay = getRecurrenceFieldAnchorDay(task.recurrence, field)
            ?? getDateDay(baseIso);
        return projectStrictIsoFrom(baseIso, rule, projectionBase, byDay, interval, byMonthDay, weekStart, anchorDay);
    };

    const hasScheduleFields = Boolean(
        projectionSourceTask.startTime
        || projectionSourceTask.dueDate
        || projectionSourceTask.reviewAt
    );
    const nextStart = projectionSourceTask.startTime || hasScheduleFields
        ? projectField('startTime')
        : projectUnscheduledMonthlyStart(rule, projectionBase, byDay, interval, byMonthDay, weekStart);
    const nextDue = projectField('dueDate');
    const nextReview = projectField('reviewAt');
    const projectionSteps = Math.max(nextStart.steps, nextDue.steps, nextReview.steps);
    if (!nextStart.iso && !nextDue.iso && !nextReview.iso) return null;
    if (!nextStart.iso && !nextDue.iso) return null;
    if (count && completedOccurrences + projectionSteps >= count) return null;

    const nextOccurrenceAnchor = nextDue.iso ?? nextStart.iso ?? nextReview.iso;
    if (shouldStopAtUntil(nextOccurrenceAnchor, until)) return null;

    return {
        ...task,
        id: getProjectedRecurringTaskId(task.id),
        sourceTaskId: task.id,
        isProjectedRecurringTask: true,
        startTime: nextStart.iso,
        dueDate: nextDue.iso,
        reviewAt: nextReview.iso,
        attachments: undefined,
        completedAt: undefined,
        deletedAt: undefined,
        purgedAt: undefined,
        isFocusedToday: false,
        createdAt: task.createdAt,
        updatedAt: projectedAtIso,
    };
}

export function getProjectedRecurringTaskCalendarDate(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): string | undefined {
    const projectedTask = createProjectedRecurringTask(task, projectedAtIso);
    return projectedTask ? getTaskCalendarOccurrenceDate(projectedTask) : undefined;
}

export function createCurrentRecurringCalendarTask(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): Task | null {
    if (!task.showFutureRecurrence) return null;
    if (isProjectedRecurringTask(task)) return null;
    if (task.deletedAt || task.status === 'done' || task.status === 'archived' || task.status === 'reference') {
        return null;
    }
    if (task.startTime || task.dueDate || task.reviewAt) return null;

    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return null;

    const count = getRecurrenceCountValue(task.recurrence);
    const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    if (count && completedOccurrences >= count) return null;

    const projectionBase = getProjectionBaseDate(projectedAtIso);
    const currentStart = projectUnscheduledMonthlyStart(
        rule,
        projectionBase,
        getRecurrenceByDay(task.recurrence),
        getRecurrenceInterval(task.recurrence),
        getRecurrenceByMonthDay(task.recurrence),
        getRecurrenceWeekStart(task.recurrence),
    );
    if (!currentStart.iso) return null;
    if (shouldStopAtUntil(currentStart.iso, getRecurrenceUntilValue(task.recurrence))) return null;

    return {
        ...task,
        startTime: currentStart.iso,
    };
}

export function expandCalendarRecurringTasks(
    task: Task,
    projectedAtIso: string = new Date().toISOString()
): Task[] {
    const currentTask = createCurrentRecurringCalendarTask(task, projectedAtIso) ?? task;
    const projectedTask = createProjectedRecurringTask(task, projectedAtIso);
    return projectedTask ? [currentTask, projectedTask] : [currentTask];
}

/**
 * Create the next instance of a recurring task.
 *
 * - Advances dueDate only when the original task has a dueDate.
 * - Shifts startTime/reviewAt forward if present.
 * - Keeps schedule fields independent: due-only tasks stay due-only, start-only tasks stay start-only.
 * - Resets checklist completion and IDs.
 * - New instance status is based on the previous status, with done -> next.
 */
export function createNextRecurringTask(
    task: Task,
    completedAtIso: string,
    previousStatus: TaskStatus
): Task | null {
    const rule = getRecurrenceRule(task.recurrence);
    if (!rule) return null;
    const strategy = getRecurrenceStrategy(task.recurrence);
    const byDay = getRecurrenceByDay(task.recurrence);
    const byMonthDay = getRecurrenceByMonthDay(task.recurrence);
    const interval = getRecurrenceInterval(task.recurrence);
    const weekStart = getRecurrenceWeekStart(task.recurrence);
    const count = getRecurrenceCountValue(task.recurrence);
    const until = getRecurrenceUntilValue(task.recurrence);
    const completedOccurrences = getRecurrenceCompletedOccurrencesValue(task.recurrence) ?? 0;
    const startAnchorDay = getRecurrenceFieldAnchorDay(task.recurrence, 'startTime')
        ?? getDateDay(task.startTime);
    const dueAnchorDay = getRecurrenceFieldAnchorDay(task.recurrence, 'dueDate')
        ?? getDateDay(task.dueDate);
    const reviewAnchorDay = getRecurrenceFieldAnchorDay(task.recurrence, 'reviewAt')
        ?? getDateDay(task.reviewAt);
    const parsedCompletedAt = safeParseDate(completedAtIso);
    const fallbackCompletedAt = (() => {
        const candidate = new Date(completedAtIso);
        return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
    })();
    const completedAtDate = parsedCompletedAt ?? fallbackCompletedAt;
    const nextDueDate = task.dueDate
        ? preserveDateOnlyFormat(
            nextIsoFrom(
                strategy === 'fluid' ? completedAtIso : task.dueDate,
                rule,
                completedAtDate,
                byDay,
                interval,
                byMonthDay,
                weekStart,
                undefined,
                strategy === 'fluid' ? undefined : dueAnchorDay
            ),
            task.dueDate
        )
        : undefined;
    let nextStartTime = task.startTime
        ? preserveDateOnlyFormat(
            nextIsoFrom(
                strategy === 'fluid' ? completedAtIso : task.startTime,
                rule,
                completedAtDate,
                byDay,
                interval,
                byMonthDay,
                weekStart,
                undefined,
                strategy === 'fluid' ? undefined : startAnchorDay
            ),
            task.startTime
        )
        : undefined;
    if (strategy === 'strict' && task.startTime && task.dueDate && nextStartTime) {
        const parsedNextStart = safeParseDate(nextStartTime);
        if (parsedNextStart && parsedNextStart <= completedAtDate) {
            nextStartTime = nextIsoFrom(task.startTime, rule, completedAtDate, byDay, interval, byMonthDay, weekStart, completedAtDate, startAnchorDay);
        }
    }
    let nextRelativeStartOffset = task.relativeStartOffset ? { ...task.relativeStartOffset } : undefined;
    if (nextRelativeStartOffset) {
        if (nextDueDate) {
            const computedStartTime = computeRelativeStartTime(nextDueDate, nextRelativeStartOffset);
            if (computedStartTime) {
                nextStartTime = computedStartTime;
            } else {
                nextRelativeStartOffset = undefined;
            }
        } else {
            nextRelativeStartOffset = undefined;
        }
    }
    const nextReviewAt = task.reviewAt
        ? preserveDateOnlyFormat(
            nextIsoFrom(
                strategy === 'fluid' ? completedAtIso : task.reviewAt,
                rule,
                completedAtDate,
                byDay,
                interval,
                byMonthDay,
                weekStart,
                undefined,
                strategy === 'fluid' ? undefined : reviewAnchorDay
            ),
            task.reviewAt
        )
        : undefined;
    if (!nextStartTime && !nextDueDate && !nextReviewAt) {
        // When recurrence exists but no schedule fields are set, defer the next instance
        // from completion so it does not reappear in Next immediately.
        nextStartTime = nextIsoFrom(completedAtIso, rule, completedAtDate, byDay, interval, byMonthDay, weekStart);
    }

    if (count && completedOccurrences + 1 >= count) {
        return null;
    }

    const nextOccurrenceAnchor = nextDueDate ?? nextStartTime ?? nextReviewAt;
    if (shouldStopAtUntil(nextOccurrenceAnchor, until)) {
        return null;
    }

    let newStatus: TaskStatus = previousStatus;
    if (newStatus === 'done' || newStatus === 'archived') {
        newStatus = 'next';
    }

    const duplicatedAttachments = (task.attachments || [])
        .filter((attachment) => !attachment.deletedAt)
        .map<Attachment>((attachment) => ({
            ...attachment,
            id: uuidv4(),
            createdAt: completedAtIso,
            updatedAt: completedAtIso,
            deletedAt: undefined,
        }));

    const nextCompletedOccurrences = completedOccurrences + 1;
    let nextRecurrence = task.recurrence;
    const nextAnchorDays = getNextRecurrenceAnchorDays(task, rule);
    if (task.recurrence && typeof task.recurrence === 'object') {
        const recurrence = task.recurrence as Recurrence;
        nextRecurrence = {
            ...recurrence,
            ...nextAnchorDays,
            ...(byMonthDay ? { byMonthDay } : {}),
            ...(typeof recurrence.count === 'number' || count ? { count } : {}),
            ...(typeof recurrence.until === 'string' || until ? { until } : {}),
            ...(count ? { completedOccurrences: nextCompletedOccurrences } : {}),
            ...(recurrence.rrule
                ? {
                    rrule: buildRRuleString(rule, byDay, interval, {
                        byMonthDay,
                        weekStart,
                        count,
                        until,
                    }),
                }
                : {}),
        };
    } else if (Object.keys(nextAnchorDays).length > 0) {
        nextRecurrence = {
            rule,
            ...nextAnchorDays,
        };
    }

    return {
        id: uuidv4(),
        title: task.title,
        status: newStatus,
        priority: task.priority,
        energyLevel: task.energyLevel,
        assignedTo: task.assignedTo,
        taskMode: task.taskMode,
        startTime: nextStartTime,
        relativeStartOffset: nextRelativeStartOffset,
        dueDate: nextDueDate,
        recurrence: nextRecurrence,
        showFutureRecurrence: task.showFutureRecurrence ? true : undefined,
        suppressMindwtrReminders: task.suppressMindwtrReminders ? true : undefined,
        repeatReminderMinutes: task.repeatReminderMinutes,
        tags: [...(task.tags || [])],
        contexts: [...(task.contexts || [])],
        checklist: resetChecklist(task.checklist),
        description: task.description,
        textDirection: task.textDirection,
        attachments: duplicatedAttachments.length > 0 ? duplicatedAttachments : undefined,
        location: task.location,
        projectId: task.projectId,
        sectionId: task.sectionId,
        areaId: task.areaId,
        isFocusedToday: false,
        timeEstimate: task.timeEstimate,
        reviewAt: nextReviewAt,
        createdAt: completedAtIso,
        updatedAt: completedAtIso,
    };
}
