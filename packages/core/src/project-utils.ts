import type { Project, Task, TaskStatus } from './types';

const CLOSED_PROJECT_TASK_STATUSES = new Set<TaskStatus>(['done', 'archived', 'reference']);

const getTaskProjectOrder = (task: Task): number => {
    if (Number.isFinite(task.order)) return task.order as number;
    if (Number.isFinite(task.orderNum)) return task.orderNum as number;
    return Number.POSITIVE_INFINITY;
};

const isOpenProjectTask = (task: Task): boolean => {
    return !task.deletedAt && !CLOSED_PROJECT_TASK_STATUSES.has(task.status);
};

export function isSelectableProjectForTaskAssignment(project: Project): boolean {
    const status = String(project.status);
    return !project.deletedAt && status !== 'archived' && status !== 'completed';
}

export function isTaskInActiveProject(
    task: Task,
    projectLookup: Map<string, Project> | Record<string, Project>
): boolean {
    if (!task.projectId) return true;
    const project =
        projectLookup instanceof Map
            ? projectLookup.get(task.projectId)
            : projectLookup[task.projectId];
    if (!project) return true;
    if (project.deletedAt) return false;
    return project.status === 'active' || project.isFocused === true;
}

export function projectHasNextAction(project: Project, tasks: Task[], excludeTaskId?: string): boolean {
    return tasks.some(t =>
        t.id !== excludeTaskId &&
        t.projectId === project.id &&
        !t.deletedAt &&
        t.status === 'next'
    );
}

export function filterProjectsNeedingNextAction(projects: Project[], tasks: Task[]): Project[] {
    return projects.filter(p => p.status === 'active' && !p.deletedAt && !projectHasNextAction(p, tasks));
}

export function getProjectNextActionCandidates(
    projectId: string,
    tasks: Task[],
    excludeTaskId?: string
): Task[] {
    return tasks
        .filter((task) => (
            task.id !== excludeTaskId &&
            task.projectId === projectId &&
            isOpenProjectTask(task) &&
            task.status !== 'next'
        ))
        .sort((a, b) => {
            const orderDiff = getTaskProjectOrder(a) - getTaskProjectOrder(b);
            if (Number.isFinite(orderDiff) && orderDiff !== 0) return orderDiff;
            const createdDiff = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
            if (createdDiff !== 0) return createdDiff;
            return a.title.localeCompare(b.title);
        });
}

export function getProjectNextActionPromptData(
    completedTask: Task,
    tasks: Task[],
    projects: Project[]
): { project: Project; candidates: Task[] } | null {
    if (!completedTask.projectId || completedTask.deletedAt || completedTask.status !== 'done') {
        return null;
    }

    const project = projects.find((candidate) => candidate.id === completedTask.projectId);
    if (!project || project.deletedAt || project.status !== 'active') {
        return null;
    }

    if (projectHasNextAction(project, tasks, completedTask.id)) {
        return null;
    }

    return {
        project,
        candidates: getProjectNextActionCandidates(project.id, tasks, completedTask.id),
    };
}

export function shouldPromptForProjectNextAction(
    completedTask: Task,
    tasks: Task[],
    projects: Project[]
): boolean {
    return getProjectNextActionPromptData(completedTask, tasks, projects) !== null;
}

export function getProjectsByArea(projects: Project[], areaId: string): Project[] {
    return projects
        .filter(p => !p.deletedAt && p.areaId === areaId)
        .sort((a, b) => a.title.localeCompare(b.title));
}

export function filterProjectsBySelectedArea(projects: Project[], selectedAreaId?: string): Project[] {
    return projects.filter((project) => {
        if (!isSelectableProjectForTaskAssignment(project)) return false;
        if (!selectedAreaId) return true;
        return project.areaId === selectedAreaId;
    });
}

export const getProjectsByTag = (projects: Project[], tagId: string): Project[] => {
    return projects
        .filter(p => !p.deletedAt && (p.tagIds || []).includes(tagId))
        .sort((a, b) => a.title.localeCompare(b.title));
};
