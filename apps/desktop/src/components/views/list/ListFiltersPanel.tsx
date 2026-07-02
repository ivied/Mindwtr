import { Filter } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { TaskPriority, TimeEstimate } from '@mindwtr/core';

interface ListFiltersPanelProps {
    t: (key: string) => string;
    hasFilters: boolean;
    showFiltersPanel: boolean;
    onClearFilters: () => void;
    onToggleOpen: () => void;
    allTokens: string[];
    selectedTokens: string[];
    tokenCounts: Record<string, number>;
    onToggleToken: (token: string) => void;
    showPriorityFilters: boolean;
    priorityOptions: TaskPriority[];
    selectedPriorities: TaskPriority[];
    onTogglePriority: (priority: TaskPriority) => void;
    showTimeEstimateFilters: boolean;
    timeEstimateOptions: TimeEstimate[];
    selectedTimeEstimates: TimeEstimate[];
    onToggleEstimate: (estimate: TimeEstimate) => void;
    formatEstimate: (estimate: TimeEstimate) => string;
}

export function ListFiltersPanel({
    t,
    hasFilters,
    showFiltersPanel,
    onClearFilters,
    onToggleOpen,
    allTokens,
    selectedTokens,
    tokenCounts,
    onToggleToken,
    showPriorityFilters,
    priorityOptions,
    selectedPriorities,
    onTogglePriority,
    showTimeEstimateFilters,
    timeEstimateOptions,
    selectedTimeEstimates,
    onToggleEstimate,
    formatEstimate,
}: ListFiltersPanelProps) {
    return (
        <div className="bg-card border border-border rounded-lg p-3 space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Filter className="w-4 h-4" />
                    {t('filters.label')}
                </div>
                <div className="flex items-center gap-2">
                    {hasFilters && (
                        <button
                            type="button"
                            onClick={onClearFilters}
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                            {t('filters.clear')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onToggleOpen}
                        aria-expanded={showFiltersPanel}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                    </button>
                </div>
            </div>
            {showFiltersPanel && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.contexts')}</div>
                        <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                            {allTokens.map((token) => {
                                const isActive = selectedTokens.includes(token);
                                return (
                                    <button
                                        key={token}
                                        type="button"
                                        onClick={() => onToggleToken(token)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                            isActive
                                                ? "bg-primary text-primary-foreground"
                                                : "bg-muted hover:bg-muted/80 text-muted-foreground",
                                        )}
                                    >
                                        {token}
                                        {tokenCounts[token] > 0 && (
                                            <span className="ml-1 opacity-70">({tokenCounts[token]})</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {showPriorityFilters && (
                        <div className="space-y-2">
                            <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.priority')}</div>
                            <div className="flex flex-wrap gap-2">
                                {priorityOptions.map((priority) => {
                                    const isActive = selectedPriorities.includes(priority);
                                    return (
                                        <button
                                            key={priority}
                                            type="button"
                                            onClick={() => onTogglePriority(priority)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                isActive
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted hover:bg-muted/80 text-muted-foreground",
                                            )}
                                        >
                                            {t(`priority.${priority}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {showTimeEstimateFilters && (
                        <div className="space-y-2">
                            <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.timeEstimate')}</div>
                            <div className="flex flex-wrap gap-2">
                                {timeEstimateOptions.map((estimate) => {
                                    const isActive = selectedTimeEstimates.includes(estimate);
                                    return (
                                        <button
                                            key={estimate}
                                            type="button"
                                            onClick={() => onToggleEstimate(estimate)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
                                                isActive
                                                    ? "bg-primary text-primary-foreground"
                                                    : "bg-muted hover:bg-muted/80 text-muted-foreground",
                                            )}
                                        >
                                            {formatEstimate(estimate)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
