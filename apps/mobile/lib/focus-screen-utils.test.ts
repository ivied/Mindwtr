import { describe, expect, it } from 'vitest';

import {
    formatFocusTimeEstimateLabel,
    getFocusTokenOptions,
    groupFocusTasksByContext,
    groupFocusTasksByTag,
    NO_PROJECT_FILTER_ID,
    splitFocusedTasks,
    taskMatchesFocusFilters,
} from './focus-screen-utils';

describe('splitFocusedTasks', () => {
    it('separates focused tasks while preserving relative order inside each group', () => {
        const { focusedTasks, otherTasks } = splitFocusedTasks([
            { id: 'due-1', isFocusedToday: false },
            { id: 'focus-1', isFocusedToday: true },
            { id: 'due-2', isFocusedToday: false },
            { id: 'focus-2', isFocusedToday: true },
            { id: 'focus-3', isFocusedToday: true },
        ]);

        expect(focusedTasks.map((task) => task.id)).toEqual([
            'focus-1',
            'focus-2',
            'focus-3',
        ]);
        expect(otherTasks.map((task) => task.id)).toEqual([
            'due-1',
            'due-2',
        ]);
    });

    it('returns empty groups when one side is absent', () => {
        const tasks = [
            { id: 'focus-1', isFocusedToday: true },
            { id: 'focus-2', isFocusedToday: true },
        ];

        expect(splitFocusedTasks(tasks)).toEqual({
            focusedTasks: tasks,
            otherTasks: [],
        });
    });
});

describe('getFocusTokenOptions', () => {
    it('returns sorted unique contexts and tags', () => {
        expect(getFocusTokenOptions([
            { contexts: ['@work', '@home', ''], tags: ['#deep'] },
            { contexts: ['@work/calls', '@home'], tags: ['#deep', '#ops'] },
            { contexts: [], tags: [] },
        ] as any)).toEqual(['@home', '@work', '@work/calls', '#deep', '#ops']);
    });
});

describe('groupFocusTasksByContext', () => {
    it('groups tasks under every matching context and keeps context-less tasks first', () => {
        const noContext = { id: 'no-context', contexts: [], tags: [] };
        const work = { id: 'work', contexts: ['@work', '@deep', '@work'], tags: [] };
        const home = { id: 'home', contexts: ['@home'], tags: [] };

        const groups = groupFocusTasksByContext([work, noContext, home] as any, 'No context');

        expect(groups.map((group) => group.title)).toEqual(['No context', '@deep', '@home', '@work']);
        expect(groups[0]).toMatchObject({ id: 'context:none', muted: true });
        expect(groups.find((group) => group.id === 'context:@deep')?.tasks.map((task) => task.id)).toEqual(['work']);
        expect(groups.find((group) => group.id === 'context:@work')?.tasks.map((task) => task.id)).toEqual(['work']);
    });
});

describe('groupFocusTasksByTag', () => {
    it('groups tasks under every matching tag and keeps untagged tasks muted first', () => {
        const noTag = { id: 'no-tag', contexts: [], tags: [] };
        const multi = { id: 'multi', contexts: [], tags: ['#work', '#deep', '#work'] };
        const home = { id: 'home', contexts: [], tags: ['#home'] };

        const groups = groupFocusTasksByTag([multi, noTag, home] as any, 'No tags');

        expect(groups.map((group) => group.title)).toEqual(['No tags', '#deep', '#home', '#work']);
        expect(groups[0]).toMatchObject({ id: 'tag:none', muted: true });
        expect(groups.find((group) => group.id === 'tag:#deep')?.tasks.map((task) => task.id)).toEqual(['multi']);
        expect(groups.find((group) => group.id === 'tag:#work')?.tasks.map((task) => task.id)).toEqual(['multi']);
    });
});

describe('taskMatchesFocusFilters', () => {
    it('matches direct and hierarchical token filters', () => {
        const task = { contexts: ['@work/deep', '@home'], tags: ['#ops'], projectId: 'p1' };

        expect(taskMatchesFocusFilters(task as any, {
            tokens: ['@work'],
            projects: [],
            locations: [],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
        })).toBe(true);
        expect(taskMatchesFocusFilters(task as any, {
            tokens: ['#ops'],
            projects: [],
            locations: [],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
        })).toBe(true);
        expect(taskMatchesFocusFilters(task as any, {
            tokens: ['@errands'],
            projects: [],
            locations: [],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
        })).toBe(false);
    });

    it('matches project, no-project, priority, energy and time filters', () => {
        const task = {
            contexts: ['@work'],
            tags: ['#ops'],
            projectId: 'project-1',
            priority: 'high',
            energyLevel: 'medium',
            timeEstimate: '30min',
        };

        expect(taskMatchesFocusFilters(task as any, {
            tokens: [],
            projects: ['project-1'],
            locations: [],
            priorities: ['high'],
            energyLevels: ['medium'],
            timeEstimates: ['30min'],
        })).toBe(true);

        expect(taskMatchesFocusFilters(task as any, {
            tokens: [],
            projects: [NO_PROJECT_FILTER_ID],
            locations: [],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
        })).toBe(false);
    });

    it('matches location filters case-insensitively', () => {
        const task = {
            contexts: [],
            tags: [],
            projectId: 'project-1',
            location: 'Main Office',
        };

        expect(taskMatchesFocusFilters(task as any, {
            tokens: [],
            projects: [],
            locations: ['office'],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
        })).toBe(true);
        expect(taskMatchesFocusFilters(task as any, {
            tokens: [],
            projects: [],
            locations: ['home'],
            priorities: [],
            energyLevels: [],
            timeEstimates: [],
        })).toBe(false);
    });
});

describe('formatFocusTimeEstimateLabel', () => {
    it('formats estimate chips compactly', () => {
        expect(formatFocusTimeEstimateLabel('5min')).toBe('5m');
        expect(formatFocusTimeEstimateLabel('4hr+')).toBe('4h+');
    });
});
