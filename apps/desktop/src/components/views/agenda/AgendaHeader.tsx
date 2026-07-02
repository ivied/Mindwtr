import { ChevronDown, Filter, List } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type { NextGroupBy } from '../list/next-grouping';

type AgendaHeaderProps = {
    filterCount: number;
    filtersOpen: boolean;
    nextActionsCount: number;
    nextGroupBy: NextGroupBy;
    onChangeGroupBy: (value: NextGroupBy) => void;
    onToggleFilters: () => void;
    onToggleDetails: () => void;
    onToggleTop3: () => void;
    resolveText: (key: string, fallback: string) => string;
    showListDetails: boolean;
    t: (key: string) => string;
    top3Only: boolean;
};

export function AgendaHeader({
    filterCount,
    filtersOpen,
    nextActionsCount,
    nextGroupBy,
    onChangeGroupBy,
    onToggleFilters,
    onToggleDetails,
    onToggleTop3,
    resolveText,
    showListDetails,
    t,
    top3Only,
}: AgendaHeaderProps) {
    const filtersActive = filtersOpen || filterCount > 0;
    const filtersLabel = resolveText('filters.label', 'Filters');

    return (
        <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">
                    {t('agenda.title')}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                    {nextActionsCount} {t('list.next') || t('agenda.nextActions')}
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={onToggleTop3}
                    className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors',
                        top3Only
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted',
                    )}
                >
                    {t('agenda.top3Only')}
                </button>
                <button
                    type="button"
                    onClick={onToggleFilters}
                    aria-expanded={filtersOpen}
                    aria-controls="agenda-filters-panel"
                    aria-pressed={filtersActive}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                        filtersActive
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    title={filtersLabel}
                >
                    <Filter className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>{filtersLabel}</span>
                    {filterCount > 0 && (
                        <span className="ml-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
                            {filterCount}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    onClick={onToggleDetails}
                    aria-pressed={showListDetails}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
                        showListDetails
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    title={showListDetails ? (t('list.details') || 'Details on') : (t('list.detailsOff') || 'Details off')}
                >
                    <List className="h-3.5 w-3.5" />
                    {showListDetails ? (t('list.details') || 'Details') : (t('list.detailsOff') || 'Details off')}
                </button>
                <div className="relative">
                    <select
                        value={nextGroupBy}
                        onChange={(event) => onChangeGroupBy(event.target.value as NextGroupBy)}
                        aria-label={resolveText('list.groupBy', 'Group')}
                        className={cn(
                            'min-w-[136px] appearance-none rounded-full border py-1.5 pl-3 pr-8 text-xs leading-none transition-colors',
                            'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                            'focus:outline-none focus:ring-2 focus:ring-primary/40',
                        )}
                    >
                        <option value="none">{resolveText('list.groupByNone', 'No grouping')}</option>
                        <option value="context">{resolveText('list.groupByContext', 'Context')}</option>
                        <option value="area">{resolveText('list.groupByArea', 'Area')}</option>
                        <option value="project">{resolveText('list.groupByProject', 'Project')}</option>
                        <option value="tag">{resolveText('tags.title', 'Tags')}</option>
                        <option value="energy">{resolveText('focus.group.energy', 'Energy')}</option>
                        <option value="priority">{resolveText('filters.priority', 'Priority')}</option>
                        <option value="person">{resolveText('people.title', 'People')}</option>
                    </select>
                    <ChevronDown
                        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                </div>
            </div>
        </header>
    );
}
