/**
 * Utility functions for task operations
 */

import { Task, TaskStatus, TaskSortBy, TaskPriority, Project, AppData, SortField } from './types';
import { isDueForReview, safeParseDate, safeParseDueDate } from './date';
import { timeEstimateToMinutes } from './calendar-scheduling';
import { TASK_STATUS_ORDER } from './task-status';
import { isTaskInActiveProject } from './project-utils';
import type { Language } from './i18n/i18n-types';

export function buildTasksByProjectId(tasks: readonly Task[]): Map<string, Task[]> {
    const tasksByProjectId = new Map<string, Task[]>();

    tasks.forEach((task) => {
        if (!task.projectId || task.deletedAt) return;

        const projectTasks = tasksByProjectId.get(task.projectId);
        if (projectTasks) {
            projectTasks.push(task);
        } else {
            tasksByProjectId.set(task.projectId, [task]);
        }
    });

    return tasksByProjectId;
}

/**
 * Status sorting order for task list display
 */
/**
 * Standard task colors for each status.
 * Used for badges, borders, and highlights across the app.
 */
export const STATUS_COLORS: Record<TaskStatus, { bg: string; text: string; border: string }> = {
    'inbox': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
    'next': { bg: '#3B82F620', text: '#2563EB', border: '#2563EB' },
    'waiting': { bg: '#F59E0B20', text: '#F59E0B', border: '#F59E0B' },
    'someday': { bg: '#8B5CF620', text: '#8B5CF6', border: '#8B5CF6' },
    'reference': { bg: '#0EA5E920', text: '#0EA5E9', border: '#0EA5E9' },
    'done': { bg: '#22C55E20', text: '#22C55E', border: '#22C55E' },
    'archived': { bg: '#6B728020', text: '#6B7280', border: '#6B7280' },
};

const TASK_PRIORITY_SORT_RANK: Record<TaskPriority, number> = {
    low: 1,
    medium: 2,
    high: 3,
    urgent: 4,
};

const TASK_ENERGY_SORT_RANK: Record<NonNullable<Task['energyLevel']>, number> = {
    low: 1,
    medium: 2,
    high: 3,
};

const timeEstimateSortRank = (estimate: Task['timeEstimate']): number => {
    if (!estimate) return Number.POSITIVE_INFINITY;
    if (estimate === '4hr+') return 241;
    return timeEstimateToMinutes(estimate);
};

export const FOCUS_NEXT_DUE_SOON_WINDOW_DAYS = 30;

type TaskStartVisibilityOptions = {
    now?: Date;
    showFutureStarts?: boolean;
};

type FocusSequentialOptions = {
    now?: Date;
    sectionScopedProjectIds?: ReadonlySet<string>;
};

export type TaskFocusEligibilityReason = 'eligible' | 'deferred' | 'sequential' | 'clarify';

export type TaskFocusEligibilityResult = {
    eligible: boolean;
    reason: TaskFocusEligibilityReason;
};

export type TaskFocusEligibilityOptions = {
    tasks: readonly Task[];
    projects: readonly Project[] | Map<string, Project>;
    now?: Date;
    showFutureStarts?: boolean;
    sequentialProjectIds?: ReadonlySet<string>;
    sectionScopedProjectIds?: ReadonlySet<string>;
};

type SequentialTaskOrderFields = Pick<Task, 'createdAt' | 'order' | 'orderNum'>;
type SequentialGroupingFields = Pick<Task, 'projectId'> & Partial<Pick<Task, 'sectionId'>>;

type SequentialFirstTaskOptions = {
    sectionScopedProjectIds?: ReadonlySet<string>;
};

const NO_SECTION_GROUP = '__no_section__';
export const FOCUS_ELIGIBILITY_ACTIVE_STATUSES: readonly TaskStatus[] = ['inbox', 'next', 'waiting', 'someday'];
const FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET = new Set<TaskStatus>(FOCUS_ELIGIBILITY_ACTIVE_STATUSES);

const safeTime = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const safeDueTime = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = safeParseDueDate(value);
    return parsed ? parsed.getTime() : fallback;
};

const shouldIncrementPushCount = (oldDueDate?: string, newDueDate?: string): boolean => {
    if (!oldDueDate || !newDueDate) return false;
    const oldTime = Date.parse(oldDueDate);
    const newTime = Date.parse(newDueDate);
    if (!Number.isFinite(oldTime) || !Number.isFinite(newTime)) return false;
    return newTime > oldTime;
};

const WAITING_FOR_LINE_REGEX = /^\s*waiting\s+for\s*[:：]\s*(.+?)\s*$/i;

type SortFocusNextActionsOptions = {
    now?: Date;
    dueSoonWindowDays?: number;
    prioritizeByPriority?: boolean;
    projectDeadlineBoosts?: ReadonlyMap<string, ProjectDeadlineBoost>;
    projects?: readonly Project[];
};

type SortTasksBySavedPreferenceOptions = {
    projects?: readonly Project[];
    prioritizeByPriority?: boolean;
    sortOrder?: 'asc' | 'desc';
};

function getFocusNextActionBucket(
    task: Pick<Task, 'dueDate'>,
    nowMs: number,
    dueSoonWindowMs: number,
): number {
    const dueMs = safeDueTime(task.dueDate, Number.NaN);
    if (!Number.isFinite(dueMs)) return 1;
    if (dueMs <= nowMs + dueSoonWindowMs) return 0;
    return 2;
}

