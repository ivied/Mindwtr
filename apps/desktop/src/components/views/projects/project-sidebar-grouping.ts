import type { Project } from '@mindwtr/core';

export function splitProjectsForSidebar(projects: Project[]) {
    const active: Project[] = [];
    const deferred: Project[] = [];
    const archived: Project[] = [];

    projects.forEach((project) => {
        if (project.status === 'archived') {
            archived.push(project);
            return;
        }
        if (project.status === 'waiting' || project.status === 'someday') {
            deferred.push(project);
            return;
        }
        active.push(project);
    });

    return { active, deferred, archived };
}
