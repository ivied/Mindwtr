import { describe, it, expect } from 'vitest';
import { getTaskDateCoherenceIssues } from './task-date-coherence';
import { getQuickAddProjectInitialProps, parseQuickAdd, parseQuickAddDateCommands, splitQuickAddBulkLines } from './quick-add';

describe('quick-add', () => {
    it('splits bulk quick-add text into trimmed nonblank lines', () => {
        expect(splitQuickAddBulkLines('  Email Bob  \r\n\nCall Alice\n\t\nReview notes +Work  ')).toEqual([
            'Email Bob',
            'Call Alice',
            'Review notes +Work',
        ]);
        expect(splitQuickAddBulkLines('One task only')).toEqual(['One task only']);
        expect(splitQuickAddBulkLines(' \n\t\r\n ')).toEqual([]);
    });

    it('parses status, due, note, tags, contexts', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('Call mom @phone #family /next /due:tomorrow 5pm /note:ask about trip', undefined, now);

        expect(result.title).toBe('Call mom');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.tags).toEqual(['#family']);
        expect(result.props.description).toBe('ask about trip');
        const expectedLocal = new Date(2025, 0, 2, 17, 0, 0, 0).toISOString();
        expect(result.props.dueDate).toBe(expectedLocal);
    });

    it('parses focus quick-add tokens and implies next when no status is supplied', () => {
        const result = parseQuickAdd('Call plumber /* focus');

        expect(result.title).toBe('Call plumber');
        expect(result.props.status).toBe('next');
        expect(result.props.isFocusedToday).toBe(true);
    });

    it('keeps explicit status when parsing focus quick-add tokens', () => {
        const result = parseQuickAdd('Review someday idea /someday /*');

        expect(result.title).toBe('Review someday idea');
        expect(result.props.status).toBe('someday');
        expect(result.props.isFocusedToday).toBe(true);
    });

    it('parses energy quick-add commands', () => {
        const result = parseQuickAdd('Draft proposal /energy:High /next');

        expect(result.title).toBe('Draft proposal');
        expect(result.props.energyLevel).toBe('high');
        expect(result.props.status).toBe('next');
    });

    it('keeps parsing later energy commands after a note', () => {
        const result = parseQuickAdd('Call mom /note:ask about trip /energy:low /next');

        expect(result.title).toBe('Call mom');
        expect(result.props.description).toBe('ask about trip');
        expect(result.props.energyLevel).toBe('low');
        expect(result.props.status).toBe('next');
    });

    it('parses URL notes into the description field', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Check website /note:https://example.com', undefined, now);

        expect(result.title).toBe('Check website');
        expect(result.props.description).toBe('https://example.com');
    });

    it('keeps parsing later commands after a URL note', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Check website /note:https://example.com /next', undefined, now);

        expect(result.title).toBe('Check website');
        expect(result.props.description).toBe('https://example.com');
        expect(result.props.status).toBe('next');
    });

    it('parses a link command into a link attachment without consuming later commands', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd(
            'Read source /link:https://example.com/docs#section /next @desk',
            undefined,
            now
        );

        expect(result.title).toBe('Read source');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@desk']);
        expect(result.props.tags).toBeUndefined();
        expect(result.props.attachments).toEqual([
            expect.objectContaining({
                createdAt: now.toISOString(),
                kind: 'link',
                title: 'example.com/docs',
                updatedAt: now.toISOString(),
                uri: 'https://example.com/docs#section',
            }),
        ]);
        expect(result.props.attachments?.[0]?.id).toEqual(expect.any(String));
    });

    it('keeps URI-style link commands as lightweight link attachments', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd(
            'Email Alex /link:mailto:alex@example.com /note:Ask for the update',
            undefined,
            now
        );

        expect(result.title).toBe('Email Alex');
        expect(result.props.contexts).toBeUndefined();
        expect(result.props.description).toBe('Ask for the update');
        expect(result.props.attachments?.[0]).toEqual(expect.objectContaining({
            kind: 'link',
            title: 'alex@example.com',
            uri: 'mailto:alex@example.com',
        }));
    });

    it('supports labeled link commands', () => {
        const now = new Date('2026-03-30T10:00:00Z');
        const result = parseQuickAdd('Review plan /link:Sprint Plan | https://example.com/doc', undefined, now);

        expect(result.title).toBe('Review plan');
        expect(result.props.attachments?.[0]).toEqual(expect.objectContaining({
            kind: 'link',
            title: 'Sprint Plan',
            uri: 'https://example.com/doc',
        }));
    });

    it('keeps due commands date-only when no time is explicit', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow /review:friday /due:next week',
            undefined,
            now
        );

        expect(result.title).toBe('Review proposal');
        expect(result.props.startTime).toBe(new Date(2025, 0, 2, 0, 0, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2025, 0, 3, 0, 0, 0, 0).toISOString());
        expect(result.props.dueDate).toBe('2025-01-08');
    });

    it('uses default schedule time for start and review commands without explicit time', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow /review:friday /due:next week',
            undefined,
            now,
            undefined,
            { defaultScheduleTime: '09:30' },
        );

        const relativeResult = parseQuickAdd('Task /start: 1d', undefined, now, undefined, {
            defaultScheduleTime: '09:30',
        });

        expect(result.title).toBe('Review proposal');
        expect(result.props.startTime).toBe(new Date(2025, 0, 2, 9, 30, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2025, 0, 3, 9, 30, 0, 0).toISOString());
        expect(result.props.dueDate).toBe('2025-01-08');
        expect(relativeResult.props.startTime).toBe(new Date(2025, 0, 2, 9, 30, 0, 0).toISOString());
    });

    it('keeps explicit quick-add times ahead of the default schedule time', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd(
            'Review proposal /start:tomorrow 2:15pm /review:friday 11am',
            undefined,
            now,
            undefined,
            { defaultScheduleTime: '09:30' },
        );

        expect(result.props.startTime).toBe(new Date(2025, 0, 2, 14, 15, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2025, 0, 3, 11, 0, 0, 0).toISOString());
    });

    it('parses abbreviated weekday commands like /start:mon', () => {
        const now = new Date('2026-02-27T09:40:00Z');
        const result = parseQuickAdd('Task /start:mon', undefined, now);
        expect(result.props.startTime).toBe(new Date(2026, 2, 2, 0, 0, 0, 0).toISOString());
        expect(result.invalidDateCommands).toBeUndefined();
    });

    it('exposes date incoherence from parsed quick-add dates without changing the dates', () => {
        const now = new Date('2026-04-20T09:40:00Z');
        const result = parseQuickAdd('Task /due:tomorrow /start:friday', undefined, now);

        expect(result.props.dueDate).toBe('2026-04-21');
        expect(result.props.startTime).toBe(new Date(2026, 3, 24, 0, 0, 0, 0).toISOString());
        expect(getTaskDateCoherenceIssues(result.props)).toEqual([{
            code: 'start_after_due',
            field: 'startTime',
            relatedField: 'dueDate',
        }]);
    });

    it('reports invalid date commands instead of silently dropping them', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('Task /start:monx /due:tomorrow', undefined, now);
        expect(result.invalidDateCommands).toEqual(['/start:monx']);
        expect(result.props.startTime).toBeUndefined();
        expect(result.props.dueDate).toBe('2025-01-02');
    });

    it('parses date commands without stripping unrelated quick-add tokens', () => {
        const now = new Date('2026-04-13T10:00:00Z');
        const result = parseQuickAddDateCommands(
            'Review talk @school #urgent /start:tomorrow /due:friday 2pm /review:next monday',
            now
        );

        expect(result.title).toBe('Review talk @school #urgent');
        expect(result.props.startTime).toBe(new Date(2026, 3, 14, 0, 0, 0, 0).toISOString());
        expect(result.props.dueDate).toBe(new Date(2026, 3, 17, 14, 0, 0, 0).toISOString());
        expect(result.props.reviewAt).toBe(new Date(2026, 3, 20, 0, 0, 0, 0).toISOString());
    });

    it('keeps invalid date commands in the title-only parser output', () => {
        const now = new Date('2026-04-13T10:00:00Z');
        const result = parseQuickAddDateCommands('Task /due:2026-04-31', now);

        expect(result.title).toBe('Task /due:2026-04-31');
        expect(result.invalidDateCommands).toEqual(['/due:2026-04-31']);
        expect(result.props.dueDate).toBeUndefined();
    });

    it('parses relative due dates with numbers without treating numbers as time tokens', () => {
        const now = new Date('2026-03-01T10:30:00Z');
        const result = parseQuickAdd('Task /due:in 3 days', undefined, now);
        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe('2026-03-04');
    });

    it('parses ISO due dates as date-only without corrupting the date token', () => {
        const now = new Date('2026-03-01T10:30:00Z');
        const result = parseQuickAdd('Task /due:2026-03-15', undefined, now);
        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe('2026-03-15');
    });

    it('parses richer chrono expressions in explicit date commands', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call dentist /due:next friday at 3pm', undefined, now);

        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe(new Date(2026, 3, 17, 15, 0, 0, 0).toISOString());
    });

    it('keeps explicit calendar due dates date-only without a time', () => {
        const now = new Date('2026-02-01T10:00:00Z');
        const result = parseQuickAdd('Submit report /due:march 15', undefined, now);

        expect(result.invalidDateCommands).toBeUndefined();
        expect(result.props.dueDate).toBe('2026-03-15');
    });

    it('detects a trailing natural-language due date without auto-applying it in core', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call mom tomorrow at 3pm @phone /next', undefined, now);

        expect(result.title).toBe('Call mom tomorrow at 3pm');
        expect(result.props.status).toBe('next');
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.dueDate).toBeUndefined();
        expect(result.detectedDate).toEqual({
            date: new Date(2026, 3, 7, 15, 0, 0, 0).toISOString(),
            matchedText: 'tomorrow at 3pm',
            titleWithoutDate: 'Call mom',
        });
    });

    it('does not auto-detect dates from the middle of the title', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call March about the report', undefined, now);

        expect(result.title).toBe('Call March about the report');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect pure time-only suffixes', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Task at 3', undefined, now);

        expect(result.title).toBe('Task at 3');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect when the entire title is just a date phrase', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('tomorrow', undefined, now);

        expect(result.title).toBe('tomorrow');
        expect(result.detectedDate).toBeUndefined();
    });

    it('does not auto-detect bare month names at the end of the title', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call March', undefined, now);

        expect(result.title).toBe('Call March');
        expect(result.detectedDate).toBeUndefined();
    });

    it('strips unicode dashes before an auto-detected trailing date', () => {
        const now = new Date('2026-04-16T10:00:00Z');
        const result = parseQuickAdd('Tax deadline — April 15', undefined, now);

        expect(result.detectedDate).toEqual({
            date: '2027-04-15',
            matchedText: 'April 15',
            titleWithoutDate: 'Tax deadline',
        });
    });

    it('skips trailing NLP detection when an explicit due command is present', () => {
        const now = new Date('2026-04-06T10:00:00Z');
        const result = parseQuickAdd('Call mom tomorrow /due:friday', undefined, now);

        expect(result.props.dueDate).toBe('2026-04-10');
        expect(result.detectedDate).toBeUndefined();
        expect(result.title).toBe('Call mom tomorrow');
    });

    it('matches project by title when provided', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'MyProject',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Write spec +MyProject', projects as any, now);
        expect(result.title).toBe('Write spec');
        expect(result.props.projectId).toBe('p1');
        expect(result.projectTitle).toBeUndefined();
    });

    it('does not match archived projects by title', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [{
            id: 'p1',
            title: 'OldProject',
            status: 'archived',
            color: '#000000',
            order: 0,
            tagIds: [],
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
        }];

        const result = parseQuickAdd('Write spec +OldProject', projects as any, now);
        expect(result.title).toBe('Write spec');
        expect(result.props.projectId).toBeUndefined();
        expect(result.projectTitle).toBe('OldProject');
    });

    it('captures project title when project is missing', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'Existing',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Draft outline +NewProject', projects as any, now);
        expect(result.title).toBe('Draft outline');
        expect(result.props.projectId).toBeUndefined();
        expect(result.projectTitle).toBe('NewProject');
    });

    it('captures multi-word project titles', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const projects = [
            {
                id: 'p1',
                title: 'Project Name',
                status: 'active',
                color: '#000000',
                tagIds: [],
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
            },
        ];

        const result = parseQuickAdd('Plan roadmap +Project Name /next', projects as any, now);
        expect(result.title).toBe('Plan roadmap');
        expect(result.props.projectId).toBe('p1');
        expect(result.projectTitle).toBeUndefined();
    });

    it('matches area by name when provided', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Work', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
            { id: 'a2', name: 'Personal', color: '#222222', order: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const result = parseQuickAdd('Draft report !Work /next', undefined, now, areas as any);
        expect(result.title).toBe('Draft report');
        expect(result.props.areaId).toBe('a1');

        const explicitResult = parseQuickAdd('Plan budget /area:Personal /next', undefined, now, areas as any);
        expect(explicitResult.title).toBe('Plan budget');
        expect(explicitResult.props.areaId).toBe('a2');
    });

    it('uses parsed area before fallback area when creating a project from quick add', () => {
        expect(getQuickAddProjectInitialProps({ areaId: 'parsed-area' }, 'fallback-area')).toEqual({ areaId: 'parsed-area' });
        expect(getQuickAddProjectInitialProps({}, 'fallback-area')).toEqual({ areaId: 'fallback-area' });
        expect(getQuickAddProjectInitialProps({})).toBeUndefined();
    });

    it('supports unicode tags and contexts', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const result = parseQuickAdd('计划 @工作 #项目 /next', undefined, now);

        expect(result.title).toBe('计划');
        expect(result.props.contexts).toEqual(['@工作']);
        expect(result.props.tags).toEqual(['#项目']);
        expect(result.props.status).toBe('next');
    });

    it('supports emoji-starting tags selected from quick add suggestions', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const areas = [
            { id: 'a1', name: 'Perso', color: '#111111', order: 0, createdAt: now.toISOString(), updatedAt: now.toISOString() },
        ];

        const result = parseQuickAdd(
            'Inscription to the competition !Perso #🐴 - Horse riding /next',
            undefined,
            now,
            areas as any,
        );

        expect(result.title).toBe('Inscription to the competition');
        expect(result.props.areaId).toBe('a1');
        expect(result.props.tags).toEqual(['#🐴 - Horse riding']);
        expect(result.props.status).toBe('next');
    });

    it('matches the longest existing multi-word tag from quick add tokens', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const result = parseQuickAdd(
            'Buy headset #home office',
            undefined,
            now,
            undefined,
            { knownTags: ['#home', '#home office'] },
        );

        expect(result.title).toBe('Buy headset');
        expect(result.props.tags).toEqual(['#home office']);
    });

    it('leaves trailing words in the title after a matched multi-word tag', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const result = parseQuickAdd(
            'Buy headset #home office supplies',
            undefined,
            now,
            undefined,
            { knownTags: ['#home office'] },
        );

        expect(result.title).toBe('Buy headset supplies');
        expect(result.props.tags).toEqual(['#home office']);
    });

    it('supports quoted multi-word tags without known tag lookup', () => {
        const result = parseQuickAdd('Buy headset #"home office"');

        expect(result.title).toBe('Buy headset');
        expect(result.props.tags).toEqual(['#home office']);
    });

    it('keeps unknown unquoted multi-word tags single-word to avoid guessing', () => {
        const result = parseQuickAdd('Buy headset #home office');

        expect(result.title).toBe('Buy headset office');
        expect(result.props.tags).toEqual(['#home']);
    });

    it('keeps simple single-word tags from consuming following title text', () => {
        const now = new Date('2026-05-19T10:00:00Z');
        const result = parseQuickAdd('Email #project stakeholders /next', undefined, now);

        expect(result.title).toBe('Email stakeholders');
        expect(result.props.tags).toEqual(['#project']);
        expect(result.props.status).toBe('next');
    });

    it('preserveText keeps the original title but still applies detected metadata (#742)', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const input = 'Call mom @phone #family /due:tomorrow';
        const result = parseQuickAdd(input, undefined, now, undefined, { preserveText: true });

        expect(result.title).toBe(input);
        expect(result.props.contexts).toEqual(['@phone']);
        expect(result.props.tags).toEqual(['#family']);
        expect(result.props.dueDate).toBeTruthy();
    });

    it('preserveText leaves a pasted URL untouched and extracts no implicit date (#742)', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const input = 'Read https://en.wikipedia.org/wiki/Foo_(bar) tomorrow';
        const result = parseQuickAdd(input, undefined, now, undefined, { preserveText: true });

        expect(result.title).toBe(input);
        expect(result.detectedDate).toBeUndefined();
        expect(result.props.dueDate).toBeUndefined();
    });

    it('default mode still strips recognized tokens (preserve is opt-in)', () => {
        const result = parseQuickAdd('Buy milk #grocery', undefined, undefined, undefined, {
            knownTags: ['#grocery'],
        });

        expect(result.title).toBe('Buy milk');
        expect(result.props.tags).toEqual(['#grocery']);
    });

    it('parseQuickAddDateCommands preserves the title when requested (#742)', () => {
        const now = new Date('2025-01-01T10:00:00Z');
        const stripped = parseQuickAddDateCommands('Submit report /due:tomorrow', now);
        expect(stripped.title).toBe('Submit report');
        expect(stripped.props.dueDate).toBeTruthy();

        const preserved = parseQuickAddDateCommands('Submit report /due:tomorrow', now, { preserveText: true });
        expect(preserved.title).toBe('Submit report /due:tomorrow');
        expect(preserved.props.dueDate).toBeTruthy();
    });
});
