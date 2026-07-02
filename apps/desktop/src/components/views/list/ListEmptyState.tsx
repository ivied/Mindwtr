import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';

type EmptyState = {
    title: string;
    body: string;
    action?: string;
};

type ListEmptyStateProps = {
    hasFilters: boolean;
    emptyState: EmptyState;
    onAddTask: () => void;
    primaryAction?: ReactNode;
    t: (key: string) => string;
};

export function ListEmptyState({ hasFilters, emptyState, onAddTask, primaryAction, t }: ListEmptyStateProps) {
    return (
        <div className="mx-auto my-8 flex w-full max-w-lg flex-col items-center gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center text-muted-foreground">
            {hasFilters ? (
                <p className="text-sm">{t('filters.noMatch')}</p>
            ) : (
                <>
                    <div className="text-base font-medium text-foreground">{emptyState.title}</div>
                    <p className="max-w-sm text-sm leading-6 text-muted-foreground">{emptyState.body}</p>
                    {primaryAction && (
                        <div className="mt-1 w-full max-w-xs">{primaryAction}</div>
                    )}
                    {emptyState.action && (
                        <Button
                            size="xs"
                            variant={primaryAction ? 'ghost' : 'primary'}
                            data-add-task-trigger
                            onClick={onAddTask}
                        >
                            {emptyState.action}
                        </Button>
                    )}
                </>
            )}
        </div>
    );
}
