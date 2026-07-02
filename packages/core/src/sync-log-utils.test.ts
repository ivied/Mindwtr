import { describe, expect, it } from 'vitest';
import { buildMergeSummaryLog, summarizeMergeStats } from './sync-log-utils';
import type { EntityMergeStats, MergeStats } from './sync-types';

const entityStats = (overrides: Partial<EntityMergeStats> = {}): EntityMergeStats => ({
    localTotal: 0,
    incomingTotal: 0,
    mergedTotal: 0,
    localOnly: 0,
    incomingOnly: 0,
    conflicts: 0,
    resolvedUsingLocal: 0,
    resolvedUsingIncoming: 0,
    deletionsWon: 0,
    conflictIds: [],
    maxClockSkewMs: 0,
    invalidTimestamps: 0,
    timestampAdjustments: 0,
    timestampAdjustmentIds: [],
    futureTimestampClamps: 0,
    futureTimestampClampIds: [],
    conflictReasonCounts: {},
    conflictSamples: [],
    ...overrides,
});

const mergeStats = (overrides: Partial<MergeStats> = {}): MergeStats => ({
    tasks: entityStats(),
    projects: entityStats(),
    sections: entityStats(),
    areas: entityStats(),
    ...overrides,
});

describe('sync log utils', () => {
    it('summarizes merge stats across all synced entity types', () => {
        const summary = summarizeMergeStats(mergeStats({
            tasks: entityStats({ conflicts: 1, conflictIds: ['task-1'], maxClockSkewMs: 1000, timestampAdjustments: 2 }),
            sections: entityStats({ conflicts: 2, conflictIds: ['section-1'], futureTimestampClamps: 3 }),
            areas: entityStats({ conflictReasonCounts: { deleteState: 4 }, maxClockSkewMs: 5000 }),
        }));

        expect(summary).toEqual({
            conflicts: 3,
            conflictIds: ['task-1', 'section-1'],
            maxClockSkewMs: 5000,
            timestampAdjustments: 2,
            deleteVsLiveConflicts: 4,
            futureTimestampClamps: 3,
        });
    });

    it('builds merge summary logs only when conflicts, skew, or timestamp fixes exist', () => {
        expect(buildMergeSummaryLog(mergeStats(), { clockSkewThresholdMs: 300_000 })).toBeNull();

        const log = buildMergeSummaryLog(mergeStats({
            areas: entityStats({ conflicts: 1, conflictIds: ['area-1'] }),
        }), { clockSkewThresholdMs: 300_000 });

        expect(log?.message).toContain('1 conflicts');
        expect(log?.extra).toMatchObject({
            conflicts: '1',
            conflictIds: 'area-1',
        });
    });
});
