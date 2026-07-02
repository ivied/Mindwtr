import { describe, expect, it } from 'vitest';
import type { Area, Project, Task } from '@mindwtr/core';
import { groupTasksByArea, groupTasksByContext, groupTasksByProject, groupTasksByTag } from './next-grouping';

const baseTask = (overrides: Partial<Task>): Task => ({
    id: 'task-base',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
});

describe('groupTasksByArea', () => {
    it('groups next tasks by resolved area and keeps general tasks in a muted section', () => {
        const areas: Area[] = [
            {
                id: 'a1',
                name: 'Work',
                color: '#111111',
                order: 0,
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            },
            {
                id: 'a2',
                name: 'Home',
                color: '#222222',
                order: 1,
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            },
        ];
        const projectMap = new Map<string, Project>([
            ['p1', {
                id: 'p1',
                title: 'Project',
                status: 'active',
                color: '#ffffff',
                order: 0,
                tagIds: [],
                areaId: 'a1',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
        ]);
        const tasks = [
            baseTask({ id: 't1', title: 'General' }),
            baseTask({ id: 't2', title: 'Home task', areaId: 'a2' }),
            baseTask({ id: 't3', title: 'Work task', projectId: 'p1' }),
        ];

        const groups = groupTasksByArea({
            areas,
            tasks,
            projectMap,
            generalLabel: 'General',
        });

        expect(groups.map((group) => group.title)).toEqual(['General', 'Work', 'Home']);
        expect(groups[0]?.muted).toBe(true);
        expect(groups[1]?.tasks.map((task) => task.id)).toEqual(['t3']);
        expect(groups[2]?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});

describe('groupTasksByContext', () => {
    it('groups tasks under every context and keeps context-less tasks in a muted section', () => {
        const tasks = [
            baseTask({ id: 't1', title: 'No context' }),
            baseTask({ id: 't2', title: 'Work', contexts: ['@work', '@deep', '@work'] }),
            baseTask({ id: 't3', title: 'Home', contexts: ['@home'] }),
        ];

        const groups = groupTasksByContext({
            tasks,
            noContextLabel: 'No context',
        });

        expect(groups.map((group) => group.title)).toEqual(['No context', '@deep', '@home', '@work']);
        expect(groups[0]?.tasks.map((task) => task.id)).toEqual(['t1']);
        expect(groups.find((group) => group.id === 'context:@deep')?.tasks.map((task) => task.id)).toEqual(['t2']);
        expect(groups.find((group) => group.id === 'context:@work')?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});

describe('groupTasksByTag', () => {
    it('groups tasks under every tag and keeps tag-less tasks in a muted section', () => {
        const tasks = [
            baseTask({ id: 't1', title: 'No tags' }),
            baseTask({ id: 't2', title: 'Multi tag', tags: ['#work', '#deep', '#work'] }),
            baseTask({ id: 't3', title: 'Home', tags: ['#home'] }),
        ];

        const groups = groupTasksByTag({
            tasks,
            noTagLabel: 'No tags',
        });

        expect(groups.map((group) => group.title)).toEqual(['No tags', '#deep', '#home', '#work']);
        expect(groups[0]?.muted).toBe(true);
        expect(groups.find((group) => group.id === 'tag:#deep')?.tasks.map((task) => task.id)).toEqual(['t2']);
        expect(groups.find((group) => group.id === 'tag:#work')?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});

describe('groupTasksByProject', () => {
    it('groups by project order and keeps project-less tasks in a muted section', () => {
        const projectMap = new Map<string, Project>([
            ['p1', {
                id: 'p1',
                title: 'Alpha',
                status: 'active',
                color: '#111111',
                order: 1,
                tagIds: [],
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
            ['p2', {
                id: 'p2',
                title: 'Beta',
                status: 'active',
                color: '#222222',
                order: 0,
                tagIds: [],
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
            }],
        ]);
        const tasks = [
            baseTask({ id: 't1', title: 'No project task' }),
            baseTask({ id: 't2', title: 'Alpha task', projectId: 'p1' }),
            baseTask({ id: 't3', title: 'Beta task', projectId: 'p2' }),
        ];

        const groups = groupTasksByProject({
            tasks,
            projectMap,
            noProjectLabel: 'No project',
        });

        expect(groups.map((group) => group.title)).toEqual(['No project', 'Beta', 'Alpha']);
        expect(groups[0]?.muted).toBe(true);
        expect(groups[1]?.tasks.map((task) => task.id)).toEqual(['t3']);
        expect(groups[2]?.tasks.map((task) => task.id)).toEqual(['t2']);
    });
});