export type ProjectDeadlineBoost = {
    projectDueDate: string;
    projectDueTime: number;
    projectId: string;
    projectOrder: number;
    projectTitle: string;
    isOverdue: boolean;
};

type ProjectDeadlineBoostProjectInfo = ProjectDeadlineBoost;

const getProjectOrder = (project: Pick<Project, 'order'>): number => (
    Number.isFinite(project.order) ? project.order : Number.POSITIVE_INFINITY
);

const getTaskOrder = (task: Pick<Task, 'order' | 'orderNum'>): number => (
    Number.isFinite(task.order)
        ? task.order as number
        : Number.isFinite(task.orderNum)
            ? task.orderNum as number
            : Number.POSITIVE_INFINITY
);

const compareProjectDeadlineBoostTasks = (
    a: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
    b: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
): number => {
    const orderA = getTaskOrder(a);
    const orderB = getTaskOrder(b);
    if (orderA !== orderB) return orderA - orderB;

    const createdDiff = safeTime(a.createdAt, Number.POSITIVE_INFINITY) - safeTime(b.createdAt, Number.POSITIVE_INFINITY);
    if (createdDiff !== 0) return createdDiff;

    const titleDiff = a.title.localeCompare(b.title);
    if (titleDiff !== 0) return titleDiff;

    return a.id.localeCompare(b.id);
};

const compareProjectDeadlineBoosts = (
    boostA: ProjectDeadlineBoost | undefined,
    boostB: ProjectDeadlineBoost | undefined,
    taskA: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
    taskB: Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'title'>,
): number => {
    if (boostA && !boostB) return -1;
    if (!boostA && boostB) return 1;
    if (!boostA || !boostB) return 0;

    if (boostA.projectDueTime !== boostB.projectDueTime) {
        return boostA.projectDueTime - boostB.projectDueTime;
    }
    if (boostA.projectOrder !== boostB.projectOrder) {
        return boostA.projectOrder - boostB.projectOrder;
    }

    const projectTitleDiff = boostA.projectTitle.localeCompare(boostB.projectTitle);
    if (projectTitleDiff !== 0) return projectTitleDiff;

    return compareProjectDeadlineBoostTasks(taskA, taskB);
};

export function getProjectDeadlineBoosts(
    tasks: readonly Task[],
    projects: readonly Project[],
    options: { now?: Date } = {},
): Map<string, ProjectDeadlineBoost> {
    const now = options.now ?? new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const projectInfoById = new Map<string, ProjectDeadlineBoostProjectInfo>();

    projects.forEach((project) => {
        if (project.deletedAt) return;
        if (project.status !== 'active' && project.isFocused !== true) return;
        const projectDue = safeParseDueDate(project.dueDate);
        if (!projectDue) return;
        const projectDueTime = projectDue.getTime();
        if (projectDueTime > endOfToday.getTime()) return;
        projectInfoById.set(project.id, {
            projectDueDate: project.dueDate as string,
            projectDueTime,
            projectId: project.id,
            projectOrder: getProjectOrder(project),
            projectTitle: project.title,
            isOverdue: projectDueTime < startOfToday.getTime(),
        });
    });

    if (projectInfoById.size === 0) return new Map();

    const selectedTaskByProjectId = new Map<string, Task>();
    tasks.forEach((task) => {
        if (task.status !== 'next') return;
        if (task.deletedAt) return;
        if (!task.projectId) return;
        if (task.dueDate || task.startTime) return;
        if (!projectInfoById.has(task.projectId)) return;

        const selectedTask = selectedTaskByProjectId.get(task.projectId);
        if (!selectedTask || compareProjectDeadlineBoostTasks(task, selectedTask) < 0) {
            selectedTaskByProjectId.set(task.projectId, task);
        }
    });

    const boosts = new Map<string, ProjectDeadlineBoost>();
    selectedTaskByProjectId.forEach((task, projectId) => {
        const info = projectInfoById.get(projectId);
        if (!info) return;
        boosts.set(task.id, info);
    });
    return boosts;
}

function getSequentialTaskOrderKey<T extends SequentialTaskOrderFields>(task: T, hasOrder: boolean): number {
    const taskOrder = Number.isFinite(task.order)
        ? (task.order as number)
        : Number.isFinite(task.orderNum)
            ? (task.orderNum as number)
            : Number.POSITIVE_INFINITY;
    return hasOrder
        ? taskOrder
        : (safeParseDate(task.createdAt)?.getTime() ?? Number.POSITIVE_INFINITY);
}

function getSequentialTaskGroupKey<T extends SequentialGroupingFields>(
    task: T,
    sectionScopedProjectIds?: ReadonlySet<string>,
): string | null {
    if (!task.projectId) return null;
    if (sectionScopedProjectIds?.has(task.projectId)) {
        return `${task.projectId}:${task.sectionId || NO_SECTION_GROUP}`;
    }
    return task.projectId;
}

export function rescheduleTask(task: Task, newDueDate?: string): Task {
    const next: Task = { ...task, dueDate: newDueDate };
    if (shouldIncrementPushCount(task.dueDate, newDueDate)) {
        next.pushCount = (task.pushCount ?? 0) + 1;
    } else if (typeof task.pushCount === 'number') {
        next.pushCount = task.pushCount;
    }
    return next;
}

