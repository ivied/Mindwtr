import {
    endOfDay,
    endOfMonth,
    endOfWeek,
    isAfter,
    isBefore,
    isEqual,
    startOfDay,
    startOfMonth,
    startOfWeek,
} from 'date-fns';

import { timeEstimateToMinutes } from './calendar-scheduling';
import { safeParseDate, safeParseDueDate } from './date';
import { matchesHierarchicalToken, normalizePrefixedToken } from './hierarchy-utils';
import type {
    DateRange,
    FilterCriteria,
    FilterPriority,
    Project,
    SavedFilter,
    SavedFilterView,
    SortField,
    Task,
    TaskEnergyLevel,
    TaskPriority,
    TaskStatus,
    TimeEstimate,
} from './types';

export const SAVED_FILTER_NO_PROJECT_ID = '__no_project__';

type ApplyFilterOptions = {
    now?: Date;
    projects?: Project[];
    tokenMatchMode?: 'any' | 'all';
    weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

const TASK_STATUS_VALUES = new Set<TaskStatus>(['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived']);
const FILTER_PRIORITY_VALUES = new Set<FilterPriority>(['none', 'low', 'medium', 'high', 'urgent']);
const TASK_ENERGY_VALUES = new Set<TaskEnergyLevel>(['low', 'medium', 'high']);
const TIME_ESTIMATE_VALUES = new Set<TimeEstimate>(['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+']);
const SAVED_FILTER_VIEW_VALUES = new Set<SavedFilterView>(['focus', 'next', 'waiting', 'someday', 'contexts', 'all']);
const SORT_FIELD_VALUES = new Set<SortField>([
    'default',
    'due',
    'start',
    'review',
    'title',
    'created',
    'created-desc',
    'priority',
    'energy',
    'timeEstimate',
    'project',
    'updated',
]);
const DATE_PRESET_VALUES = new Set(['today', 'this_week', 'this_month', 'overdue', 'no_date']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeStringArray = (value: unknown, options?: { lowercase?: boolean; prefix?: '@' | '#' }): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<string>();
    const next: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        const normalized = options?.prefix
            ? normalizePrefixedToken(trimmed, options.prefix)
            : options?.lowercase
                ? trimmed.toLowerCase()
                : trimmed;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(normalized);
    }
    return next.length > 0 ? next : undefined;
};

const normalizeEnumArray = <T extends string>(value: unknown, allowed: Set<T>): T[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const seen = new Set<T>();
    const next: T[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        if (!allowed.has(item as T)) continue;
        const normalized = item as T;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        next.push(normalized);
    }
    return next.length > 0 ? next : undefined;
};

export function normalizeDateRange(value: unknown): DateRange | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.preset === 'string' && DATE_PRESET_VALUES.has(value.preset)) {
        return { preset: value.preset as 'today' | 'this_week' | 'this_month' | 'overdue' | 'no_date' };
    }
    const from = typeof value.from === 'string' && value.from.trim() ? value.from.trim() : undefined;
    const to = typeof value.to === 'string' && value.to.trim() ? value.to.trim() : undefined;
    return from || to ? { from, to } : undefined;
}

export function normalizeFilterCriteria(value: unknown): FilterCriteria {
    if (!isRecord(value)) return {};
    const criteria: FilterCriteria = {};

    const contexts = normalizeStringArray(value.contexts, { prefix: '@' });
    const areas = normalizeStringArray(value.areas);
    const projects = normalizeStringArray(value.projects);
    const tags = normalizeStringArray(value.tags, { prefix: '#' });
    const energy = normalizeEnumArray(value.energy, TASK_ENERGY_VALUES);
    const priority = normalizeEnumArray(value.priority, FILTER_PRIORITY_VALUES);
    const statuses = normalizeEnumArray(value.statuses, TASK_STATUS_VALUES);
    const assignedTo = normalizeStringArray(value.assignedTo);
    const timeEstimates = normalizeEnumArray(value.timeEstimates, TIME_ESTIMATE_VALUES);

    if (contexts) criteria.contexts = contexts;
    if (areas) criteria.areas = areas;
    if (projects) criteria.projects = projects;
    if (tags) criteria.tags = tags;
    if (energy) criteria.energy = energy;
    if (priority) criteria.priority = priority;
    if (statuses) criteria.statuses = statuses;
    if (assignedTo) criteria.assignedTo = assignedTo;
    if (timeEstimates) criteria.timeEstimates = timeEstimates;

    const dueDateRange = normalizeDateRange(value.dueDateRange);
    const startDateRange = normalizeDateRange(value.startDateRange);
    if (dueDateRange) criteria.dueDateRange = dueDateRange;
    if (startDateRange) criteria.startDateRange = startDateRange;

    if (isRecord(value.timeEstimateRange)) {
        const min = typeof value.timeEstimateRange.min === 'number' && Number.isFinite(value.timeEstimateRange.min)
            ? Math.max(0, Math.floor(value.timeEstimateRange.min))
            : undefined;
        const max = typeof value.timeEstimateRange.max === 'number' && Number.isFinite(value.timeEstimateRange.max)
            ? Math.max(0, Math.floor(value.timeEstimateRange.max))
            : undefined;
        if (min !== undefined || max !== undefined) {
            criteria.timeEstimateRange = { min, max };
        }
    }

    if (typeof value.hasDescription === 'boolean') criteria.hasDescription = value.hasDescription;
    if (typeof value.isStarred === 'boolean') criteria.isStarred = value.isStarred;

    return criteria;
}

