import { describe, expect, it } from 'vitest';
import {
    chooseDeterministicWinner,
    createSyncSignatureMemo,
    normalizeAreaForContentComparison,
    normalizeSectionForContentComparison,
    normalizeTaskForContentComparison,
    toComparableSignature,
} from './sync-signatures';
import type { Area, Section, Task } from './types';

const area = (updates: Partial<Area> = {}): Area => ({
    id: 'area-1',
    name: 'Work',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...updates,
});

const task = (updates: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 2,
    revBy: 'device-a',
    ...updates,
});

const section = (updates: Partial<Section> = {}): Section => ({
    id: 'section-1',
    projectId: 'project-1',
    title: 'Section',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rev: 2,
    revBy: 'device-a',
    ...updates,
});

describe('sync signatures', () => {
    it('normalizes area default color and ordering for content comparison', () => {
        const local = normalizeAreaForContentComparison(area({
            color: '#6B7280',
            order: 10,
            name: '  Work  ',
        }));
        const incoming = normalizeAreaForContentComparison(area({
            order: 1,
            name: 'Work',
        }));

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
    });

    it('reuses comparable signatures across cloned entity references with matching revision metadata', () => {
        const memo = createSyncSignatureMemo();
        const first = normalizeAreaForContentComparison(area({
            rev: 3,
            revBy: 'device-a',
        }));
        const clone = { ...first };

        expect(toComparableSignature(first, memo)).toBe(toComparableSignature(clone, memo));
        expect(memo.comparableByRevision.size).toBe(1);
    });

    it('does not reuse stable signatures when revision metadata advances', () => {
        const memo = createSyncSignatureMemo();
        const original = normalizeAreaForContentComparison(area({
            rev: 3,
            name: 'Work',
        }));
        const changed = normalizeAreaForContentComparison(area({
            rev: 3,
            updatedAt: '2026-01-01T00:01:00.000Z',
            name: 'Personal',
        }));

        expect(toComparableSignature(original, memo)).not.toBe(toComparableSignature(changed, memo));
        expect(memo.comparableByRevision.size).toBe(2);
    });

    it('validates stable cache entries before reusing matching revision metadata', () => {
        const memo = createSyncSignatureMemo();
        const original = normalizeAreaForContentComparison(area({
            rev: 3,
            name: 'Work',
        }));
        const changed = normalizeAreaForContentComparison(area({
            rev: 3,
            name: 'Personal',
        }));

        expect(toComparableSignature(original, memo)).not.toBe(toComparableSignature(changed, memo));
        expect(memo.comparableByRevision.size).toBe(1);
    });

    it('ignores project archive task sidecars in comparable and deterministic signatures', () => {
        const local = normalizeTaskForContentComparison(task({
            projectArchivedAt: '2099-01-01T00:00:00.000Z',
            statusBeforeProjectArchive: 'next',
            completedAtBeforeProjectArchive: '2098-01-01T00:00:00.000Z',
            isFocusedTodayBeforeProjectArchive: true,
        }));
        const incoming = normalizeTaskForContentComparison(task({
            projectArchivedAt: '2026-01-01T00:00:00.000Z',
            statusBeforeProjectArchive: 'waiting',
            completedAtBeforeProjectArchive: null,
            isFocusedTodayBeforeProjectArchive: false,
        }));

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
        expect(chooseDeterministicWinner(local, incoming)).toBe(incoming);
    });

    it('ignores project archive section sidecars in comparable signatures', () => {
        const local = normalizeSectionForContentComparison(section({
            projectArchivedAt: '2099-01-01T00:00:00.000Z',
            deletedAtBeforeProjectArchive: null,
        }));
        const incoming = normalizeSectionForContentComparison(section({
            projectArchivedAt: '2026-01-01T00:00:00.000Z',
            deletedAtBeforeProjectArchive: '2025-12-31T00:00:00.000Z',
        }));

        expect(toComparableSignature(local)).toBe(toComparableSignature(incoming));
    });
});
