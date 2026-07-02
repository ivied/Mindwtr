import { describe, it, expect } from 'vitest';
import {
    filterProjectsBySelectedArea,
    filterProjectsNeedingNextAction,
    getSequentialProjectTaskCues,
    getProjectNextActionCandidates,
    getProjectNextActionPromptData,
    getProjectsByArea,
    getProjectsByTag,
    isTaskInActiveProject,
    isSelectableProjectForTaskAssignment,
    projectHasNextAction,
    shouldPromptForProjectNextAction,
} from './project-utils';
import type { Project, Task } from './types';

describe('project-utils', () => {
    const projects: Project[] = [
        { id: 'p1', title: 'Alpha', status: 'active', tagIds: ['t1'], areaId: 'a1', createdAt: '', updatedAt: '' },
        { id: 'p2', title: 'Beta', status: 'active', tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
        { id: 'p3', title: 'Gamma', status: 'someday', tagIds: ['t1'], areaId: 'a2', createdAt: '', updatedAt: '' },
        { id: 'p4', title: 'Delta', status: 'active', tagIds: ['t2'], createdAt: '', updatedAt: '' },
        { id: 'p5', title: 'Hidden', status: 'active', tagIds: [], areaId: 'a1', deletedAt: '2026-03-07T00:00:00.000Z', createdAt: '', updatedAt: '' },
    ];

    const tasks: Task[] = [
        { id: 't1', title: 'Next action', status: 'next', projectId: 'p1', tags: [], contexts: [], createdAt: '', updatedAt: '' },
        { id: 't2', title: 'Waiting action', status: 'waiting', projectId: 'p2', tags: [], contexts: [], createdAt: '', updatedAt: '' },
    ];

    it('detects projects with next actions', () => {
        expect(projectHasNextAction(projects[0], tasks)).toBe(true);
        expect(projectHasNextAction(projects[1], tasks)).toBe(false);
    });

    it('filters projects needing next actions', () => {
        const needing = filterProjectsNeedingNextAction(projects, tasks);
        expect(needing.map((p) => p.id)).toEqual(['p2', 'p4']);
    });

    it('prompts for a project next action after completing the last next task', () => {
        const completedTask: Task = {
            id: 'done-next',
            title: 'Finished step',
            status: 'done',
            projectId: 'p2',
            tags: [],
            contexts: [],
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
        };
        const projectTasks: Task[] = [
            completedTask,
            {
                id: 'candidate-later',
                title: 'Later step',
                status: 'someday',
                projectId: 'p2',
                order: 2,
                tags: [],
                contexts: [],
                createdAt: '2026-05-03T00:00:00.000Z',
                updatedAt: '2026-05-03T00:00:00.000Z',
            },
            {
                id: 'candidate-now',
                title: 'Draft outline',
                status: 'inbox',
                projectId: 'p2',
                order: 1,
                tags: [],
                contexts: [],
                createdAt: '2026-05-02T00:00:00.000Z',
                updatedAt: '2026-05-02T00:00:00.000Z',
            },
            {
                id: 'closed-reference',
                title: 'Project note',
                status: 'reference',
                projectId: 'p2',
                tags: [],
                contexts: [],
                createdAt: '2026-05-04T00:00:00.000Z',
                updatedAt: '2026-05-04T00:00:00.000Z',
            },
        ];

        const promptData = getProjectNextActionPromptData(completedTask, projectTasks, projects);

        expect(shouldPromptForProjectNextAction(completedTask, projectTasks, projects)).toBe(true);
        expect(promptData?.project.id).toBe('p2');
        expect(promptData?.candidates.map((task) => task.id)).toEqual(['candidate-now', 'candidate-later']);
        expect(getProjectNextActionCandidates('p2', projectTasks, 'done-next').map((task) => task.id))
            .toEqual(['candidate-now', 'candidate-later']);
    });

    it('does not prompt when another next action remains in the project', () => {
        const completedTask: Task = {
            id: 'done-next',
            title: 'Finished step',
            status: 'done',
            projectId: 'p1',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };

        expect(getProjectNextActionPromptData(completedTask, [completedTask, ...tasks], projects)).toBeNull();
    });

    it('marks one available next task in a sequential project', () => {
        const project: Project = { ...projects[0], isSequential: true, sequentialScope: 'project' };
        const projectTasks: Task[] = [
            { ...tasks[0], id: 'first-next', projectId: project.id, order: 1 },
            { ...tasks[0], id: 'second-next', projectId: project.id, order: 2 },
            { ...tasks[0], id: 'waiting-step', projectId: project.id, status: 'waiting', order: 3 },
        ];

        const cues = getSequentialProjectTaskCues(project, projectTasks);

        expect(cues.get('first-next')).toBe('available');
        expect(cues.get('second-next')).toBe('later');
        expect(cues.has('waiting-step')).toBe(false);
    });

    it('marks one available next task per section for section-scoped sequential projects', () => {
        const project: Project = { ...projects[0], isSequential: true, sequentialScope: 'section' };
        const projectTasks: Task[] = [
            { ...tasks[0], id: 'section-a-first', projectId: project.id, sectionId: 'a', order: 1 },
            { ...tasks[0], id: 'section-a-later', projectId: project.id, sectionId: 'a', order: 2 },
            { ...tasks[0], id: 'section-b-first', projectId: project.id, sectionId: 'b', order: 3 },
            { ...tasks[0], id: 'unsectioned-first', projectId: project.id, sectionId: 'missing', order: 4 },
            { ...tasks[0], id: 'unsectioned-later', projectId: project.id, order: 5 },
        ];

        const cues = getSequentialProjectTaskCues(project, projectTasks, { sectionIds: ['a', 'b'] });

        expect(cues.get('section-a-first')).toBe('available');
        expect(cues.get('section-a-later')).toBe('later');
        expect(cues.get('section-b-first')).toBe('available');
        expect(cues.get('unsectioned-first')).toBe('available');
        expect(cues.get('unsectioned-later')).toBe('later');
    });

    it('does not mark tasks in parallel projects', () => {
        const project: Project = { ...projects[0], isSequential: false };

        expect(getSequentialProjectTaskCues(project, tasks).size).toBe(0);
    });

    it('does not prompt for inactive projects or incomplete tasks', () => {
        const somedayTask: Task = {
            id: 'someday-task',
            title: 'Queued step',
            status: 'done',
            projectId: 'p3',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };
        const activeIncompleteTask: Task = {
            id: 'active-incomplete',
            title: 'Still open',
            status: 'next',
            projectId: 'p2',
            tags: [],
            contexts: [],
            createdAt: '',
            updatedAt: '',
        };

        expect(shouldPromptForProjectNextAction(somedayTask, [somedayTask], projects)).toBe(false);
        expect(shouldPromptForProjectNextAction(activeIncompleteTask, [activeIncompleteTask], projects)).toBe(false);
    });

    it('filters projects by area', () => {
        const areaProjects = getProjectsByArea(projects, 'a1');
        expect(areaProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('filters project picker choices by selected area', () => {
        const pickerProjects: Project[] = [
            ...projects,
            { id: 'p6', title: 'Archived', status: 'archived', tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
            { id: 'p7', title: 'Completed', status: 'completed' as Project['status'], tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' },
        ];
        expect(filterProjectsBySelectedArea(pickerProjects).map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(filterProjectsBySelectedArea(pickerProjects, 'a1').map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('marks archived and legacy completed projects as unavailable for task assignment', () => {
        const archivedProject: Project = { id: 'p6', title: 'Archived', status: 'archived', tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' };
        const completedProject: Project = { id: 'p7', title: 'Completed', status: 'completed' as Project['status'], tagIds: [], areaId: 'a1', createdAt: '', updatedAt: '' };
        expect(isSelectableProjectForTaskAssignment(projects[0])).toBe(true);
        expect(isSelectableProjectForTaskAssignment(projects[4])).toBe(false);
        expect(isSelectableProjectForTaskAssignment(archivedProject)).toBe(false);
        expect(isSelectableProjectForTaskAssignment(completedProject)).toBe(false);
    });

    it('recognizes whether a task belongs to an active project surface', () => {
        const projectMap = new Map(projects.map((project) => [project.id, project]));
        const noProjectTask: Task = { id: 'no-project', title: 'Loose task', status: 'next', tags: [], contexts: [], createdAt: '', updatedAt: '' };
        const activeProjectTask: Task = { ...noProjectTask, id: 'active-project', projectId: 'p1' };
        const somedayProjectTask: Task = { ...noProjectTask, id: 'someday-project', projectId: 'p3' };
        const deletedProjectTask: Task = { ...noProjectTask, id: 'deleted-project', projectId: 'p5' };
        const missingProjectTask: Task = { ...noProjectTask, id: 'missing-project', projectId: 'missing' };

        expect(isTaskInActiveProject(noProjectTask, projectMap)).toBe(true);
        expect(isTaskInActiveProject(activeProjectTask, projectMap)).toBe(true);
        expect(isTaskInActiveProject(somedayProjectTask, projectMap)).toBe(false);
        expect(isTaskInActiveProject(deletedProjectTask, projectMap)).toBe(false);
        expect(isTaskInActiveProject(missingProjectTask, projectMap)).toBe(true);
    });

    it('filters projects by tag', () => {
        const tagged = getProjectsByTag(projects, 't1');
        expect(tagged.map((p) => p.id)).toEqual(['p1', 'p3']);
    });
});