export function extractWaitingPerson(description?: string): string | null {
    if (!description) return null;
    const lines = description.split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(WAITING_FOR_LINE_REGEX);
        if (!match) continue;
        const person = match[1]?.trim();
        if (person) return person;
    }
    return null;
}

export function getWaitingPerson(task: Pick<Task, 'assignedTo' | 'description'>): string | null {
    const assignedTo = task.assignedTo?.trim();
    if (assignedTo) return assignedTo;
    return extractWaitingPerson(task.description);
}

export function isTaskFutureStart(task: Pick<Task, 'startTime'>, now: Date = new Date()): boolean {
    const start = safeParseDate(task.startTime);
    if (!start) return false;

    const endOfToday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999,
    );
    return start > endOfToday;
}

export function shouldShowTaskForStart(
    task: Pick<Task, 'startTime'>,
    options: TaskStartVisibilityOptions = {},
): boolean {
    if (options.showFutureStarts === true) return true;
    return !isTaskFutureStart(task, options.now);
}

export function getSequentialFirstTaskIds<T extends Pick<Task, 'createdAt' | 'id' | 'order' | 'orderNum' | 'projectId'> & Partial<Pick<Task, 'sectionId'>>>(
    tasks: T[],
    sequentialProjectIds: ReadonlySet<string>,
    options: SequentialFirstTaskOptions = {},
): Set<string> {
    const tasksByGroup = new Map<string, T[]>();
    for (const task of tasks) {
        const groupKey = getSequentialTaskGroupKey(task, options.sectionScopedProjectIds);
        if (!groupKey || !task.projectId) continue;
        if (!sequentialProjectIds.has(task.projectId)) continue;
        const list = tasksByGroup.get(groupKey) ?? [];
        list.push(task);
        tasksByGroup.set(groupKey, list);
    }

    const firstTaskIds = new Set<string>();
    tasksByGroup.forEach((tasksForProject) => {
        const hasOrder = tasksForProject.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
        let firstTaskId: string | null = null;
        let bestKey = Number.POSITIVE_INFINITY;

        tasksForProject.forEach((task) => {
            const key = getSequentialTaskOrderKey(task, hasOrder);
            if (!firstTaskId || key < bestKey) {
                firstTaskId = task.id;
                bestKey = key;
            }
        });

        if (firstTaskId) firstTaskIds.add(firstTaskId);
    });

    return firstTaskIds;
}

export function isFocusSequentialCandidate(
    task: Pick<Task, 'isFocusedToday' | 'reviewAt' | 'status'>,
    options: FocusSequentialOptions = {},
): boolean {
    if (task.isFocusedToday === true) return true;
    if (task.status === 'next') return true;
    return isDueForReview(task.reviewAt, options.now);
}

function getFocusSequentialScheduleKey(
    task: Pick<Task, 'dueDate' | 'isFocusedToday' | 'reviewAt' | 'startTime'>,
    now: Date,
): { rank: number; time: number } {
    if (task.isFocusedToday === true) {
        return { rank: 0, time: 0 };
    }

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const startOfTodayMs = startOfToday.getTime();
    const endOfTodayMs = endOfToday.getTime();
    const dueMs = safeDueTime(task.dueDate, Number.NaN);
    const startMs = safeParseDate(task.startTime)?.getTime() ?? Number.NaN;
    const reviewMs = safeParseDate(task.reviewAt)?.getTime() ?? Number.NaN;
    let scheduledTime = Number.POSITIVE_INFINITY;

    if (Number.isFinite(dueMs) && dueMs <= endOfTodayMs) {
        scheduledTime = Math.min(scheduledTime, dueMs);
    }
    if (Number.isFinite(startMs) && startMs >= startOfTodayMs && startMs <= endOfTodayMs) {
        scheduledTime = Math.min(scheduledTime, startMs);
    }
    if (isDueForReview(task.reviewAt, now) && Number.isFinite(reviewMs)) {
        scheduledTime = Math.min(scheduledTime, reviewMs);
    }

    return Number.isFinite(scheduledTime)
        ? { rank: 1, time: scheduledTime }
        : { rank: 2, time: Number.POSITIVE_INFINITY };
}

export function getFocusSequentialFirstTaskIds<
    T extends Pick<Task, 'createdAt' | 'dueDate' | 'id' | 'isFocusedToday' | 'order' | 'orderNum' | 'projectId' | 'reviewAt' | 'startTime' | 'status'> & Partial<Pick<Task, 'sectionId'>>
