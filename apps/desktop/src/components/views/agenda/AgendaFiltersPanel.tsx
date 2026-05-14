import type { TaskEnergyLevel, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { Filter, Save, X } from 'lucide-react';

import { cn } from '../../../lib/utils';

export type AgendaProjectFilterOption = {
    id: string;
    title: string;
    dotColor?: string;
};

export type AgendaActiveFilterChip = {
    id: string;
    label: string;
    dotColor?: string;
    isAdvanced?: boolean;
    onRemove?: () => void;
};

type AgendaFiltersPanelProps = {
    allTokens: string[];
    activeFilterChips: AgendaActiveFilterChip[];
    energyLevelOptions: TaskEnergyLevel[];
    formatEstimate: (estimate: TimeEstimate) => string;
    canSaveFilter: boolean;
    hasFilters: boolean;
    onSaveFilter: () => void;
    onClearFilters: () => void;
    onSearchChange: (value: string) => void;
    onToggleEnergy: (energyLevel: TaskEnergyLevel) => void;
    onToggleFiltersOpen: () => void;
    onToggleProject: (projectId: string) => void;
    onTogglePriority: (priority: TaskPriority) => void;
    onToggleTime: (estimate: TimeEstimate) => void;
    onToggleToken: (token: string) => void;
    prioritiesEnabled: boolean;
    projectOptions: AgendaProjectFilterOption[];
    priorityOptions: TaskPriority[];
    searchQuery: string;
    saveFilterLabel: string;
    selectedEnergyLevels: TaskEnergyLevel[];
    selectedProjects: string[];
    selectedPriorities: TaskPriority[];
    selectedTimeEstimates: TimeEstimate[];
    selectedTokens: string[];
    showNoProjectOption: boolean;
    showFiltersPanel: boolean;
    t: (key: string) => string;
    timeEstimateOptions: TimeEstimate[];
    timeEstimatesEnabled: boolean;
};

export function AgendaFiltersPanel({
    allTokens,
    activeFilterChips,
    energyLevelOptions,
    formatEstimate,
    canSaveFilter,
    hasFilters,
    onClearFilters,
    onSearchChange,
    onSaveFilter,
    onToggleEnergy,
    onToggleFiltersOpen,
    onToggleProject,
    onTogglePriority,
    onToggleTime,
    onToggleToken,
    prioritiesEnabled,
    projectOptions,
    priorityOptions,
    searchQuery,
    saveFilterLabel,
    selectedEnergyLevels,
    selectedProjects,
    selectedPriorities,
    selectedTimeEstimates,
    selectedTokens,
    showNoProjectOption,
    showFiltersPanel,
    t,
    timeEstimateOptions,
    timeEstimatesEnabled,
}: AgendaFiltersPanelProps) {
    return (
        <div className="space-y-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Filter className="h-4 w-4" />
                    {t('filters.label')}
                </div>
                <div className="flex items-center gap-2">
                    {canSaveFilter && (
                        <button
                            type="button"
                            onClick={onSaveFilter}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <Save className="h-3.5 w-3.5" aria-hidden="true" />
                            {saveFilterLabel}
                        </button>
                    )}
                    {hasFilters && (
                        <button
                            type="button"
                            onClick={onClearFilters}
                            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {t('filters.clear')}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onToggleFiltersOpen}
                        aria-expanded={showFiltersPanel}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                        {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                    </button>
                </div>
            </div>
            <input
                type="text"
                data-view-filter-input
                placeholder={t('common.search')}
                value={searchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {activeFilterChips.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {activeFilterChips.map((chip) => (
                        <span
                            key={chip.id}
                            className={cn(
                                'inline-flex min-h-8 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium',
                                chip.isAdvanced
                                    ? 'border border-dashed border-primary/50 bg-muted/40 text-primary'
                                    : 'bg-muted text-muted-foreground',
                            )}
                        >
                            {chip.dotColor && (
                                <span
                                    className="h-2 w-2 rounded-full"
                                    style={{ backgroundColor: chip.dotColor }}
                                    aria-hidden="true"
                                />
                            )}
                            {chip.label}
                            {chip.onRemove && (
                                <button
                                    type="button"
                                    onClick={chip.onRemove}
                                    aria-label={`${t('common.delete')} ${chip.label}`}
                                    className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-current transition-colors hover:bg-background/80"
                                >
                                    <X className="h-3 w-3" aria-hidden="true" />
                                </button>
                            )}
                        </span>
                    ))}
                </div>
            )}
            {showFiltersPanel && (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.contexts')}</div>
                        <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
                            {allTokens.map((token) => {
                                const isActive = selectedTokens.includes(token);
                                return (
                                    <button
                                        key={token}
                                        type="button"
                                        onClick={() => onToggleToken(token)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {token}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {(showNoProjectOption || projectOptions.length > 0) && (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.projects')}</div>
                            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
                                {showNoProjectOption && (
                                    <button
                                        type="button"
                                        onClick={() => onToggleProject('__no_project__')}
                                        aria-pressed={selectedProjects.includes('__no_project__')}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            selectedProjects.includes('__no_project__')
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {t('taskEdit.noProjectOption')}
                                    </button>
                                )}
                                {projectOptions.map((project) => {
                                    const isActive = selectedProjects.includes(project.id);
                                    return (
                                        <button
                                            key={project.id}
                                            type="button"
                                            onClick={() => onToggleProject(project.id)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {project.dotColor && (
                                                <span
                                                    className="h-2 w-2 rounded-full"
                                                    style={{ backgroundColor: project.dotColor }}
                                                    aria-hidden="true"
                                                />
                                            )}
                                            <span className="truncate max-w-[140px]">{project.title}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {prioritiesEnabled && (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.priority')}</div>
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
                                                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                            )}
                                        >
                                            {t(`priority.${priority}`)}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    <div className="space-y-2">
                        <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('taskEdit.energyLevel')}</div>
                        <div className="flex flex-wrap gap-2">
                            {energyLevelOptions.map((energyLevel) => {
                                const isActive = selectedEnergyLevels.includes(energyLevel);
                                return (
                                    <button
                                        key={energyLevel}
                                        type="button"
                                        onClick={() => onToggleEnergy(energyLevel)}
                                        aria-pressed={isActive}
                                        className={cn(
                                            'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
                                                ? 'bg-primary text-primary-foreground'
                                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                                        )}
                                    >
                                        {t(`energyLevel.${energyLevel}`)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {timeEstimatesEnabled && (
                        <div className="space-y-2">
                            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('filters.timeEstimate')}</div>
                            <div className="flex flex-wrap gap-2">
                                {timeEstimateOptions.map((estimate) => {
                                    const isActive = selectedTimeEstimates.includes(estimate);
                                    return (
                                        <button
                                            key={estimate}
                                            type="button"
                                            onClick={() => onToggleTime(estimate)}
                                            aria-pressed={isActive}
                                            className={cn(
                                                'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                                                isActive
                                                    ? 'bg-primary text-primary-foreground'
                                                    : 'bg-muted text-muted-foreground hover:bg-muted/80',
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
