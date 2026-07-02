import { DEFAULT_AREA_COLOR } from '@mindwtr/core';
import type { Area, Project, Task, TaskEnergyLevel, TaskPriority } from '@mindwtr/core';
import { getContextColor } from '../../../lib/context-color';

export type NextGroupBy = 'none' | 'context' | 'area' | 'project' | 'energy' | 'priority' | 'person' | 'tag';
export type ReferenceGroupBy = 'none' | 'context' | 'area' | 'project' | 'tag';
export type TaskListGroupBy = NextGroupBy | ReferenceGroupBy;

/**
 * AI Agent lane grouping. Sections render in this exact order so the user's
 * attention lands on stuff that needs action (Review/Error) before the
 * passive backlog (Queued).
 */
const AI_STAGE_ORDER: ReadonlyArray<{ stage: string; title: string; dotColor: string }> = [
    { stage: 'review', title: '✅ Review', dotColor: '#10b981' },
    { stage: 'error', title: '❌ Error', dotColor: '#ef4444' },
    { stage: 'doing', title: '⏳ Doing', dotColor: '#f59e0b' },
    { stage: 'queued', title: '📥 Queued', dotColor: '#6b7280' },
];

function readAiStage(task: Task): string | null {
    const tag = (task.tags ?? []).find((t) => t.startsWith('ai-stage:'));
    return tag ? tag.slice('ai-stage:'.length) : null;
}

export function groupTasksByAiStage({ tasks }: { tasks: Task[] }): TaskGroup[] {
    const buckets = new Map<string, Task[]>();
    for (const task of tasks) {
        const stage = readAiStage(task);
        // No ai-stage tag → the task has left the agent flow (accepted/done,
        // rejected/archived, or never routed). Drop it from the lane.
        if (stage === null) continue;
        const bucket = buckets.get(stage) ?? [];
        bucket.push(task);
        buckets.set(stage, bucket);
    }
    const groups: TaskGroup[] = [];
    const seen = new Set<string>();
    for (const def of AI_STAGE_ORDER) {
        const items = buckets.get(def.stage);
        seen.add(def.stage);
        if (!items || items.length === 0) continue;
        groups.push({
            id: `ai-stage:${def.stage}`,
            title: `${def.title} (${items.length})`,
            tasks: items,
            dotColor: def.dotColor,
        });
    }
    // Anything we don't recognise (e.g. future "paused" stage) ends up in
    // an "Other" bucket so it's still visible rather than silently dropped.
    for (const [stage, items] of buckets) {
        if (seen.has(stage)) continue;
        groups.push({
            id: `ai-stage:${stage}`,
            title: `${stage} (${items.length})`,
            tasks: items,
            dotColor: '#9ca3af',
        });
    }
    return groups;
}

export interface TaskGroup {
    id: string;
    title: string;
    tasks: Task[];
    muted?: boolean;
    dotColor?: string;
}

interface GroupByAreaParams {
    areas: Area[];
    tasks: Task[];
    projectMap: Map<string, Project>;
    generalLabel: string;
}

interface GroupByContextParams {
    tasks: Task[];
    noContextLabel: string;
}

interface GroupByProjectParams {
    tasks: Task[];
    projectMap: Map<string, Project>;
    noProjectLabel: string;
}

interface GroupByTagParams {
    tasks: Task[];
    noTagLabel: string;
}

interface GroupByPriorityParams {
    tasks: Task[];
    getPriorityLabel: (priority: TaskPriority) => string;
    noPriorityLabel: string;
}

interface GroupByEnergyParams {
    tasks: Task[];
    getEnergyLabel: (energy: TaskEnergyLevel) => string;
    noEnergyLabel: string;
}

interface GroupByPersonParams {
    tasks: Task[];
    unassignedLabel: string;
}

const PRIORITY_GROUP_ORDER: TaskPriority[] = ['urgent', 'high', 'medium', 'low'];
const ENERGY_GROUP_ORDER: TaskEnergyLevel[] = ['high', 'medium', 'low'];

export function groupTasksByArea({
    areas,
    tasks,
    projectMap,
    generalLabel,
}: GroupByAreaParams): TaskGroup[] {
    const activeAreas = [...areas]
        .filter((area) => !area.deletedAt)
        .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
    const validAreaIds = new Set(activeAreas.map((area) => area.id));
    const grouped = new Map<string, Task[]>();
    const generalTasks: Task[] = [];

    tasks.forEach((task) => {
        const projectAreaId = task.projectId ? projectMap.get(task.projectId)?.areaId : undefined;
        const resolvedAreaId = task.areaId || projectAreaId;
        if (resolvedAreaId && validAreaIds.has(resolvedAreaId)) {
            const items = grouped.get(resolvedAreaId) ?? [];
            items.push(task);
            grouped.set(resolvedAreaId, items);
            return;
        }
        generalTasks.push(task);
    });

    const groups: TaskGroup[] = [];
    if (generalTasks.length > 0) {
        groups.push({
            id: 'general',
            title: generalLabel,
            tasks: generalTasks,
            muted: true,
        });
    }

    activeAreas.forEach((area) => {
        const areaTasks = grouped.get(area.id) ?? [];
        if (areaTasks.length === 0) return;
        groups.push({
            id: `area:${area.id}`,
            title: area.name,
            tasks: areaTasks,
            dotColor: area.color || DEFAULT_AREA_COLOR,
        });
    });
    return groups;
}

