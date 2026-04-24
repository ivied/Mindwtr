import { DEFAULT_AREA_COLOR } from '@mindwtr/core';
import type { Area, Project, Task } from '@mindwtr/core';
import { getContextColor } from '../../../lib/context-color';

export type NextGroupBy = 'none' | 'context' | 'area' | 'project';

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
        const primaryContext = (task.contexts ?? [])
            .map((value) => value.trim())
            .find((value) => value.length > 0);
        if (!primaryContext) {
            noContextTasks.push(task);
            return;
        }
        const contextTasks = grouped.get(primaryContext) ?? [];
        contextTasks.push(task);
        grouped.set(primaryContext, contextTasks);
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
