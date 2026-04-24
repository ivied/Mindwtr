import { useEffect, useMemo, type MutableRefObject } from 'react';
import type { Task } from '@mindwtr/core';

export const LIST_VIRTUALIZATION_THRESHOLD = 25;
export const LIST_VIRTUAL_ROW_ESTIMATE = 120;
export const LIST_VIRTUAL_OVERSCAN = 600;

interface VirtualListOptions {
    tasks: Task[];
    shouldVirtualize: boolean;
    rowHeightsRef: MutableRefObject<Map<string, number>>;
    measureVersion: number;
    listScrollTop: number;
    listHeight: number;
    rowEstimate: number;
    overscan: number;
}

export function useVirtualList({
    tasks,
    shouldVirtualize,
    rowHeightsRef,
    measureVersion,
    listScrollTop,
    listHeight,
    rowEstimate,
    overscan,
}: VirtualListOptions) {
    useEffect(() => {
        if (!shouldVirtualize) return;
        const activeIds = new Set(tasks.map((task) => task.id));
        for (const id of rowHeightsRef.current.keys()) {
            if (!activeIds.has(id)) {
                rowHeightsRef.current.delete(id);
            }
        }
    }, [tasks, shouldVirtualize, rowHeightsRef]);

    const rowHeights = useMemo(() => {
        if (!shouldVirtualize) return [];
        const measuredHeights = Array.from(rowHeightsRef.current.values());
        const fallbackHeight = measuredHeights.length
            ? Math.round(measuredHeights.reduce((sum, value) => sum + value, 0) / measuredHeights.length)
            : rowEstimate;
        return tasks.map((task) => rowHeightsRef.current.get(task.id) ?? fallbackHeight);
    }, [tasks, measureVersion, shouldVirtualize, rowEstimate, rowHeightsRef]);

    const { rowOffsets, totalHeight } = useMemo(() => {
        if (!shouldVirtualize) return { rowOffsets: [] as number[], totalHeight: 0 };
        let offset = 0;
        const offsets = rowHeights.map((height) => {
            const top = offset;
            offset += height;
            return top;
        });
        return { rowOffsets: offsets, totalHeight: offset };
    }, [rowHeights, shouldVirtualize]);

    const { startIndex, endIndex } = useMemo(() => {
        if (!shouldVirtualize) return { startIndex: 0, endIndex: tasks.length };
        const count = rowOffsets.length;
        if (count === 0) return { startIndex: 0, endIndex: 0 };
        const targetStart = Math.max(0, listScrollTop - overscan);
        let low = 0;
        let high = count - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            const midBottom = rowOffsets[mid] + rowHeights[mid];
            if (midBottom < targetStart) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        const start = Math.min(low, count - 1);
        const targetEnd = listScrollTop + listHeight + overscan;
        let end = start;
        while (end < count && rowOffsets[end] < targetEnd) {
            end += 1;
        }
        return { startIndex: start, endIndex: end };
    }, [shouldVirtualize, rowOffsets, rowHeights, listScrollTop, listHeight, tasks.length, overscan]);

    const visibleTasks = shouldVirtualize ? tasks.slice(startIndex, endIndex) : tasks;

    return { rowHeights, rowOffsets, totalHeight, startIndex, endIndex, visibleTasks };
}
