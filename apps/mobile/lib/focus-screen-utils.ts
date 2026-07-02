import {
    getUsedTaskTokens,
    formatTimeEstimateLabel,
    matchesHierarchicalToken,
    SAVED_FILTER_NO_PROJECT_ID,
    timeEstimateToFilterBucket,
    type Task,
    type TaskEnergyLevel,
    type TaskPriority,
    type TimeEstimate,
} from '@mindwtr/core';

export function splitFocusedTasks<T extends Pick<Task, 'isFocusedToday'>>(tasks: T[]): {
    focusedTasks: T[];
    otherTasks: T[];
} {
    const focusedTasks: T[] = [];
    const otherTasks: T[] = [];

    tasks.forEach((task) => {
        if (task.isFocusedToday) {
            focusedTasks.push(task);
            return;
        }

        otherTasks.push(task);
    });

    return { focusedTasks, otherTasks };
}

export const NO_PROJECT_FILTER_ID = SAVED_FILTER_NO_PROJECT_ID;

export type FocusTaskFilters = {
    tokens: string[];
    projects: string[];
    locations: string[];
    priorities: TaskPriority[];
    energyLevels: TaskEnergyLevel[];
    timeEstimates: TimeEstimate[];
};

export function getFocusTokenOptions(tasks: Task[]): string[] {
    return getUsedTaskTokens(tasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])]);
}

export type FocusContextTaskGroup = {
    id: string;
    title: string;
    tasks: Task[];
    muted?: boolean;
};

export function groupFocusTasksByContext(tasks: Task[], noContextLabel: string): FocusContextTaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noContextTasks: Task[] = [];

    tasks.forEach((task) => {
        const contexts = (task.contexts ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (contexts.length === 0) {
            noContextTasks.push(task);
            return;
        }

        Array.from(new Set(contexts)).forEach((context) => {
            const contextTasks = grouped.get(context) ?? [];
            contextTasks.push(task);
            grouped.set(context, contextTasks);
        });
    });

    const groups: FocusContextTaskGroup[] = [];
    if (noContextTasks.length > 0) {
        groups.push({
            id: 'context:none',
            title: noContextLabel,
            tasks: noContextTasks,
            muted: true,
        });
    }

    [...grouped.keys()]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .forEach((context) => {
            groups.push({
                id: `context:${context}`,
                title: context,
                tasks: grouped.get(context) ?? [],
            });
        });

    return groups;
}

export function groupFocusTasksByTag(tasks: Task[], noTagLabel: string): FocusContextTaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noTagTasks: Task[] = [];

    tasks.forEach((task) => {
        const tags = (task.tags ?? [])
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
        if (tags.length === 0) {
            noTagTasks.push(task);
            return;
        }

        Array.from(new Set(tags)).forEach((tag) => {
            const tagTasks = grouped.get(tag) ?? [];
            tagTasks.push(task);
            grouped.set(tag, tagTasks);
        });
    });

    const groups: FocusContextTaskGroup[] = [];
    if (noTagTasks.length > 0) {
        groups.push({
            id: 'tag:none',
            title: noTagLabel,
            tasks: noTagTasks,
            muted: true,
        });
    }

    [...grouped.keys()]
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .forEach((tag) => {
            groups.push({
                id: `tag:${tag}`,
                title: tag,
                tasks: grouped.get(tag) ?? [],
            });
        });

    return groups;
}

export function taskMatchesFocusFilters(
    task: Pick<Task, 'contexts' | 'tags' | 'projectId' | 'location' | 'priority' | 'energyLevel' | 'timeEstimate'>,
    filters: FocusTaskFilters,
): boolean {
    const taskTokens = [...(task.contexts ?? []), ...(task.tags ?? [])];

    if (filters.tokens.length > 0) {
        const matchesAllTokens = filters.tokens.every((token) =>
            taskTokens.some((taskToken) => matchesHierarchicalToken(token, taskToken))
        );
        if (!matchesAllTokens) return false;
    }

    if (filters.projects.length > 0) {
        const matchesProject = filters.projects.some((selectedProjectId) => (
            selectedProjectId === NO_PROJECT_FILTER_ID
                ? !task.projectId
                : task.projectId === selectedProjectId
        ));
        if (!matchesProject) return false;
    }

    if (filters.locations.length > 0) {
        const normalizedLocation = task.location?.trim().toLowerCase();
        if (!normalizedLocation) return false;
        const matchesLocation = filters.locations.some((location) =>
            normalizedLocation.includes(location.trim().toLowerCase())
        );
        if (!matchesLocation) return false;
    }

    if (filters.priorities.length > 0 && (!task.priority || !filters.priorities.includes(task.priority))) {
        return false;
    }

    if (filters.energyLevels.length > 0 && (!task.energyLevel || !filters.energyLevels.includes(task.energyLevel))) {
        return false;
    }

    if (filters.timeEstimates.length > 0) {
        const bucket = timeEstimateToFilterBucket(task.timeEstimate);
        if (!bucket || !filters.timeEstimates.includes(bucket)) {
            return false;
        }
    }

    return true;
}

export function formatFocusTimeEstimateLabel(value: TimeEstimate): string {
    return formatTimeEstimateLabel(value);
}