export function hasActiveFilterCriteria(criteria: FilterCriteria | undefined): boolean {
    if (!criteria) return false;
    const normalized = normalizeFilterCriteria(criteria);
    return Boolean(
        normalized.contexts?.length
        || normalized.areas?.length
        || normalized.projects?.length
        || normalized.tags?.length
        || normalized.energy?.length
        || normalized.priority?.length
        || normalized.dueDateRange
        || normalized.startDateRange
        || normalized.statuses?.length
        || normalized.assignedTo?.length
        || normalized.timeEstimateRange
        || normalized.timeEstimates?.length
        || normalized.hasDescription !== undefined
        || normalized.isStarred !== undefined
    );
}

const matchesAnyToken = (selected: readonly string[] | undefined, actual: readonly string[] | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    const actualValues = actual ?? [];
    return selected.some((selectedToken) =>
        actualValues.some((actualToken) => matchesHierarchicalToken(selectedToken, actualToken))
    );
};

const matchesAllTokens = (selected: readonly string[] | undefined, actual: readonly string[] | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    const actualValues = actual ?? [];
    return selected.every((selectedToken) =>
        actualValues.some((actualToken) => matchesHierarchicalToken(selectedToken, actualToken))
    );
};

const matchesTokens = (
    selected: readonly string[] | undefined,
    actual: readonly string[] | undefined,
    mode: ApplyFilterOptions['tokenMatchMode'] = 'any'
): boolean => (
    mode === 'all'
        ? matchesAllTokens(selected, actual)
        : matchesAnyToken(selected, actual)
);

const matchesDateRange = (
    value: string | undefined,
    range: DateRange | undefined,
    parser: (input: string | undefined) => Date | null,
    options: Required<Pick<ApplyFilterOptions, 'now' | 'weekStartsOn'>>
): boolean => {
    if (!range) return true;
    if ('preset' in range && range.preset === 'no_date') {
        return !value;
    }
    if (!value) return false;
    const date = parser(value);
    if (!date) return false;

    if ('preset' in range) {
        const todayStart = startOfDay(options.now);
        switch (range.preset) {
            case 'today': {
                const todayEnd = endOfDay(options.now);
                return (isAfter(date, todayStart) || isEqual(date, todayStart))
                    && (isBefore(date, todayEnd) || isEqual(date, todayEnd));
            }
            case 'this_week': {
                const start = startOfWeek(options.now, { weekStartsOn: options.weekStartsOn });
                const end = endOfWeek(options.now, { weekStartsOn: options.weekStartsOn });
                return (isAfter(date, start) || isEqual(date, start))
                    && (isBefore(date, end) || isEqual(date, end));
            }
            case 'this_month': {
                const start = startOfMonth(options.now);
                const end = endOfMonth(options.now);
                return (isAfter(date, start) || isEqual(date, start))
                    && (isBefore(date, end) || isEqual(date, end));
            }
            case 'overdue':
                return isBefore(date, todayStart);
            case 'no_date':
                return false;
            default:
                return true;
        }
    }

    const from = range.from ? safeParseDate(range.from) : null;
    const to = range.to ? safeParseDate(range.to) : null;
    if (from) {
        const fromStart = startOfDay(from);
        if (isBefore(date, fromStart) && !isEqual(date, fromStart)) return false;
    }
    if (to) {
        const toEnd = endOfDay(to);
        if (isAfter(date, toEnd) && !isEqual(date, toEnd)) return false;
    }
    return true;
};

const matchesAssignedTo = (selected: readonly string[] | undefined, assignedTo: string | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    const normalized = assignedTo?.trim().toLowerCase();
    if (!normalized) return false;
    return selected.some((item) => item.trim().toLowerCase() === normalized);
};

const matchesPriority = (selected: readonly FilterPriority[] | undefined, priority: TaskPriority | undefined): boolean => {
    if (!selected || selected.length === 0) return true;
    return selected.some((item) => item === 'none' ? !priority : priority === item);
};

const matchesTimeEstimateRange = (
    range: FilterCriteria['timeEstimateRange'],
    estimate: TimeEstimate | undefined
): boolean => {
    if (!range) return true;
    if (!estimate) return false;
    const minutes = timeEstimateToMinutes(estimate);
    if (range.min !== undefined && minutes < range.min) return false;
    if (range.max !== undefined && minutes > range.max) return false;
    return true;
};

