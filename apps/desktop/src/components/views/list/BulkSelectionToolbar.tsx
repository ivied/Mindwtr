import { tFallback } from '@mindwtr/core';

type BulkSelectionToolbarProps = {
    selectionCount: number;
    totalCount: number;
    allSelected: boolean;
    onSelectAll: () => void;
    onClearSelection: () => void;
    t: (key: string) => string;
};

export function BulkSelectionToolbar({
    selectionCount,
    totalCount,
    allSelected,
    onSelectAll,
    onClearSelection,
    t,
}: BulkSelectionToolbarProps) {
    const selectAllLabel = `${tFallback(t, 'bulk.select', 'Select')} ${tFallback(t, 'common.all', 'all')}`;
    const clearSelectionLabel = tFallback(t, 'common.clear', 'Clear');

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs font-medium text-muted-foreground">
                {selectionCount} {t('bulk.selected')} - {totalCount} {t('common.tasks')}
            </div>
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    onClick={onSelectAll}
                    disabled={totalCount === 0 || allSelected}
                    className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {selectAllLabel}
                </button>
                <button
                    type="button"
                    onClick={onClearSelection}
                    disabled={selectionCount === 0}
                    className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {clearSelectionLabel}
                </button>
            </div>
        </div>
    );
}
