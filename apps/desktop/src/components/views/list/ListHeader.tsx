import { ChevronDown, ChevronsUpDown, List } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { TaskSortBy } from '@mindwtr/core';
import type { NextGroupBy } from './next-grouping';

type ListHeaderProps = {
    title: string;
    showNextCount: boolean;
    nextCount: number;
    taskCount: number;
    hasFilters: boolean;
    filterSummaryLabel: string;
    filterSummarySuffix: string;
    sortBy: TaskSortBy;
    onChangeSortBy: (value: TaskSortBy) => void;
    showGroupBy?: boolean;
    groupBy?: NextGroupBy;
    onChangeGroupBy?: (value: NextGroupBy) => void;
    selectionMode: boolean;
    onToggleSelection: () => void;
    showListDetails: boolean;
    onToggleDetails: () => void;
    densityMode: 'comfortable' | 'compact';
    onToggleDensity: () => void;
    t: (key: string) => string;
};

export function ListHeader({
    title,
    showNextCount,
    nextCount,
    taskCount,
    hasFilters,
    filterSummaryLabel,
    filterSummarySuffix,
    sortBy,
    onChangeSortBy,
    showGroupBy = false,
    groupBy = 'none',
    onChangeGroupBy,
    selectionMode,
    onToggleSelection,
    showListDetails,
    onToggleDetails,
    densityMode,
    onToggleDensity,
    t,
}: ListHeaderProps) {
    const densityTitle = (() => {
        const value = t('list.density');
        return value === 'list.density' ? 'Density' : value;
    })();
    const densityLabel = densityMode === 'compact'
        ? (() => {
            const value = t('list.densityCompact');
            return value === 'list.densityCompact' ? 'Compact' : value;
        })()
        : (() => {
            const value = t('list.densityComfortable');
            return value === 'list.densityComfortable' ? 'Comfortable' : value;
        })();
    const groupLabel = (() => {
        const value = t('list.groupBy');
        return value === 'list.groupBy' ? 'Group' : value;
    })();
    const noGroupingLabel = (() => {
        const value = t('list.groupByNone');
        return value === 'list.groupByNone' ? 'No grouping' : value;
    })();
    const groupByContextLabel = (() => {
        const value = t('list.groupByContext');
        return value === 'list.groupByContext' ? 'Context' : value;
    })();
    const groupByAreaLabel = (() => {
        const value = t('list.groupByArea');
        return value === 'list.groupByArea' ? 'Area' : value;
    })();
    const groupByProjectLabel = (() => {
        const value = t('list.groupByProject');
        return value === 'list.groupByProject' ? 'Project' : value;
    })();
    const controlBaseClass = "text-xs border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40";
    const controlMutedClass = "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground";
    const controlActiveClass = "bg-primary/10 text-primary border-primary";

    return (
        <header className="flex items-center justify-between">
            <h2 className="text-3xl font-bold tracking-tight">
                {title}
                {showNextCount && <span className="ml-2 text-lg font-normal text-muted-foreground">({nextCount})</span>}
            </h2>
            <div className="flex items-center gap-3">
                <span className="text-muted-foreground text-sm" aria-live="polite">
                    {taskCount} {t('common.tasks')}
                    {hasFilters && (
                        <span className="ml-1 text-primary">• {filterSummaryLabel}{filterSummarySuffix}</span>
                    )}
                </span>
                <div className="relative">
                    <select
                        value={sortBy}
                        onChange={(e) => onChangeSortBy(e.target.value as TaskSortBy)}
                        aria-label={t('sort.label')}
                        className={cn(
                            controlBaseClass,
                            controlMutedClass,
                            "min-w-[180px] appearance-none rounded-xl pl-4 pr-9 py-2 text-foreground"
                        )}
                    >
                        <option value="default">{t('sort.default')}</option>
                        <option value="due">{t('sort.due')}</option>
                        <option value="start">{t('sort.start')}</option>
                        <option value="review">{t('sort.review')}</option>
                        <option value="title">{t('sort.title')}</option>
                        <option value="created">{t('sort.created')}</option>
                        <option value="created-desc">{t('sort.created-desc')}</option>
                    </select>
                    <ChevronDown
                        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                </div>
                {showGroupBy && onChangeGroupBy && (
                    <div className="relative">
                        <select
                            value={groupBy}
                            onChange={(e) => onChangeGroupBy(e.target.value as NextGroupBy)}
                            aria-label={groupLabel}
                            className={cn(
                                controlBaseClass,
                                controlMutedClass,
                                "min-w-[136px] appearance-none rounded-xl pl-4 pr-9 py-2 text-foreground"
                            )}
                        >
                            <option value="none">{noGroupingLabel}</option>
                            <option value="context">{groupByContextLabel}</option>
                            <option value="area">{groupByAreaLabel}</option>
                            <option value="project">{groupByProjectLabel}</option>
                        </select>
                        <ChevronDown
                            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </div>
                )}
                <button
                    onClick={onToggleSelection}
                    className={cn(
                        controlBaseClass,
                        "px-4 py-2 rounded-xl",
                        selectionMode
                            ? controlActiveClass
                            : controlMutedClass
                    )}
                >
                    {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                </button>
                <button
                    type="button"
                    onClick={onToggleDetails}
                    aria-pressed={showListDetails}
                    className={cn(
                        controlBaseClass,
                        "px-4 py-2 rounded-xl inline-flex items-center gap-1.5",
                        showListDetails
                            ? controlActiveClass
                            : controlMutedClass
                    )}
                    title={showListDetails ? (t('list.details') || 'Details on') : (t('list.detailsOff') || 'Details off')}
                >
                    <List className="w-3.5 h-3.5" />
                    {showListDetails ? (t('list.details') || 'Details') : (t('list.detailsOff') || 'Details off')}
                </button>
                <button
                    type="button"
                    onClick={onToggleDensity}
                    aria-pressed={densityMode === 'compact'}
                    className={cn(
                        controlBaseClass,
                        "px-4 py-2 rounded-xl inline-flex items-center gap-1.5",
                        densityMode === 'compact'
                            ? controlActiveClass
                            : controlMutedClass
                    )}
                    title={densityTitle}
                >
                    <ChevronsUpDown className="w-3.5 h-3.5" />
                    {densityLabel}
                </button>
            </div>
        </header>
    );
}
