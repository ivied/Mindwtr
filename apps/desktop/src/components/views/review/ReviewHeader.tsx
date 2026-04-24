import { ChevronDown, List } from 'lucide-react';
import type { TaskSortBy } from '@mindwtr/core';
import { cn } from '../../../lib/utils';

type ReviewHeaderProps = {
    title: string;
    taskCountLabel: string;
    selectionMode: boolean;
    onToggleSelection: () => void;
    sortBy: TaskSortBy;
    onChangeSortBy: (value: TaskSortBy) => void;
    showListDetails: boolean;
    onToggleDetails: () => void;
    onShowDailyGuide: () => void;
    onShowGuide: () => void;
    t: (key: string) => string;
    labels: {
        select: string;
        exitSelect: string;
        dailyReview: string;
        weeklyReview: string;
    };
};

export function ReviewHeader({
    title,
    taskCountLabel,
    selectionMode,
    onToggleSelection,
    sortBy,
    onChangeSortBy,
    showListDetails,
    onToggleDetails,
    onShowDailyGuide,
    onShowGuide,
    t,
    labels,
}: ReviewHeaderProps) {
    const controlBaseClass = "text-xs border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40";
    const controlMutedClass = "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground";
    const controlActiveClass = "bg-primary/10 text-primary border-primary";

    return (
        <header className="flex items-center justify-between">
            <div className="space-y-1">
                <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
                <p className="text-sm text-muted-foreground">{taskCountLabel}</p>
            </div>
            <div className="flex items-center gap-3">
                <div className="relative">
                    <select
                        value={sortBy}
                        onChange={(event) => onChangeSortBy(event.target.value as TaskSortBy)}
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
                <button
                    onClick={onToggleSelection}
                    className={cn(
                        controlBaseClass,
                        "px-3 py-2 rounded-xl",
                        selectionMode
                            ? controlActiveClass
                            : controlMutedClass,
                    )}
                >
                    {selectionMode ? labels.exitSelect : labels.select}
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
                    onClick={onShowDailyGuide}
                    className="bg-muted/50 text-foreground px-4 py-2 rounded-xl hover:bg-muted transition-colors"
                >
                    {labels.dailyReview}
                </button>
                <button
                    onClick={onShowGuide}
                    className="bg-primary text-primary-foreground px-4 py-2 rounded-xl hover:bg-primary/90 transition-colors"
                >
                    {labels.weeklyReview}
                </button>
            </div>
        </header>
    );
}
