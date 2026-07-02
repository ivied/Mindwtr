export type RangeSelectionOptions = {
    range?: boolean;
};

export type RangeSelectionResult = {
    anchorId: string | null;
    selectedIds: Set<string>;
};

type UpdateRangeSelectionParams = {
    anchorId: string | null;
    range?: boolean;
    selectedIds: ReadonlySet<string>;
    targetId: string;
    visibleIds: readonly string[];
};

export function updateRangeSelection({
    anchorId,
    range = false,
    selectedIds,
    targetId,
    visibleIds,
}: UpdateRangeSelectionParams): RangeSelectionResult {
    const next = new Set(selectedIds);
    const targetIndex = visibleIds.indexOf(targetId);
    const anchorIndex = anchorId ? visibleIds.indexOf(anchorId) : -1;
    const canSelectRange = range && anchorIndex >= 0 && targetIndex >= 0;

    if (canSelectRange) {
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        for (let index = start; index <= end; index += 1) {
            const id = visibleIds[index];
            if (id) next.add(id);
        }
    } else if (range && targetIndex >= 0) {
        next.add(targetId);
    } else if (next.has(targetId)) {
        next.delete(targetId);
    } else {
        next.add(targetId);
    }

    return {
        anchorId: targetId,
        selectedIds: next,
    };
}