>(
    tasks: T[],
    sequentialProjectIds: ReadonlySet<string>,
    options: FocusSequentialOptions = {},
): Set<string> {
    const now = options.now ?? new Date();
    const tasksByGroup = new Map<string, T[]>();
    for (const task of tasks) {
        const groupKey = getSequentialTaskGroupKey(task, options.sectionScopedProjectIds);
        if (!groupKey || !task.projectId) continue;
        if (!sequentialProjectIds.has(task.projectId)) continue;
        if (!isFocusSequentialCandidate(task, { now })) continue;
        const list = tasksByGroup.get(groupKey) ?? [];
        list.push(task);
        tasksByGroup.set(groupKey, list);
    }

    const firstTaskIds = new Set<string>();
    tasksByGroup.forEach((tasksForProject) => {
        const hasOrder = tasksForProject.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
        let firstTaskId: string | null = null;
        let bestScheduleRank = Number.POSITIVE_INFINITY;
        let bestScheduleTime = Number.POSITIVE_INFINITY;
        let bestOrderKey = Number.POSITIVE_INFINITY;

        tasksForProject.forEach((task) => {
            const scheduleKey = getFocusSequentialScheduleKey(task, now);
            const orderKey = getSequentialTaskOrderKey(task, hasOrder);
            const isBetter = !firstTaskId
                || scheduleKey.rank < bestScheduleRank
                || (
                    scheduleKey.rank === bestScheduleRank
                    && (
                        scheduleKey.time < bestScheduleTime
                        || (
                            scheduleKey.time === bestScheduleTime
                            && orderKey < bestOrderKey
                        )
                    )
                );

            if (isBetter) {
                firstTaskId = task.id;
                bestScheduleRank = scheduleKey.rank;
                bestScheduleTime = scheduleKey.time;
                bestOrderKey = orderKey;
            }
        });

        if (firstTaskId) firstTaskIds.add(firstTaskId);
    });

    return firstTaskIds;
}

const getFocusEligibilityProjectMap = (
    projects: readonly Project[] | Map<string, Project>,
): Map<string, Project> => {
    if (Array.isArray(projects)) {
        return new Map(projects.map((project) => [project.id, project]));
    }
    return projects as Map<string, Project>;
};

const getFocusEligibilitySequentialProjectIds = (
    projectMap: ReadonlyMap<string, Project>,
): { sequentialProjectIds: Set<string>; sectionScopedProjectIds: Set<string> } => {
    const sequentialProjectIds = new Set<string>();
    const sectionScopedProjectIds = new Set<string>();
    projectMap.forEach((project) => {
        if (!project.isSequential) return;
        sequentialProjectIds.add(project.id);
        if (project.sequentialScope === 'section') {
            sectionScopedProjectIds.add(project.id);
        }
    });
    return { sequentialProjectIds, sectionScopedProjectIds };
};

export function getTaskFocusEligibility(
    task: Task,
    options: TaskFocusEligibilityOptions,
): TaskFocusEligibilityResult {
    const now = options.now ?? new Date();
    const projectMap = getFocusEligibilityProjectMap(options.projects);
    const derivedSequential = options.sequentialProjectIds && options.sectionScopedProjectIds
        ? null
        : getFocusEligibilitySequentialProjectIds(projectMap);
    const sequentialProjectIds = options.sequentialProjectIds ?? derivedSequential?.sequentialProjectIds ?? new Set<string>();
    const sectionScopedProjectIds = options.sectionScopedProjectIds
        ?? derivedSequential?.sectionScopedProjectIds
        ?? new Set<string>();
    const activeFocusBaseTasks = options.tasks.filter((candidate) => (
        !candidate.deletedAt
        && FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET.has(candidate.status)
        && isTaskInActiveProject(candidate, projectMap)
    ));
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(
        activeFocusBaseTasks,
        sequentialProjectIds,
        { now, sectionScopedProjectIds },
    );
    const isSequentialBlocked = Boolean(
        task.projectId
        && sequentialProjectIds.has(task.projectId)
        && !sequentialFirstTaskIds.has(task.id),
    );
    const isVisibleForStart = shouldShowTaskForStart(task, {
        now,
        showFutureStarts: options.showFutureStarts,
    });
    const isVisibleActiveTask = isTaskInActiveProject(task, projectMap) && isVisibleForStart;
    const isReviewDueEligible = task.status !== 'inbox' && isDueForReview(task.reviewAt, now);
    const eligible = isVisibleActiveTask
        && !isSequentialBlocked
        && (task.status === 'next' || isReviewDueEligible);

    if (eligible) {
        return { eligible: true, reason: 'eligible' };
    }
    if (!isVisibleForStart) {
        return { eligible: false, reason: 'deferred' };
    }
    if (isSequentialBlocked) {
        return { eligible: false, reason: 'sequential' };
    }
    return { eligible: false, reason: 'clarify' };
}

/**
 * Sort tasks by status, due date, and creation time.
 * Order: inbox → next → waiting → someday → reference → done → archived
 * Within same status: tasks with due dates first (sorted by date), then by creation time (FIFO)
 */
export function sortTasks(tasks: Task[]): Task[] {
    return [...tasks].sort((a, b) => {
        // 1. Sort by Status
        const statusA = TASK_STATUS_ORDER[a.status] ?? 99;
        const statusB = TASK_STATUS_ORDER[b.status] ?? 99;

        if (statusA !== statusB) {
            return statusA - statusB;
        }

        // 2. Sort by Due Date (tasks with valid due dates first)
        const dueA = safeDueTime(a.dueDate, Number.NaN);
        const dueB = safeDueTime(b.dueDate, Number.NaN);
        const hasDueA = Number.isFinite(dueA);
        const hasDueB = Number.isFinite(dueB);
        if (hasDueA && !hasDueB) return -1;
        if (!hasDueA && hasDueB) return 1;
        if (hasDueA && hasDueB && dueA !== dueB) return dueA - dueB;

        // 3. Created At (oldest first for FIFO)
        return safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
    });
}