export function groupTasksByContext({
    tasks,
    noContextLabel,
}: GroupByContextParams): TaskGroup[] {
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

    const groups: TaskGroup[] = [];
    if (noContextTasks.length > 0) {
        groups.push({
            id: 'context:none',
            title: noContextLabel,
            tasks: noContextTasks,
            muted: true,
        });
    }

    const sortedContexts = [...grouped.keys()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    sortedContexts.forEach((context) => {
        const contextTasks = grouped.get(context) ?? [];
        groups.push({
            id: `context:${context}`,
            title: context,
            tasks: contextTasks,
            dotColor: getContextColor(context),
        });
    });
    return groups;
}

export function groupTasksByPriority({
    tasks,
    getPriorityLabel,
    noPriorityLabel,
}: GroupByPriorityParams): TaskGroup[] {
    const grouped = new Map<TaskPriority, Task[]>();
    const noPriorityTasks: Task[] = [];

    tasks.forEach((task) => {
        if (!task.priority) {
            noPriorityTasks.push(task);
            return;
        }
        const priorityTasks = grouped.get(task.priority) ?? [];
        priorityTasks.push(task);
        grouped.set(task.priority, priorityTasks);
    });

    const groups: TaskGroup[] = [];
    PRIORITY_GROUP_ORDER.forEach((priority) => {
        const priorityTasks = grouped.get(priority) ?? [];
        if (priorityTasks.length === 0) return;
        groups.push({
            id: `priority:${priority}`,
            title: getPriorityLabel(priority),
            tasks: priorityTasks,
        });
    });

    if (noPriorityTasks.length > 0) {
        groups.push({
            id: 'priority:none',
            title: noPriorityLabel,
            tasks: noPriorityTasks,
            muted: true,
        });
    }

    return groups;
}

export function groupTasksByEnergy({
    tasks,
    getEnergyLabel,
    noEnergyLabel,
}: GroupByEnergyParams): TaskGroup[] {
    const grouped = new Map<TaskEnergyLevel, Task[]>();
    const noEnergyTasks: Task[] = [];

    tasks.forEach((task) => {
        if (!task.energyLevel) {
            noEnergyTasks.push(task);
            return;
        }
        const energyTasks = grouped.get(task.energyLevel) ?? [];
        energyTasks.push(task);
        grouped.set(task.energyLevel, energyTasks);
    });

    const groups: TaskGroup[] = [];
    ENERGY_GROUP_ORDER.forEach((energy) => {
        const energyTasks = grouped.get(energy) ?? [];
        if (energyTasks.length === 0) return;
        groups.push({
            id: `energy:${energy}`,
            title: getEnergyLabel(energy),
            tasks: energyTasks,
        });
    });

    if (noEnergyTasks.length > 0) {
        groups.push({
            id: 'energy:none',
            title: noEnergyLabel,
            tasks: noEnergyTasks,
            muted: true,
        });
    }

    return groups;
}

export function groupTasksByProject({
    tasks,
    projectMap,
    noProjectLabel,
}: GroupByProjectParams): TaskGroup[] {
    const grouped = new Map<string, Task[]>();
    const noProjectTasks: Task[] = [];

    tasks.forEach((task) => {
        if (!task.projectId) {
            noProjectTasks.push(task);
            return;
        }
        const project = projectMap.get(task.projectId);
        if (!project) {
            noProjectTasks.push(task);
            return;
        }
        const projectTasks = grouped.get(project.id) ?? [];
        projectTasks.push(task);
        grouped.set(project.id, projectTasks);
    });

    const groups: TaskGroup[] = [];
    if (noProjectTasks.length > 0) {
        groups.push({
            id: 'project:none',
            title: noProjectLabel,
            tasks: noProjectTasks,
            muted: true,
        });
    }

    const sortedProjects = [...grouped.keys()]
        .map((projectId) => projectMap.get(projectId))
        .filter((project): project is Project => Boolean(project))
        .sort((a, b) => {
            const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.title.localeCompare(b.title);
        });

    sortedProjects.forEach((project) => {
        const projectTasks = grouped.get(project.id) ?? [];
        groups.push({
            id: `project:${project.id}`,
            title: project.title,
            tasks: projectTasks,
            dotColor: project.color,
        });
    });

    return groups;
}

export function groupTasksByPerson({
    tasks,
    unassignedLabel,
}: GroupByPersonParams): TaskGroup[] {
    const grouped = new Map<string, { name: string; tasks: Task[] }>();
    const unassignedTasks: Task[] = [];

    tasks.forEach((task) => {
        const name = task.assignedTo?.trim();
        if (!name) {
            unassignedTasks.push(task);
            return;
        }
        const key = name.toLowerCase();
        const entry = grouped.get(key) ?? { name, tasks: [] };
        entry.tasks.push(task);
        grouped.set(key, entry);
    });

    const groups: TaskGroup[] = [];
    const sortedPeople = [...grouped.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    sortedPeople.forEach((entry) => {
        groups.push({
            id: `person:${entry.name.toLowerCase()}`,
            title: entry.name,
            tasks: entry.tasks,
        });
    });
    if (unassignedTasks.length > 0) {
        groups.push({
            id: 'person:none',
            title: unassignedLabel,
            tasks: unassignedTasks,
            muted: true,
        });
    }
    return groups;
}

export function groupTasksByTag({
    tasks,
    noTagLabel,
}: GroupByTagParams): TaskGroup[] {
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

    const groups: TaskGroup[] = [];
    if (noTagTasks.length > 0) {
        groups.push({
            id: 'tag:none',
            title: noTagLabel,
            tasks: noTagTasks,
            muted: true,
        });
    }

    const sortedTags = [...grouped.keys()].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
    );
    sortedTags.forEach((tag) => {
        const tagTasks = grouped.get(tag) ?? [];
        groups.push({
            id: `tag:${tag}`,
            title: tag,
            tasks: tagTasks,
            dotColor: getContextColor(tag),
        });
    });
    return groups;
}