export function taskMatchesFilterCriteria(
    task: Task,
    criteria: FilterCriteria | undefined,
    options: ApplyFilterOptions = {}
): boolean {
    if (task.deletedAt) return false;
    const normalized = normalizeFilterCriteria(criteria);
    const projectById = options.projects ? new Map(options.projects.map((project) => [project.id, project])) : undefined;
    const now = options.now ?? new Date();
    const tokenMatchMode = options.tokenMatchMode ?? 'any';
    const weekStartsOn = options.weekStartsOn ?? 1;

    if (normalized.statuses?.length && !normalized.statuses.includes(task.status)) return false;
    if (!matchesTokens(normalized.contexts, task.contexts, tokenMatchMode)) return false;
    if (!matchesTokens(normalized.tags, task.tags, tokenMatchMode)) return false;

    if (normalized.areas?.length) {
        const projectAreaId = task.projectId ? projectById?.get(task.projectId)?.areaId : undefined;
        const taskAreaId = task.areaId ?? projectAreaId;
        if (!taskAreaId || !normalized.areas.includes(taskAreaId)) return false;
    }

    if (normalized.projects?.length) {
        const matchesProject = normalized.projects.some((projectId) => (
            projectId === SAVED_FILTER_NO_PROJECT_ID ? !task.projectId : task.projectId === projectId
        ));
        if (!matchesProject) return false;
    }

    if (normalized.energy?.length && (!task.energyLevel || !normalized.energy.includes(task.energyLevel))) return false;
    if (!matchesPriority(normalized.priority, task.priority)) return false;
    if (!matchesDateRange(task.dueDate, normalized.dueDateRange, safeParseDueDate, { now, weekStartsOn })) return false;
    if (!matchesDateRange(task.startTime, normalized.startDateRange, safeParseDate, { now, weekStartsOn })) return false;
    if (!matchesAssignedTo(normalized.assignedTo, task.assignedTo)) return false;
    if (normalized.timeEstimates?.length && (!task.timeEstimate || !normalized.timeEstimates.includes(task.timeEstimate))) return false;
    if (!matchesTimeEstimateRange(normalized.timeEstimateRange, task.timeEstimate)) return false;
    if (normalized.hasDescription !== undefined) {
        const hasDescription = Boolean(task.description?.trim());
        if (hasDescription !== normalized.hasDescription) return false;
    }
    if (normalized.isStarred !== undefined && Boolean(task.isFocusedToday) !== normalized.isStarred) return false;

    return true;
}

export function applyFilter<T extends Task>(
    tasks: readonly T[],
    criteria: FilterCriteria | undefined,
    options: ApplyFilterOptions = {}
): T[] {
    return tasks.filter((task) => taskMatchesFilterCriteria(task, criteria, options));
}

export function normalizeSavedFilter(value: unknown): SavedFilter | null {
    if (!isRecord(value)) return null;
    if (typeof value.id !== 'string' || !value.id.trim()) return null;
    if (typeof value.name !== 'string' || !value.name.trim()) return null;
    const view = typeof value.view === 'string' && SAVED_FILTER_VIEW_VALUES.has(value.view as SavedFilterView)
        ? value.view as SavedFilterView
        : 'focus';
    const createdAt = typeof value.createdAt === 'string' && value.createdAt.trim() ? value.createdAt : new Date().toISOString();
    const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.trim() ? value.updatedAt : createdAt;
    const sortBy = typeof value.sortBy === 'string' && SORT_FIELD_VALUES.has(value.sortBy as SortField)
        ? value.sortBy as SortField
        : undefined;
    const sortOrder = value.sortOrder === 'asc' || value.sortOrder === 'desc' ? value.sortOrder : undefined;
    const icon = typeof value.icon === 'string' && value.icon.trim() ? value.icon.trim() : undefined;
    const deletedAt = typeof value.deletedAt === 'string' && value.deletedAt.trim() ? value.deletedAt.trim() : undefined;

    return {
        id: value.id.trim(),
        name: value.name.trim(),
        ...(icon ? { icon } : {}),
        view,
        criteria: normalizeFilterCriteria(value.criteria),
        ...(sortBy ? { sortBy } : {}),
        ...(sortOrder ? { sortOrder } : {}),
        createdAt,
        updatedAt,
        ...(deletedAt ? { deletedAt } : {}),
    };
}

export function normalizeSavedFilters(value: unknown): SavedFilter[] {
    if (!Array.isArray(value)) return [];
    const byId = new Map<string, SavedFilter>();
    for (const item of value) {
        const normalized = normalizeSavedFilter(item);
        if (!normalized) continue;
        byId.set(normalized.id, normalized);
    }
    return Array.from(byId.values()).sort((a, b) => {
        const createdDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
        return a.name.localeCompare(b.name);
    });
}

export function markSavedFilterDeleted(
    filters: readonly SavedFilter[] | undefined,
    filterId: string,
    deletedAt: string = new Date().toISOString(),
): SavedFilter[] {
    return normalizeSavedFilters(filters).map((filter) => (
        filter.id === filterId
            ? { ...filter, updatedAt: deletedAt, deletedAt }
            : filter
    ));
}