/**
 * Sort tasks by a user-selected sort option.
 * Falls back to default sortTasks when sortBy is 'default' or undefined.
 */
export function sortTasksBy(tasks: Task[], sortBy: TaskSortBy = 'default'): Task[] {
    if (!sortBy || sortBy === 'default') {
        return sortTasks(tasks);
    }

    const copy = [...tasks];

    const timeOrInfinity = (value?: string) => safeTime(value, Infinity);
    const dueOrInfinity = (value?: string) => safeDueTime(value, Infinity);
    const timeOrZero = (value?: string) => safeTime(value, 0);

    switch (sortBy) {
        case 'title':
            return copy.sort((a, b) => {
                const cmp = a.title.localeCompare(b.title);
                if (cmp !== 0) return cmp;
                return safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
            });
        case 'due':
            return copy.sort((a, b) => {
                const aDue = dueOrInfinity(a.dueDate);
                const bDue = dueOrInfinity(b.dueDate);
                if (aDue !== bDue) return aDue - bDue;
                return timeOrZero(a.createdAt) - timeOrZero(b.createdAt);
            });
        case 'start':
            return copy.sort((a, b) => {
                const aStart = timeOrInfinity(a.startTime);
                const bStart = timeOrInfinity(b.startTime);
                if (aStart !== bStart) return aStart - bStart;
                return timeOrZero(a.createdAt) - timeOrZero(b.createdAt);
            });
        case 'review':
            return copy.sort((a, b) => {
                const aReview = timeOrInfinity(a.reviewAt);
                const bReview = timeOrInfinity(b.reviewAt);
                if (aReview !== bReview) return aReview - bReview;
                return timeOrZero(a.createdAt) - timeOrZero(b.createdAt);
            });
        case 'created':
            return copy.sort((a, b) => timeOrZero(a.createdAt) - timeOrZero(b.createdAt));
        case 'created-desc':
            return copy.sort((a, b) => timeOrZero(b.createdAt) - timeOrZero(a.createdAt));
        default:
            return sortTasks(tasks);
    }
}

/**
 * Stable sort for Board columns: tasks with a manual boardOrder come first
 * in ascending order; tasks without one keep their incoming relative order.
 */
export function sortTasksByBoardOrder<T extends Pick<Task, 'boardOrder'>>(tasks: T[]): T[] {
    return [...tasks].sort((a, b) => {
        const aOrder = Number.isFinite(a.boardOrder) ? (a.boardOrder as number) : Number.POSITIVE_INFINITY;
        const bOrder = Number.isFinite(b.boardOrder) ? (b.boardOrder as number) : Number.POSITIVE_INFINITY;
        if (aOrder === bOrder) return 0;
        return aOrder - bOrder;
    });
}

export function splitCompletedTasks<T extends Pick<Task, 'status'>>(tasks: T[]): {
    activeTasks: T[];
    completedTasks: T[];
} {
    const activeTasks: T[] = [];
    const completedTasks: T[] = [];

    tasks.forEach((task) => {
        if (task.status === 'done') {
            completedTasks.push(task);
        } else {
            activeTasks.push(task);
        }
    });

    return { activeTasks, completedTasks };
}

function getCompletionListTime(task: Pick<Task, 'completedAt' | 'updatedAt' | 'createdAt'>): number {
    const completedAt = safeParseDate(task.completedAt)?.getTime();
    if (Number.isFinite(completedAt)) return completedAt as number;
    const updatedAt = safeParseDate(task.updatedAt)?.getTime();
    if (Number.isFinite(updatedAt)) return updatedAt as number;
    return safeParseDate(task.createdAt)?.getTime() ?? 0;
}

export function sortDoneTasksForListView<T extends Pick<Task, 'completedAt' | 'updatedAt' | 'createdAt' | 'title'>>(tasks: T[]): T[] {
    return [...tasks].sort((a, b) => {
        const completionDiff = getCompletionListTime(b) - getCompletionListTime(a);
        if (completionDiff !== 0) return completionDiff;
        return a.title.localeCompare(b.title);
    });
}

export function groupCompletedTasksLast<T extends Pick<Task, 'status'>>(tasks: T[]): T[] {
    const { activeTasks, completedTasks } = splitCompletedTasks(tasks);
    return [...activeTasks, ...completedTasks];
}

