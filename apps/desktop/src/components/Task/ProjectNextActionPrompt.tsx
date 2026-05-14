import { useId } from 'react';
import { translateWithFallback, type Task } from '@mindwtr/core';
import { Button } from '../ui/Button';

type ProjectNextActionPromptProps = {
    candidates: Task[];
    isOpen: boolean;
    newTitle: string;
    projectTitle: string;
    onAddTask: () => void;
    onCancel: () => void;
    onChooseTask: (taskId: string) => void;
    onNewTitleChange: (value: string) => void;
    t: (key: string) => string;
};

export function ProjectNextActionPrompt({
    candidates,
    isOpen,
    newTitle,
    projectTitle,
    onAddTask,
    onCancel,
    onChooseTask,
    onNewTitleChange,
    t,
}: ProjectNextActionPromptProps) {
    const titleId = useId();
    const descriptionId = useId();
    const candidateLabelId = useId();
    const inputId = useId();
    const canAddTask = newTitle.trim().length > 0;
    const resolveText = (key: string, fallback: string) => translateWithFallback(t, key, fallback);
    const description = resolveText(
        'projects.nextActionPromptDesc',
        'Choose or add the next action for {{project}}.',
    ).replace('{{project}}', projectTitle);

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[16vh] z-50"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onClick={onCancel}
        >
            <div
                className="w-full max-w-lg bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="px-4 py-3 border-b">
                    <h3 id={titleId} className="font-semibold">
                        {resolveText('projects.nextActionPromptTitle', "What's the next action?")}
                    </h3>
                    <p id={descriptionId} className="text-xs text-muted-foreground mt-1">
                        {description}
                    </p>
                </div>
                <div className="p-4 space-y-4">
                    {candidates.length > 0 && (
                        <div className="space-y-2">
                            <p id={candidateLabelId} className="text-xs font-medium text-muted-foreground">
                                {resolveText('projects.nextActionPromptChooseExisting', 'Choose an existing task')}
                            </p>
                            <div className="max-h-52 overflow-y-auto space-y-2" role="list" aria-labelledby={candidateLabelId}>
                                {candidates.map((candidate) => (
                                    <button
                                        key={candidate.id}
                                        type="button"
                                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                        onClick={() => onChooseTask(candidate.id)}
                                    >
                                        <span className="block text-sm font-medium">{candidate.title}</span>
                                        <span className="block text-xs text-muted-foreground mt-0.5">
                                            {t(`status.${candidate.status}`)}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="space-y-2">
                        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
                            {resolveText('projects.nextActionPromptAddNew', 'Add a new next action')}
                        </label>
                        <input
                            id={inputId}
                            autoFocus
                            type="text"
                            value={newTitle}
                            onChange={(event) => onNewTitleChange(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Escape') {
                                    event.preventDefault();
                                    onCancel();
                                }
                                if (event.key === 'Enter' && canAddTask) {
                                    event.preventDefault();
                                    onAddTask();
                                }
                            }}
                            placeholder={resolveText('projects.nextActionPromptPlaceholder', 'New next action...')}
                            className="w-full bg-card border border-border rounded-lg py-2 px-3 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                        />
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={onCancel}>
                            {resolveText('common.skip', 'Skip')}
                        </Button>
                        <Button onClick={onAddTask} disabled={!canAddTask}>
                            {resolveText('projects.nextActionPromptAddButton', 'Add next action')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
