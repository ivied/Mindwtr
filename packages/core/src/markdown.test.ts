import { describe, it, expect } from 'vitest';
import {
    extractChecklistFromMarkdown,
    getActiveMarkdownReferenceQuery,
    insertMarkdownReferenceAtQuery,
    normalizeMarkdownInternalLinks,
    parseInlineMarkdown,
    parseMarkdownReferenceHref,
    searchMarkdownReferences,
    stripMarkdown,
    syncMarkdownChecklistCompletion,
    syncMarkdownChecklistWithCanonical,
} from './markdown';
import type { Project, Task } from './types';

describe('stripMarkdown', () => {
    it('removes common markdown markers', () => {
        const input = '# Title\n\n- **Bold** and *italic* with `code`\n\n[Link](https://example.com)';
        const output = stripMarkdown(input);
        expect(output).toContain('Title');
        expect(output).toContain('Bold and italic with code');
        expect(output).toContain('Link');
        expect(output).not.toContain('**');
        expect(output).not.toContain('`');
        expect(output).not.toContain('[');
    });

    it('removes markdown checklist and list markers', () => {
        const input = '- [x] Done item\n[ ] Todo item\n+ Plain bullet';
        const output = stripMarkdown(input);
        expect(output).toContain('Done item');
        expect(output).toContain('Todo item');
        expect(output).toContain('Plain bullet');
        expect(output).not.toContain('[x]');
        expect(output).not.toContain('[ ]');
    });

    it('keeps internal markdown link labels', () => {
        const input = 'See [[task:task-1|Quarterly review]] next.';
        expect(stripMarkdown(input)).toBe('See Quarterly review next.');
    });
});

describe('parseInlineMarkdown', () => {
    it('autolinks raw safe URLs outside explicit markdown links', () => {
        expect(parseInlineMarkdown('See https://example.com/docs.')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'https://example.com/docs', href: 'https://example.com/docs' },
            { type: 'text', text: '.' },
        ]);
    });

    it('keeps explicit markdown link labels and hrefs', () => {
        expect(parseInlineMarkdown('See [docs](https://example.com/docs).')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'docs', href: 'https://example.com/docs' },
            { type: 'text', text: '.' },
        ]);
    });

    it('autolinks RFC 2392 message-id links', () => {
        expect(parseInlineMarkdown('Reply later mid:960830.1639@example.com.')).toEqual([
            { type: 'text', text: 'Reply later ' },
            { type: 'link', text: 'mid:960830.1639@example.com', href: 'mid:960830.1639@example.com' },
            { type: 'text', text: '.' },
        ]);
    });

    it('keeps explicit RFC 2392 message-id link labels and hrefs', () => {
        expect(parseInlineMarkdown('See [email](mid:960830.1639@example.com).')).toEqual([
            { type: 'text', text: 'See ' },
            { type: 'link', text: 'email', href: 'mid:960830.1639@example.com' },
            { type: 'text', text: '.' },
        ]);
    });
});

describe('extractChecklistFromMarkdown', () => {
    it('extracts markdown task list items', () => {
        const input = '- [x] Done item\n[ ] Todo item\n+ [X] Another done\n- plain bullet';
        expect(extractChecklistFromMarkdown(input)).toEqual([
            { title: 'Done item', isCompleted: true },
            { title: 'Todo item', isCompleted: false },
            { title: 'Another done', isCompleted: true },
        ]);
    });
});

describe('syncMarkdownChecklistCompletion', () => {
    it('updates matching markdown task list markers from canonical checklist state', () => {
        const input = '- [ ] **Draft** spec\n- [x] Review [notes](https://example.com)';

        expect(syncMarkdownChecklistCompletion(input, [
            { title: '**Draft** spec', isCompleted: true },
            { title: 'Review [notes](https://example.com)', isCompleted: false },
        ])).toBe('- [x] **Draft** spec\n- [ ] Review [notes](https://example.com)');
    });

    it('leaves unrelated markdown task list items unchanged', () => {
        const input = '- [ ] Draft spec\n- [x] Keep independent';

        expect(syncMarkdownChecklistCompletion(input, [
            { title: 'Draft spec', isCompleted: true },
        ])).toBe('- [x] Draft spec\n- [x] Keep independent');
    });
});