export function sortTasksBySavedPreference<T extends Task>(
    tasks: T[],
    sortBy: SortField | undefined,
    options: SortTasksBySavedPreferenceOptions = {},
): T[] {
    if (!sortBy || sortBy === 'default') {
        return [...tasks];
    }

    const projectOrder = new Map<string, number>();
    const projectTitle = new Map<string, string>();
    [...(options.projects ?? [])]
        .filter((project) => !project.deletedAt)
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.title.localeCompare(b.title);
        })
        .forEach((project, index) => {
            projectOrder.set(project.id, index);
            projectTitle.set(project.id, project.title);
        });

    const direction = options.sortOrder === 'desc' ? -1 : 1;
    const compare = (a: T, b: T): number => {
        const byCreatedAsc = () => safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
        const byCreatedDesc = () => safeTime(b.createdAt, 0) - safeTime(a.createdAt, 0);
        const byTitle = () => a.title.localeCompare(b.title);
        const byId = () => a.id.localeCompare(b.id);
        const byDue = () => safeDueTime(a.dueDate, Number.POSITIVE_INFINITY) - safeDueTime(b.dueDate, Number.POSITIVE_INFINITY);
        const byStart = () => safeTime(a.startTime, Number.POSITIVE_INFINITY) - safeTime(b.startTime, Number.POSITIVE_INFINITY);
        const byReview = () => safeTime(a.reviewAt, Number.POSITIVE_INFINITY) - safeTime(b.reviewAt, Number.POSITIVE_INFINITY);
        const byUpdated = () => safeTime(b.updatedAt, 0) - safeTime(a.updatedAt, 0);
        const byPriority = () => (TASK_PRIORITY_SORT_RANK[b.priority as TaskPriority] || 0)
            - (TASK_PRIORITY_SORT_RANK[a.priority as TaskPriority] || 0);
        const byEnergy = () => (TASK_ENERGY_SORT_RANK[b.energyLevel as NonNullable<Task['energyLevel']>] || 0)
            - (TASK_ENERGY_SORT_RANK[a.energyLevel as NonNullable<Task['energyLevel']>] || 0);
        const byTimeEstimate = () => timeEstimateSortRank(a.timeEstimate) - timeEstimateSortRank(b.timeEstimate);
        const byProject = () => {
            const orderA = a.projectId ? (projectOrder.get(a.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            const orderB = b.projectId ? (projectOrder.get(b.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            if (orderA !== orderB) return orderA - orderB;
            const titleA = a.projectId ? (projectTitle.get(a.projectId) ?? '') : '';
            const titleB = b.projectId ? (projectTitle.get(b.projectId) ?? '') : '';
            return titleA.localeCompare(titleB);
        };
        const withFallbacks = (...comparers: Array<() => number>) => {
            for (const comparer of comparers) {
                const result = comparer();
                if (result !== 0) return result;
            }
            return byId();
        };

        switch (sortBy) {
            case 'due':
                return withFallbacks(byDue, byCreatedAsc);
            case 'start':
                return options.prioritizeByPriority
                    ? withFallbacks(byStart, byPriority, byCreatedAsc)
                    : withFallbacks(byStart, byCreatedAsc);
            case 'review':
                return withFallbacks(byReview, byCreatedAsc);
            case 'title':
                return withFallbacks(byTitle, byCreatedAsc);
            case 'created':
                return withFallbacks(byCreatedAsc);
            case 'created-desc':
                return withFallbacks(byCreatedDesc);
            case 'priority':
                return withFallbacks(byPriority, byDue, byStart, byCreatedAsc);
            case 'energy':
                return withFallbacks(byEnergy, byDue, byStart, byCreatedAsc);
            case 'timeEstimate':
                return withFallbacks(byTimeEstimate, byDue, byStart, byCreatedAsc);
            case 'project':
                return withFallbacks(byProject, byCreatedAsc);
            case 'updated':
                return withFallbacks(byUpdated, byCreatedAsc);
            default:
                return withFallbacks(byCreatedAsc);
        }
    };

    return [...tasks].sort((a, b) => direction * compare(a, b));
}

export function sortFocusNextActions(tasks: Task[], options: SortFocusNextActionsOptions = {}): Task[] {
    const nowMs = (options.now ?? new Date()).getTime();
    const dueSoonWindowDays = Number.isFinite(options.dueSoonWindowDays)
        ? Math.max(0, Math.floor(options.dueSoonWindowDays as number))
        : FOCUS_NEXT_DUE_SOON_WINDOW_DAYS;
    const dueSoonWindowMs = dueSoonWindowDays * 24 * 60 * 60 * 1000;
    const prioritizeByPriority = options.prioritizeByPriority === true;
    const projectDeadlineBoosts = options.projectDeadlineBoosts
        ?? (options.projects ? getProjectDeadlineBoosts(tasks, options.projects, { now: options.now }) : new Map());

    return [...tasks].sort((a, b) => {
        const bucketA = getFocusNextActionBucket(a, nowMs, dueSoonWindowMs);
        const bucketB = getFocusNextActionBucket(b, nowMs, dueSoonWindowMs);
        if (bucketA !== bucketB) return bucketA - bucketB;

        if (bucketA !== 1) {
            const dueA = safeDueTime(a.dueDate, Number.POSITIVE_INFINITY);
            const dueB = safeDueTime(b.dueDate, Number.POSITIVE_INFINITY);
            if (dueA !== dueB) return dueA - dueB;
        }

        if (bucketA === 1) {
            const projectBoostDiff = compareProjectDeadlineBoosts(
                projectDeadlineBoosts.get(a.id),
                projectDeadlineBoosts.get(b.id),
                a,
                b,
            );
            if (projectBoostDiff !== 0) return projectBoostDiff;
        }

        if (prioritizeByPriority) {
            const priorityDiff = (TASK_PRIORITY_SORT_RANK[b.priority as TaskPriority] || 0)
                - (TASK_PRIORITY_SORT_RANK[a.priority as TaskPriority] || 0);
            if (priorityDiff !== 0) return priorityDiff;
        }

        const startA = safeTime(a.startTime, Number.POSITIVE_INFINITY);
        const startB = safeTime(b.startTime, Number.POSITIVE_INFINITY);
        if (startA !== startB) return startA - startB;

        const createdDiff = safeTime(a.createdAt, 0) - safeTime(b.createdAt, 0);
        if (createdDiff !== 0) return createdDiff;

        const titleDiff = a.title.localeCompare(b.title);
        if (titleDiff !== 0) return titleDiff;

        return a.id.localeCompare(b.id);
    });
}

export type CalendarPlanningCandidateOptions = {
    limit?: number;
    now?: Date;
    prioritizeByPriority?: boolean;
    projects?: readonly Project[] | Map<string, Project>;
    sectionScopedProjectIds?: ReadonlySet<string>;
    sequentialProjectIds?: ReadonlySet<string>;
};

export function getCalendarPlanningCandidates<T extends Task>(
    tasks: readonly T[],
    options: CalendarPlanningCandidateOptions = {},
): T[] {
    const now = options.now ?? new Date();
    const projectMap = options.projects ? getFocusEligibilityProjectMap(options.projects) : null;
    const derivedSequential = projectMap && (!options.sequentialProjectIds || !options.sectionScopedProjectIds)
        ? getFocusEligibilitySequentialProjectIds(projectMap)
        : null;
    const sequentialProjectIds = options.sequentialProjectIds
        ?? derivedSequential?.sequentialProjectIds
        ?? new Set<string>();
    const sectionScopedProjectIds = options.sectionScopedProjectIds
        ?? derivedSequential?.sectionScopedProjectIds
        ?? new Set<string>();

    const activeFocusTasks = tasks.filter((task) => (
        !task.deletedAt
        && FOCUS_ELIGIBILITY_ACTIVE_STATUS_SET.has(task.status)
        && (!projectMap || isTaskInActiveProject(task, projectMap))
    ));
    const sequentialFirstTaskIds = getFocusSequentialFirstTaskIds(
        activeFocusTasks,
        sequentialProjectIds,
        { now, sectionScopedProjectIds },
    );

    const candidates = tasks.filter((task) => {
        if (task.deletedAt) return false;
        if (task.status !== 'next') return false;
        if (task.isFocusedToday) return false;
        if (task.startTime) return false;
        if (projectMap && !isTaskInActiveProject(task, projectMap)) return false;
        if (task.projectId && sequentialProjectIds.has(task.projectId) && !sequentialFirstTaskIds.has(task.id)) return false;
        return true;
    });

    const sortProjects = Array.isArray(options.projects) ? options.projects : undefined;
    const sorted = sortFocusNextActions(candidates as Task[], {
        now,
        prioritizeByPriority: options.prioritizeByPriority,
        projects: sortProjects,
    }) as T[];
    const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit as number)) : sorted.length;
    return sorted.slice(0, limit);
}

/**
 * Get display color for a task status
 */
export function getStatusColor(status: TaskStatus): { bg: string; text: string; border: string } {
    return STATUS_COLORS[status] || STATUS_COLORS['inbox'];
}

/**
 * Calculate the age of a task in days
 */
export function getTaskAgeDays(createdAt: string): number {
    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - created.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Get a human-readable age string for a task
 * Returns null for tasks < 1 day old (to avoid clutter)
 */
export function getTaskAgeLabel(createdAt: string, lang: Language = 'en'): string | null {
    const days = getTaskAgeDays(createdAt);
    const isChinese = lang === 'zh' || lang === 'zh-Hant';

    if (days < 1) return null;
    if (isChinese) {
        if (days === 1) return '1天前';
        if (days < 7) return `${days}天前`;
        if (days < 14) return '1周前';
        if (days < 30) return `${Math.floor(days / 7)}周前`;
        if (days < 60) return '1个月前';
        return `${Math.floor(days / 30)}个月前`;
    }

    if (days === 1) return '1 day old';
    if (days < 7) return `${days} days old`;
    if (days < 14) return '1 week old';
    if (days < 30) return `${Math.floor(days / 7)} weeks old`;
    if (days < 60) return '1 month old';
    return `${Math.floor(days / 30)} months old`;
}

/**
 * Get the staleness level of a task (for color coding)
 * Returns: 'fresh' | 'aging' | 'stale' | 'very-stale'
 */
export function getTaskStaleness(createdAt: string): 'fresh' | 'aging' | 'stale' | 'very-stale' {
    const days = getTaskAgeDays(createdAt);

    if (days < 7) return 'fresh';
    if (days < 14) return 'aging';
    if (days < 30) return 'stale';
    return 'very-stale';
}

/**
 * Get the urgency level of a task based on due date
 * Returns: 'overdue' | 'urgent' (24h) | 'upcoming' (72h) | 'normal' | 'done'
 */
export function getTaskUrgency(task: Partial<Task>): 'overdue' | 'urgent' | 'upcoming' | 'normal' | 'done' {
    if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return 'done';
    if (!task.dueDate) return 'normal';

    const now = new Date();
    const due = safeParseDueDate(task.dueDate);
    if (!due) return 'normal';
    const diffHours = (due.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (diffHours < 0) return 'overdue';
    if (diffHours < 24) return 'urgent';
    if (diffHours < 72) return 'upcoming';
    return 'normal';
}

export function getTaskAreaId(
    task: Pick<Task, 'areaId' | 'projectId'>,
    projectMap?: Map<string, Project> | Record<string, Project>,
): string | undefined {
    if (task.projectId && projectMap) {
        const project = projectMap instanceof Map ? projectMap.get(task.projectId) : projectMap[task.projectId];
        if (project?.areaId) return project.areaId;
    }
    return task.areaId;
}

export type SpeechResultLike = {
    transcript?: string | null;
    title?: string | null;
    description?: string | null;
    dueDate?: string | null;
    startTime?: string | null;
    tags?: string[] | null;
    contexts?: string[] | null;
    projectTitle?: string | null;
};

export type SpeechUpdatePlan = {
    updates: Partial<Task>;
    suggestedProjectTitle?: string;
};

const normalizeSpeechTranscriptForTask = (transcript: string | null | undefined): string | undefined => {
    const trimmed = transcript?.trim();
    if (!trimmed) return undefined;

    const parseStructuredTranscript = (candidate: string): string | undefined | null => {
        try {
            const parsed = JSON.parse(candidate) as unknown;
            if (!parsed || typeof parsed !== 'object') return null;
            const text = (parsed as { text?: unknown; transcript?: unknown }).text
                ?? (parsed as { transcript?: unknown }).transcript;
            if (typeof text !== 'string') return null;
            const normalized = text.trim();
            return normalized || undefined;
        } catch {
            return null;
        }
    };

    const direct = parseStructuredTranscript(trimmed);
    if (direct !== null) return direct;

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        const embedded = parseStructuredTranscript(trimmed.slice(objectStart, objectEnd + 1));
        if (embedded !== null) return embedded;
    }

    if (/^(?:\[\s*[^\]]+?\s*\]\s*)+$/.test(trimmed)) {
        return undefined;
    }

    return trimmed;
};

export function buildTaskUpdatesFromSpeechResult(
    existing: Pick<Task, 'title' | 'description' | 'dueDate' | 'startTime' | 'tags' | 'contexts' | 'projectId'>,
    result: SpeechResultLike,
    settings?: AppData['settings'],
): SpeechUpdatePlan {
    const updates: Partial<Task> = {};
    const mode = settings?.ai?.speechToText?.mode ?? 'smart_parse';
    const fieldStrategy = settings?.ai?.speechToText?.fieldStrategy ?? 'smart';
    const transcript = normalizeSpeechTranscriptForTask(result.transcript);

    if (mode === 'transcribe_only') {
        if (transcript) {
            if (fieldStrategy === 'description_only') {
                updates.description = transcript;
            } else if (fieldStrategy === 'title_only') {
                updates.title = transcript;
            } else {
                const wordCount = transcript.split(/\s+/).filter(Boolean).length;
                if (wordCount <= 15) {
                    updates.title = transcript;
                } else {
                    updates.description = transcript;
                }
            }
        }
    } else {
        if (result.title && result.title.trim()) updates.title = result.title.trim();
        if (result.description !== undefined && result.description !== null) {
            const description = result.description.trim();
            updates.description = description ? description : undefined;
        }
        if (!updates.title && transcript) {
            if (fieldStrategy === 'description_only') {
                updates.description = transcript;
            } else if (fieldStrategy === 'title_only') {
                updates.title = transcript;
            } else {
                const wordCount = transcript.split(/\s+/).filter(Boolean).length;
                if (wordCount <= 15) {
                    updates.title = transcript;
                } else {
                    const words = transcript.split(/\s+/).filter(Boolean);
                    updates.title = `${words.slice(0, 7).join(' ')}...`;
                    if (!updates.description) {
                        updates.description = transcript;
                    }
                }
            }
        }
    }

    if (result.dueDate) {
        const parsed = safeParseDate(result.dueDate);
        if (parsed) updates.dueDate = parsed.toISOString();
    }
    if (result.startTime) {
        const parsed = safeParseDate(result.startTime);
        if (parsed) updates.startTime = parsed.toISOString();
    }

    const normalizeList = (items: string[] | null | undefined, prefix: string) => {
        if (!Array.isArray(items)) return [];
        return items
            .map((item) => item.trim())
            .filter(Boolean)
            .map((item) => (item.startsWith(prefix) ? item : `${prefix}${item}`));
    };

    const nextTags = normalizeList(result.tags ?? [], '#');
    const nextContexts = normalizeList(result.contexts ?? [], '@');
    if (nextTags.length) {
        updates.tags = Array.from(new Set([...(existing.tags ?? []), ...nextTags]));
    }
    if (nextContexts.length) {
        updates.contexts = Array.from(new Set([...(existing.contexts ?? []), ...nextContexts]));
    }

    const suggestedProjectTitle = result.projectTitle && !existing.projectId
        ? result.projectTitle.trim()
        : '';

    return {
        updates,
        suggestedProjectTitle: suggestedProjectTitle || undefined,
    };
}

/**
 * Get checklist progress for display.
 * Returns null if no checklist or checklist is empty.
 */
export function getChecklistProgress(task: Pick<Task, 'checklist'>): { completed: number; total: number; percent: number } | null {
    const list = task.checklist || [];
    if (list.length === 0) return null;
    const completed = list.filter((i) => i.isCompleted).length;
    const total = list.length;
    const percent = total === 0 ? 0 : completed / total;
    return { completed, total, percent };
}
