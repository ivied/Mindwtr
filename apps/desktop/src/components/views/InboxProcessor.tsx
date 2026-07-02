import { Play } from 'lucide-react';
import type { AppData, Area, Project, Task } from '@mindwtr/core';

import { InboxProcessingQuickPanel } from '../InboxProcessingQuickPanel';
import { InboxProcessingWizard } from '../InboxProcessingWizard';
import { MindSweepLauncher } from '../MindSweepModal';
import { useInboxProcessingController } from './inbox/useInboxProcessingController';

type InboxProcessorProps = {
    t: (key: string) => string;
    isInbox: boolean;
    tasks: Task[];
    projects: Project[];
    areas: Area[];
    settings?: AppData['settings'];
    addTask: (title: string, initialProps?: Partial<Task>) => Promise<unknown>;
    addProject: (title: string, color: string, initialProps?: Partial<Project>) => Promise<Project | null>;
    updateTask: (id: string, updates: Partial<Task>) => Promise<unknown>;
    deleteTask: (id: string) => Promise<unknown>;
    allContexts: string[];
    allTags: string[];
    isProcessing: boolean;
    setIsProcessing: (value: boolean) => void;
};

export function InboxProcessor({
    t,
    isInbox,
    tasks,
    projects,
    areas,
    settings,
    addTask,
    addProject,
    updateTask,
    deleteTask,
    allContexts,
    allTags,
    isProcessing,
    setIsProcessing,
}: InboxProcessorProps) {
    const {
        inboxCount,
        quickPanelProps,
        showStartButton,
        startProcessing,
        wizardProps,
    } = useInboxProcessingController({
        t,
        tasks,
        projects,
        areas,
        settings,
        addProject,
        updateTask,
        deleteTask,
        allContexts,
        allTags,
        isProcessing,
        setIsProcessing,
    });

    if (!isInbox) return null;

    return (
        <>
            {showStartButton && (
                <div className="flex items-stretch gap-2">
                    <button
                        onClick={startProcessing}
                        className="flex-1 flex items-center justify-center gap-2 bg-primary text-primary-foreground py-3 px-4 rounded-lg font-medium hover:bg-primary/90 transition-colors"
                    >
                        <Play className="w-4 h-4" />
                        {t('process.btn')} ({inboxCount})
                    </button>
                    <MindSweepLauncher t={t} addTask={addTask} variant="secondary" />
                </div>
            )}

            {quickPanelProps ? (
                <InboxProcessingQuickPanel {...quickPanelProps} />
            ) : (
                <InboxProcessingWizard {...wizardProps} />
            )}
        </>
    );
}