describe('syncMarkdownChecklistWithCanonical', () => {
    it('reorders matching markdown task-list lines to follow the canonical checklist', () => {
        const input = [
            'Intro',
            '- [ ] Desktop layout',
            '- [x] Tablet layout',
            '- [ ] Mobile layout',
            'Outro',
        ].join('\n');

        expect(syncMarkdownChecklistWithCanonical(input, [
            { title: 'Tablet layout', isCompleted: true },
            { title: 'Desktop layout', isCompleted: false },
            { title: 'Mobile layout', isCompleted: false },
        ])).toBe([
            'Intro',
            '- [x] Tablet layout',
            '- [ ] Desktop layout',
            '- [ ] Mobile layout',
            'Outro',
        ].join('\n'));
    });

    it('removes stale markdown task-list lines missing from the canonical checklist', () => {
        const input = '- [ ] Desktop layout\n- [ ] Tablet layout\n- [ ] Mobile layout';

        expect(syncMarkdownChecklistWithCanonical(input, [
            { title: 'Desktop layout', isCompleted: false },
            { title: 'Mobile layout', isCompleted: false },
        ])).toBe('- [ ] Desktop layout\n- [ ] Mobile layout');
    });

    it('adds new canonical checklist items after the existing markdown task-list block', () => {
        const input = 'Intro\n- [ ] Desktop layout\nOutro';

        expect(syncMarkdownChecklistWithCanonical(input, [
            { title: 'Desktop layout', isCompleted: false },
            { title: 'Tablet layout', isCompleted: true },
        ])).toBe('Intro\n- [ ] Desktop layout\n- [x] Tablet layout\nOutro');
    });
});

describe('markdown references', () => {
    const baseTask: Task = {
        id: 'task-1',
        title: 'Quarterly review',
        status: 'next',
        tags: [],
        contexts: [],
        createdAt: '2026-04-10T10:00:00.000Z',
        updatedAt: '2026-04-10T10:00:00.000Z',
    };
    const baseProject: Project = {
        id: 'project-1',
        title: 'Launch plan',
        status: 'active',
        color: '#000000',
        order: 0,
        tagIds: [],
        createdAt: '2026-04-09T10:00:00.000Z',
        updatedAt: '2026-04-09T10:00:00.000Z',
    };

    it('normalizes internal markdown links outside code', () => {
        const input = 'See [[task:task-1|Quarterly review]] and `[[task:task-1|Quarterly review]]`.';
        const output = normalizeMarkdownInternalLinks(input);
        expect(output).toContain('[Quarterly review](mindwtr://task/task-1)');
        expect(output).toContain('`[[task:task-1|Quarterly review]]`');
    });

    it('parses internal markdown hrefs', () => {
        expect(parseMarkdownReferenceHref('mindwtr://project/project-1')).toEqual({
            entityType: 'project',
            id: 'project-1',
        });
        expect(parseMarkdownReferenceHref('https://example.com')).toBeNull();
    });

    it('detects the active [[ query at the cursor', () => {
        const value = 'Link to [[la';
        expect(getActiveMarkdownReferenceQuery(value, { start: value.length, end: value.length })).toEqual({
            start: 8,
            end: value.length,
            query: 'la',
        });
    });

    it('does not detect the active [[ query when editor assist is disabled', () => {
        const value = 'Link to [[la';
        expect(
            getActiveMarkdownReferenceQuery(value, { start: value.length, end: value.length }, { assist: false }),
        ).toBeNull();
    });

    it('inserts a stable markdown reference token', () => {
        const value = 'Link to [[la';
        const activeQuery = getActiveMarkdownReferenceQuery(value, { start: value.length, end: value.length });
        expect(activeQuery).not.toBeNull();
        const next = insertMarkdownReferenceAtQuery(value, activeQuery!, {
            entityType: 'task',
            id: 'task-1',
            label: 'Quarterly review',
        });
        expect(next.value).toBe('Link to [[task:task-1|Quarterly review]]');
        expect(next.selection).toEqual({
            start: next.value.length,
            end: next.value.length,
        });
    });

    it('searches tasks and projects by name for markdown references', () => {
        const moreRecentProject: Project = {
            ...baseProject,
            id: 'project-2',
            title: 'Launch retrospective',
            updatedAt: '2026-04-11T10:00:00.000Z',
        };
        const results = searchMarkdownReferences(
            [
                baseTask,
                {
                    ...baseTask,
                    id: 'task-2',
                    title: 'Archive receipts',
                    status: 'done',
                    updatedAt: '2026-04-08T10:00:00.000Z',
                },
            ],
            [baseProject, moreRecentProject],
            'launch',
        );

        expect(results).toEqual([
            {
                entityType: 'project',
                id: 'project-2',
                title: 'Launch retrospective',
                status: 'active',
                updatedAt: '2026-04-11T10:00:00.000Z',
            },
            {
                entityType: 'project',
                id: 'project-1',
                title: 'Launch plan',
                status: 'active',
                updatedAt: '2026-04-09T10:00:00.000Z',
            },
        ]);
    });

    it('can exclude the current task from markdown reference results', () => {
        const results = searchMarkdownReferences(
            [
                baseTask,
                {
                    ...baseTask,
                    id: 'task-2',
                    title: 'Quarterly review follow-up',
                    updatedAt: '2026-04-11T10:00:00.000Z',
                },
            ],
            [baseProject],
            'quarterly',
            8,
            { excludeTaskIds: ['task-1'] },
        );

        expect(results).toEqual([
            {
                entityType: 'task',
                id: 'task-2',
                title: 'Quarterly review follow-up',
                status: 'next',
                updatedAt: '2026-04-11T10:00:00.000Z',
            },
        ]);
    });
});
