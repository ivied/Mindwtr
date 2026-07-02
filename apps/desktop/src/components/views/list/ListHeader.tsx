import { ArrowUpDown, CheckSquare, ChevronDown, ChevronsUpDown, List, SlidersHorizontal } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { TaskSortBy } from '@mindwtr/core';
import type { TaskListGroupBy } from './next-grouping';

const DEFAULT_GROUP_BY_OPTIONS: TaskListGroupBy[] = ['none', 'context', 'area', 'project', 'tag', 'energy', 'priority', 'person'];

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
    groupBy?: TaskListGroupBy;
    groupByOptions?: TaskListGroupBy[];
    onChangeGroupBy?: (value: TaskListGroupBy) => void;
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
    groupByOptions = DEFAULT_GROUP_BY_OPTIONS,
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
    const sortLabel = (() => {
        const value = t('sort.label');
        return value === 'sort.label' ? 'Sort' : value;
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
    const groupByTagLabel = (() => {
        const value = t('taskEdit.tagsLabel');
        return value === 'taskEdit.tagsLabel' ? 'Tags' : value;
    })();
    const groupByPriorityLabel = (() => {
        const value = t('filters.priority');
        return value === 'filters.priority' ? 'Priority' : value;
    })();
    const groupByEnergyLabel = (() => {
        const value = t('focus.group.energy');
        return value === 'focus.group.energy' ? 'Energy' : value;
    })();
    const groupByPersonLabel = (() => {
        const value = t('people.title');
        return value === 'people.title' ? 'People' : value;
    })();
    const controlBaseClass = "h-9 text-xs border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40";
    const controlMutedClass = "bg-card text-muted-foreground border-border hover:bg-muted/70 hover:text-foreground";
    const controlActiveClass = "bg-primary/10 text-primary border-primary";
    const groupByLabels: Record<TaskListGroupBy, string> = {
        none: noGroupingLabel,
        context: groupByContextLabel,
        area: groupByAreaLabel,
        project: groupByProjectLabel,
        tag: groupByTagLabel,
        energy: groupByEnergyLabel,
        priority: groupByPriorityLabel,
        person: groupByPersonLabel,
    };

    return (
        <header className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="min-w-0 space-y-1">
                <h2 className="truncate text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                    {title}
                    {showNextCount && (
                        <span className="ml-2 align-baseline text-base font-medium text-muted-foreground sm:text-lg">
                            ({nextCount})
                        </span>
                    )}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                    <span>{taskCount} {t('common.tasks')}</span>
                    {hasFilters && (
                        <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary sm:max-w-[420px]">
                            <SlidersHorizontal className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{filterSummaryLabel}{filterSummarySuffix}</span>
                        </span>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                <button
                    type="button"
                    onClick={onToggleSelection}
                    className={cn(
                        controlBaseClass,
                        "inline-flex items-center gap-1.5 rounded-lg px-3",
                        selectionMode
                            ? controlActiveClass
                            : controlMutedClass
                    )}
                >
                    <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
                    {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                </button>
                <div className={cn(controlBaseClass, controlMutedClass, "relative flex min-w-[160px] items-center rounded-lg pl-2") }>
                    <ArrowUpDown
                        className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                        data-testid="list-sort-icon"
                    />
                    <span className="mr-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {sortLabel}
                    </span>
                    <select
                        value={sortBy}
                        onChange={(e) => onChangeSortBy(e.target.value as TaskSortBy)}
                        aria-label={sortLabel}
                        className="h-full min-w-0 flex-1 appearance-none bg-transparent pr-8 text-xs text-foreground focus:outline-none"
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
                    <div className={cn(controlBaseClass, controlMutedClass, "relative flex min-w-[180px] items-center rounded-lg pl-2") }>
                        <span className="mr-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            {groupLabel}
                        </span>
                        <select
                            value={groupBy}
                            onChange={(e) => onChangeGroupBy(e.target.value as TaskListGroupBy)}
                            aria-label={groupLabel}
                            className="h-full min-w-0 flex-1 appearance-none bg-transparent pr-8 text-xs text-foreground focus:outline-none"
                        >
                            {groupByOptions.map((option) => (
                                <option key={option} value={option}>{groupByLabels[option]}</option>
                            ))}
                        </select>
                        <ChevronDown
                            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                    </div>
                )}
                <button
                    type="button"
                    onClick={onToggleDetails}
                    aria-pressed={showListDetails}
                    className={cn(
                        controlBaseClass,
                        "inline-flex items-center gap-1.5 rounded-lg px-3",
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
                        "inline-flex items-center gap-1.5 rounded-lg px-3",
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
