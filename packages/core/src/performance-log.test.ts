import { describe, expect, it, vi } from 'vitest';
import {
    buildPerformanceLogContext,
    buildPerformanceLogEntry,
    buildPerformanceLogLine,
    beginPerformanceLogMeasurement,
    isPerformanceRoute,
    PERFORMANCE_LOG_CONTEXT_KEYS,
    PERFORMANCE_LOG_FORBIDDEN_CONTEXT_KEYS,
    PERFORMANCE_LOG_MESSAGE,
    PERFORMANCE_LOG_ROUTES,
    PERFORMANCE_LOG_SCOPE,
    type PerformanceLogInput,
} from './performance-log';

type BuilderInput = Parameters<typeof buildPerformanceLogContext>[0];

const contentKeyRejected: BuilderInput = {
    operation: 'task_save_to_list',
    elapsedMs: 12,
    route: 'project',
    // @ts-expect-error content-like keys must not be accepted on fresh literals.
    areaName: 'Private area',
};
void contentKeyRejected;

describe('performance diagnostic log builder', () => {
    it('builds a content-free context from the explicit allowlist', () => {
        const context = buildPerformanceLogContext({
            operation: 'task_save_to_list',
            elapsedMs: 2314,
            route: 'project',
            taskCount: 1203,
            projectCount: 42,
            areaCount: 3,
            sectionCount: 18,
            listItemCount: 381,
            visibleItemCount: 14,
            filterCount: 2,
            platform: 'android',
            appVersion: '1.0.0',
        });

        expect(context).toEqual({
            operation: 'task_save_to_list',
            elapsedMs: '2314',
            route: 'project',
            taskCount: '1203',
            projectCount: '42',
            areaCount: '3',
            sectionCount: '18',
            listItemCount: '381',
            visibleItemCount: '14',
            filterCount: '2',
            platform: 'android',
            appVersion: '1.0.0',
        });
        expect(Object.keys(context).sort()).toEqual([...PERFORMANCE_LOG_CONTEXT_KEYS].sort());
    });

    it('drops extra properties from widened variables by explicitly reading fields', () => {
        const widened: PerformanceLogInput & {
            areaName: string;
            taskId: string;
            title: string;
        } = {
            operation: 'task_done_to_list',
            elapsedMs: 18,
            route: 'focus',
            taskCount: 9,
            areaName: 'Private area',
            taskId: 'task-1',
            title: 'Private task',
        };

        const context = buildPerformanceLogContext(widened);

        expect(context).toEqual({
            operation: 'task_done_to_list',
            elapsedMs: '18',
            route: 'focus',
            taskCount: '9',
        });
        expect(Object.keys(context).every((key) => PERFORMANCE_LOG_CONTEXT_KEYS.includes(key))).toBe(true);
        for (const key of PERFORMANCE_LOG_FORBIDDEN_CONTEXT_KEYS) {
            expect(context).not.toHaveProperty(key);
        }
    });

    it('coerces dynamic operation and route values to fixed unknown buckets', () => {
        const context = buildPerformanceLogContext({
            operation: 'project:Private task' as PerformanceLogInput['operation'],
            elapsedMs: 5,
            route: 'project:Private project' as PerformanceLogInput['route'],
        });

        expect(context.operation).toBe('unknown');
        expect(context.route).toBe('unknown');
        expect(isPerformanceRoute(context.route)).toBe(true);
        expect(PERFORMANCE_LOG_ROUTES).toContain(context.route);
    });

    it('does not start measurement work when diagnostics are disabled', () => {
        const now = vi.fn(() => 1000);
        const measurement = beginPerformanceLogMeasurement(
            { operation: 'task_list_derive', route: 'project', taskCount: 100 },
            { diagnosticsEnabled: false, now }
        );

        expect(measurement).toBeNull();
        expect(now).not.toHaveBeenCalled();
    });

    it('finishes enabled measurements with numeric input and string output', () => {
        const now = vi.fn()
            .mockReturnValueOnce(10)
            .mockReturnValueOnce(42);
        const measurement = beginPerformanceLogMeasurement(
            { operation: 'task_list_commit', route: 'project', visibleItemCount: 12 },
            { diagnosticsEnabled: true, now }
        );

        expect(measurement).not.toBeNull();
        const context = measurement?.finish({ listItemCount: 120 });

        expect(context).toEqual({
            operation: 'task_list_commit',
            elapsedMs: '32',
            route: 'project',
            listItemCount: '120',
            visibleItemCount: '12',
        });
        expect(now).toHaveBeenCalledTimes(2);
    });

    it('serializes entries as JSONL compatible with existing diagnostics logs', () => {
        const entry = buildPerformanceLogEntry(
            { operation: 'task_persistence', elapsedMs: 7, route: 'inbox', taskCount: 3 },
            { timestamp: '2026-06-21T00:00:00.000Z' }
        );
        const line = buildPerformanceLogLine(
            { operation: 'task_persistence', elapsedMs: 7, route: 'inbox', taskCount: 3 },
            { timestamp: '2026-06-21T00:00:00.000Z' }
        );

        expect(entry).toEqual({
            ts: '2026-06-21T00:00:00.000Z',
            level: 'info',
            scope: PERFORMANCE_LOG_SCOPE,
            message: PERFORMANCE_LOG_MESSAGE,
            context: {
                operation: 'task_persistence',
                elapsedMs: '7',
                route: 'inbox',
                taskCount: '3',
            },
        });
        expect(line.endsWith(String.fromCharCode(10))).toBe(true);
        expect(JSON.parse(line)).toEqual(entry);
    });
});
