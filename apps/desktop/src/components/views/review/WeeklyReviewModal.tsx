import { useEffect, useMemo, useState } from 'react';
import {
    createAIProvider,
    DEFAULT_AREA_COLOR,
    formatI18nTemplate,
    getStaleItems,
    getUsedTaskTokens,
    isDueForReview,
    isTaskInActiveProject,
    parseQuickAddDateCommands,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    shallow,
    type ExternalCalendarEvent,
    type ReviewSuggestion,
    useTaskStore,
    type Project,
    type Task,
    type TaskStatus,
    type AIProviderId,
} from '@mindwtr/core';
import { Archive, ArrowRight, Calendar, Check, CheckSquare, ChevronLeft, History, Layers, MapPin, RefreshCw, X, type LucideIcon } from 'lucide-react';

import { TaskItem } from '../../TaskItem';
import { ModalPortal } from '../../ModalPortal';
import { MindSweepLauncher } from '../../MindSweepModal';
import { PromptModal } from '../../PromptModal';
import { InboxProcessor } from '../InboxProcessor';
import { cn } from '../../../lib/utils';
import { useLanguage } from '../../../contexts/language-context';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../../lib/ai-config';
import { fetchExternalCalendarEvents, summarizeExternalCalendarWarnings } from '../../../lib/external-calendar-events';
import { useUiStore } from '../../../store/ui-store';

type ReviewStep = 'inbox' | 'stale' | 'calendar' | 'waiting' | 'contexts' | 'projects' | 'someday' | 'completed';
type ReviewStepDefinition = {
    id: ReviewStep;
    title: string;
    description: string;
    icon: LucideIcon;
    hasWork: boolean;
};
type CalendarReviewEntry = {
    task: Task;
    date: Date;
    kind: 'due' | 'start';
};
type ContextReviewGroup = {
    context: string;
    tasks: Task[];
};
type ExternalCalendarDaySummary = {
    dayStart: Date;
    events: ExternalCalendarEvent[];
    totalCount: number;
};

type WeeklyReviewGuideModalProps = {
    onClose: () => void;
};

export function WeeklyReviewGuideModal({ onClose }: WeeklyReviewGuideModalProps) {
    const [currentStep, setCurrentStep] = useState<ReviewStep>('inbox');
    const [isProcessing, setIsProcessing] = useState(false);
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const { tasks, projects, areas, settings, addProject, updateProject, updateTask, deleteTask, batchUpdateTasks } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
            addProject: state.addProject,
            updateProject: state.updateProject,
            updateTask: state.updateTask,
            deleteTask: state.deleteTask,
            batchUpdateTasks: state.batchUpdateTasks,
        }),
        shallow
    );
    const addTask = useTaskStore((state) => state.addTask);
    const showToast = useUiStore((state) => state.showToast);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const activeTasks = useMemo(
        () => tasks.filter((task) => !task.deletedAt && task.status !== 'reference' && isTaskInActiveProject(task, projectMap)),
        [projectMap, tasks],
    );
    const allContexts = useMemo(() => getUsedTaskTokens(activeTasks, (task) => task.contexts, { prefix: '@' }), [activeTasks]);
    const allTags = useMemo(() => getUsedTaskTokens(activeTasks, (task) => task.tags, { prefix: '#' }), [activeTasks]);
    const { t } = useLanguage();
    const [aiSuggestions, setAiSuggestions] = useState<ReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);
    const [externalCalendarEvents, setExternalCalendarEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalCalendarLoading, setExternalCalendarLoading] = useState(false);
    const [externalCalendarError, setExternalCalendarError] = useState<string | null>(null);

    const aiEnabled = settings?.ai?.enabled === true;
    const includeContextStep = settings?.gtd?.weeklyReview?.includeContextStep !== false;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;
    const staleItems = useMemo(() => getStaleItems(tasks, projects), [tasks, projects]);
    const staleItemTitleMap = useMemo(() => {
        return staleItems.reduce((acc, item) => {
            acc[item.id] = item.title;
            return acc;
        }, {} as Record<string, string>);
    }, [staleItems]);
    const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
    const staleTaskEntries = useMemo(() => staleItems
        .filter((item) => !item.id.startsWith('project:'))
        .flatMap((item) => {
            const task = taskById.get(item.id);
            return task ? [{ daysStale: item.daysStale, task }] : [];
        }), [staleItems, taskById]);
    const staleProjectItems = useMemo(
        () => staleItems.filter((item) => item.id.startsWith('project:')),
        [staleItems],
    );
    const calendarReviewItems = useMemo(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const upcomingEnd = new Date(startOfToday);
        upcomingEnd.setDate(upcomingEnd.getDate() + 7);
        const entries: CalendarReviewEntry[] = [];

        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (!isTaskInActiveProject(task, projectMap)) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            const dueDate = safeParseDueDate(task.dueDate);
            if (dueDate) entries.push({ task, date: dueDate, kind: 'due' });
            const startTime = safeParseDate(task.startTime);
            if (startTime) entries.push({ task, date: startTime, kind: 'start' });
        });

        const upcoming = entries
            .filter((entry) => entry.date >= startOfToday && entry.date < upcomingEnd)
            .sort((a, b) => a.date.getTime() - b.date.getTime());

        return upcoming;
    }, [tasks, projectMap]);
    const externalCalendarReviewItems = useMemo<ExternalCalendarDaySummary[]>(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const summaries: ExternalCalendarDaySummary[] = [];
        for (let offset = 0; offset < 7; offset += 1) {
            const dayStart = new Date(startOfToday);
            dayStart.setDate(dayStart.getDate() + offset);
            const dayEnd = new Date(dayStart);
            dayEnd.setDate(dayEnd.getDate() + 1);
            const dayEvents = externalCalendarEvents
                .filter((event) => {
                    const start = safeParseDate(event.start);
                    const end = safeParseDate(event.end);
                    if (!start || !end) return false;
                    return start.getTime() < dayEnd.getTime() && end.getTime() > dayStart.getTime();
                })
                .sort((a, b) => {
                    const aStart = safeParseDate(a.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                    const bStart = safeParseDate(b.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                    return aStart - bStart;
                });
            if (dayEvents.length > 0) {
                summaries.push({
                    dayStart,
                    events: dayEvents,
                    totalCount: dayEvents.length,
                });
            }
        }
        return summaries;
    }, [externalCalendarEvents]);
    const contextReviewGroups = useMemo<ContextReviewGroup[]>(() => {
        const groups = new Map<string, Task[]>();
        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (!isTaskInActiveProject(task, projectMap)) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            (task.contexts ?? []).forEach((contextValue) => {
                const normalized = contextValue.trim();
                if (!normalized) return;
                const existing = groups.get(normalized) ?? [];
                existing.push(task);
                groups.set(normalized, existing);
            });
        });
        return Array.from(groups.entries())
            .map(([context, contextTasks]) => ({
                context,
                tasks: contextTasks.sort((a, b) => a.title.localeCompare(b.title)),
            }))
            .sort((a, b) => (b.tasks.length - a.tasks.length) || a.context.localeCompare(b.context));
    }, [tasks, projectMap]);
    const inboxTasks = useMemo(() => tasks.filter((task) => (
        task.status === 'inbox'
        && !task.deletedAt
        && isTaskInActiveProject(task, projectMap)
    )), [projectMap, tasks]);
    const waitingTasks = useMemo(() => tasks.filter((task) => (
        task.status === 'waiting'
        && !task.deletedAt
        && isTaskInActiveProject(task, projectMap)
    )), [projectMap, tasks]);
    const waitingDue = useMemo(() => waitingTasks.filter((task) => isDueForReview(task.reviewAt)), [waitingTasks]);
    const waitingFuture = useMemo(() => waitingTasks.filter((task) => !isDueForReview(task.reviewAt)), [waitingTasks]);
    const somedayTasks = useMemo(() => tasks.filter((task) => (
        task.status === 'someday'
        && !task.deletedAt
        && isTaskInActiveProject(task, projectMap)
    )), [projectMap, tasks]);
    const somedayDue = useMemo(() => somedayTasks.filter((task) => isDueForReview(task.reviewAt)), [somedayTasks]);
    const somedayFuture = useMemo(() => somedayTasks.filter((task) => !isDueForReview(task.reviewAt)), [somedayTasks]);
    const activeProjects = useMemo(
        () => projects.filter((project) => project.status === 'active' && !project.deletedAt),
        [projects],
    );
    const dueProjects = useMemo(() => activeProjects.filter((project) => isDueForReview(project.reviewAt)), [activeProjects]);
    const futureProjects = useMemo(() => activeProjects.filter((project) => !isDueForReview(project.reviewAt)), [activeProjects]);
    const orderedProjects = useMemo(() => [...dueProjects, ...futureProjects], [dueProjects, futureProjects]);

    const steps = useMemo<ReviewStepDefinition[]>(() => {
        const calendarHasWork = calendarReviewItems.length > 0
            || externalCalendarReviewItems.length > 0
            || Boolean(externalCalendarError);
        const list: ReviewStepDefinition[] = [
            { id: 'inbox', title: t('review.inboxStep'), description: t('review.inboxStepDesc'), icon: CheckSquare, hasWork: inboxTasks.length > 0 },
            { id: 'stale', title: t('review.staleStep'), description: t('review.staleStepDesc'), icon: History, hasWork: staleItems.length > 0 },
        ];
        list.push(
            { id: 'calendar', title: t('review.calendarStep'), description: t('review.calendarStepDesc'), icon: Calendar, hasWork: calendarHasWork },
            { id: 'waiting', title: t('review.waitingStep'), description: t('review.waitingStepDesc'), icon: ArrowRight, hasWork: waitingTasks.length > 0 },
        );
        if (includeContextStep) {
            list.push({ id: 'contexts', title: t('review.contexts'), description: t('review.contextsStepDesc'), icon: MapPin, hasWork: contextReviewGroups.length > 0 });
        }
        list.push(
            { id: 'projects', title: t('review.projectsStep'), description: t('review.projectsStepDesc'), icon: Layers, hasWork: orderedProjects.length > 0 },
            { id: 'someday', title: t('review.somedayStep'), description: t('review.somedayStepDesc'), icon: Archive, hasWork: somedayTasks.length > 0 },
            { id: 'completed', title: t('review.allDone'), description: t('review.allDoneDesc'), icon: Check, hasWork: true },
        );
        return list;
    }, [
        calendarReviewItems.length,
        contextReviewGroups.length,
        externalCalendarError,
        externalCalendarReviewItems.length,
        inboxTasks.length,
        includeContextStep,
        orderedProjects.length,
        somedayTasks.length,
        staleItems.length,
        t,
        waitingTasks.length,
    ]);
    const activeSteps = useMemo(
        () => steps.filter((step) => step.hasWork || step.id === 'completed'),
        [steps],
    );

    const displayedStep = activeSteps.some((step) => step.id === currentStep)
        ? currentStep
        : activeSteps[0]?.id ?? 'completed';
    const currentStepIndex = steps.findIndex((step) => step.id === displayedStep);
    const safeStepIndex = currentStepIndex >= 0 ? currentStepIndex : 0;
    const activeStepIndex = activeSteps.findIndex((step) => step.id === displayedStep);
    const progress = (safeStepIndex / Math.max(1, steps.length - 1)) * 100;

    useEffect(() => {
        if (!activeSteps.some((step) => step.id === currentStep)) {
            setCurrentStep(activeSteps[0]?.id ?? 'completed');
        }
    }, [activeSteps, currentStep]);

    useEffect(() => {
        if (displayedStep !== 'inbox' && isProcessing) {
            setIsProcessing(false);
        }
    }, [displayedStep, isProcessing]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        let cancelled = false;
        const loadCalendar = async () => {
            setExternalCalendarLoading(true);
            setExternalCalendarError(null);
            try {
                const now = new Date();
                const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const rangeEnd = new Date(rangeStart);
                rangeEnd.setDate(rangeEnd.getDate() + 7);
                rangeEnd.setMilliseconds(-1);
                const { events, warnings } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendarEvents(events);
                setExternalCalendarError(summarizeExternalCalendarWarnings(warnings));
            } catch (error) {
                if (cancelled) return;
                setExternalCalendarError(error instanceof Error ? error.message : String(error));
                setExternalCalendarEvents([]);
            } finally {
                if (!cancelled) setExternalCalendarLoading(false);
            }
        };
        loadCalendar();
        return () => {
            cancelled = true;
        };
    }, []);

    const nextStep = () => {
        if (activeStepIndex < 0) {
            setCurrentStep(activeSteps[0]?.id ?? 'completed');
            return;
        }
        if (activeStepIndex < activeSteps.length - 1) {
            setCurrentStep(activeSteps[activeStepIndex + 1].id);
        }
    };

    const prevStep = () => {
        if (activeStepIndex > 0) {
            setCurrentStep(activeSteps[activeStepIndex - 1].id);
        }
    };

    const renderStepRail = () => (
        <div className="mt-3 flex flex-wrap gap-2">
            {steps.map((step, index) => {
                const skipped = !step.hasWork && step.id !== 'completed';
                const complete = skipped || index < safeStepIndex;
                const current = step.id === displayedStep;
                return (
                    <div
                        key={step.id}
                        className={cn(
                            "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px]",
                            current
                                ? "border-primary bg-primary/10 text-foreground"
                                : complete
                                    ? "border-green-500/30 bg-green-500/10 text-muted-foreground"
                                    : "border-border bg-muted/30 text-muted-foreground",
                        )}
                    >
                        <span
                            className={cn(
                                "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold",
                                current
                                    ? "bg-primary text-primary-foreground"
                                    : complete
                                        ? "bg-green-500 text-white"
                                        : "bg-muted text-muted-foreground",
                            )}
                        >
                            {complete ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
                        </span>
                        <span className="max-w-[9rem] truncate">{step.title}</span>
                    </div>
                );
            })}
        </div>
    );

    const getSuggestionProjectId = (id: string) => (
        id.startsWith('project:') ? id.slice('project:'.length) : null
    );

    const getSuggestionProjectStatus = (action: ReviewSuggestion['action']): Project['status'] | null => {
        if (action === 'someday') return 'someday';
        if (action === 'archive') return 'archived';
        return null;
    };

    const isActionableSuggestion = (suggestion: ReviewSuggestion) => (
        suggestion.action === 'someday' || suggestion.action === 'archive'
    );

    const toggleSuggestion = (id: string) => {
        setAiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const runAiAnalysis = async () => {
        setAiError(null);
        setAiRan(true);
        if (!aiEnabled) {
            setAiError(t('ai.disabledBody'));
            return;
        }
        const apiKey = await loadAIKey(aiProvider);
        if (isAIKeyRequired(settings) && !apiKey) {
            setAiError(t('ai.missingKeyBody'));
            return;
        }
        if (staleItems.length === 0) {
            setAiSuggestions([]);
            setAiSelectedIds(new Set());
            return;
        }
        setAiLoading(true);
        try {
            const provider = createAIProvider(await buildAIConfig(settings, apiKey));
            const response = await provider.analyzeReview({ items: staleItems });
            setAiSuggestions(response.suggestions || []);
            const defaultSelected = new Set(
                (response.suggestions || [])
                    .filter(isActionableSuggestion)
                    .map((suggestion) => suggestion.id),
            );
            setAiSelectedIds(defaultSelected);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message || t('ai.errorBody'));
        } finally {
            setAiLoading(false);
        }
    };

    const applyAiSuggestions = async () => {
        const selectedSuggestions = aiSuggestions
            .filter((suggestion) => aiSelectedIds.has(suggestion.id))
            .filter(isActionableSuggestion);

        const taskUpdates = selectedSuggestions
            .filter((suggestion) => !getSuggestionProjectId(suggestion.id))
            .map((suggestion) => {
                if (suggestion.action === 'someday') {
                    return { id: suggestion.id, updates: { status: 'someday' as TaskStatus } };
                }
                if (suggestion.action === 'archive') {
                    return { id: suggestion.id, updates: { status: 'archived' as TaskStatus, completedAt: new Date().toISOString() } };
                }
                return null;
            })
            .filter(Boolean) as Array<{ id: string; updates: Partial<Task> }>;

        const projectUpdates = selectedSuggestions
            .map((suggestion) => {
                const projectId = getSuggestionProjectId(suggestion.id);
                const status = getSuggestionProjectStatus(suggestion.action);
                return projectId && status ? { id: projectId, updates: { status } } : null;
            })
            .filter(Boolean) as Array<{ id: string; updates: Partial<Project> }>;

        if (taskUpdates.length === 0 && projectUpdates.length === 0) return;
        if (taskUpdates.length > 0) {
            await batchUpdateTasks(taskUpdates);
        }
        await Promise.all(projectUpdates.map((update) => updateProject(update.id, update.updates)));
    };

    const openQuickAdd = (initialProps?: Partial<Task>) => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: initialProps ?? {} },
        }));
    };

    const toggleExternalDayExpanded = (dayKey: string) => {
        setExpandedExternalDays((prev) => {
            const next = new Set(prev);
            if (next.has(dayKey)) {
                next.delete(dayKey);
            } else {
                next.add(dayKey);
            }
            return next;
        });
    };

    const toggleContextGroupExpanded = (contextKey: string) => {
        setExpandedContextGroups((prev) => {
            const next = new Set(prev);
            if (next.has(contextKey)) {
                next.delete(contextKey);
            } else {
                next.add(contextKey);
            }
            return next;
        });
    };

    const confirmProjectTaskPrompt = (value: string) => {
        const targetProject = projectTaskPrompt;
        if (!targetProject) return;

        const trimmed = value.trim();
        if (!trimmed) return;

        const { title, props, invalidDateCommands } = parseQuickAddDateCommands(trimmed, new Date(), {
            preserveText: settings.quickAddAutoClean !== true,
        });
        if (invalidDateCommands && invalidDateCommands.length > 0) {
            showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
            return;
        }

        const parsedTitle = title.trim();
        if (!parsedTitle) return;

        void (async () => {
            await addTask(parsedTitle, {
                projectId: targetProject.projectId,
                status: 'next',
                ...props,
            });
            setProjectTaskPrompt(null);
        })();
    };

    const renderMindSweepNudge = () => (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground">{t('mindSweep.title')}</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('mindSweep.intro')}</p>
            </div>
            <MindSweepLauncher t={t} addTask={addTask} />
        </div>
    );

    const renderCalendarList = (items: CalendarReviewEntry[]) => {
        if (items.length === 0) {
            return <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>;
        }
        return (
            <div className="space-y-2">
                {items.slice(0, 12).map((entry) => (
                    <div key={`${entry.kind}-${entry.task.id}-${entry.date.toISOString()}`} className="flex items-start gap-3 text-sm">
                        <div className="min-w-0">
                            <div className="font-medium truncate">{entry.task.title}</div>
                            <div className="text-xs text-muted-foreground">
                                {(entry.kind === 'due' ? t('taskEdit.dueDateLabel') : t('review.startTime'))}
                                {' / '}
                                {safeFormatDate(entry.date, 'Pp')}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    };
    const renderExternalCalendarList = (days: ExternalCalendarDaySummary[]) => {
        if (externalCalendarLoading) {
            return <div className="text-sm text-muted-foreground">{t('common.loading')}</div>;
        }
        if (externalCalendarError) {
            return <div className="text-sm text-muted-foreground">{externalCalendarError}</div>;
        }
        if (days.length === 0) {
            return <div className="text-sm text-muted-foreground">{t('calendar.noTasks')}</div>;
        }
        return (
            <div className="space-y-2">
                {days.map((day) => (
                    <div key={day.dayStart.toISOString()} className="rounded-md border border-border/70 p-2.5">
                        {(() => {
                            const dayKey = day.dayStart.toISOString();
                            const isExpanded = expandedExternalDays.has(dayKey);
                            const visibleEvents = isExpanded ? day.events : day.events.slice(0, 2);
                            return (
                                <>
                        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            {safeFormatDate(day.dayStart, 'EEEE, PP')} · {day.totalCount} {t('calendar.events')}
                        </div>
                        <div className="mt-1.5 space-y-1">
                            {visibleEvents.map((event) => {
                                const start = safeParseDate(event.start);
                                const timeLabel = event.allDay || !start ? t('calendar.allDay') : safeFormatDate(start, 'p');
                                return (
                                    <div key={`${event.sourceId}-${event.id}-${event.start}`} className="text-sm flex gap-2">
                                        <span className="text-muted-foreground w-12 shrink-0">{timeLabel}</span>
                                        <span className="font-medium truncate">{event.title}</span>
                                    </div>
                                );
                            })}
                            {day.totalCount > 2 && (
                                <button
                                    type="button"
                                    onClick={() => toggleExternalDayExpanded(dayKey)}
                                    className="text-xs text-primary hover:text-primary/80 font-medium"
                                >
                                    {isExpanded
                                        ? t('common.less')
                                        : `+${day.totalCount - visibleEvents.length} ${t('common.more').toLowerCase()}`}
                                </button>
                            )}
                        </div>
                                </>
                            );
                        })()}
                    </div>
                ))}
            </div>
        );
    };

    const renderStepContent = () => {
        switch (displayedStep) {
            case 'inbox': {
                return (
                    <div className="space-y-4">
                        <div className="bg-muted/30 p-4 rounded-lg border border-border">
                            <h3 className="font-semibold mb-2">{t('review.inboxZero')}</h3>
                            <p className="text-sm text-muted-foreground">
                                <span className="font-bold text-foreground">{inboxTasks.length}</span> {t('review.inboxZeroDesc')}
                            </p>
                        </div>
                        {renderMindSweepNudge()}
                        <InboxProcessor
                            t={t}
                            isInbox
                            tasks={tasks}
                            projects={projects}
                            areas={areas}
                            settings={settings}
                            addTask={addTask}
                            addProject={addProject}
                            updateTask={updateTask}
                            deleteTask={deleteTask}
                            allContexts={allContexts}
                            allTags={allTags}
                            isProcessing={isProcessing}
                            setIsProcessing={setIsProcessing}
                        />
                        <div className="space-y-2">
                            {inboxTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <Check className="w-12 h-12 mx-auto mb-4 text-green-500" />
                                    <p>{t('review.inboxEmpty')}</p>
                                </div>
                            ) : (
                                inboxTasks.map((task) => (
                                    <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                ))
                            )}
                        </div>
                    </div>
                );
            }

            case 'calendar':
                return (
                    <div className="space-y-6">
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => openQuickAdd({ status: 'inbox' })}
                                className="px-3 py-1.5 rounded-md border border-border text-sm text-foreground hover:bg-muted/40 transition-colors"
                            >
                                {t('calendar.addTask')}
                            </button>
                        </div>
                        <div className="space-y-2">
                            <h3 className="font-semibold text-muted-foreground uppercase text-xs tracking-wider">
                                {t('calendar.events')}
                            </h3>
                            <p className="text-xs text-muted-foreground">{t('review.calendarStepDesc')}</p>
                            <div className="bg-card border border-border rounded-lg p-4 min-h-[200px] space-y-3">
                                {renderExternalCalendarList(externalCalendarReviewItems)}
                            </div>
                        </div>
                        <div className="space-y-2">
                            <h3 className="font-semibold text-muted-foreground uppercase text-xs tracking-wider">
                                {t('review.calendarStep')}
                            </h3>
                            <p className="text-xs text-muted-foreground">{t('review.upcoming14Desc')}</p>
                        </div>
                        <div className="bg-card border border-border rounded-lg p-4 min-h-[200px] space-y-3">
                            {renderCalendarList(calendarReviewItems)}
                        </div>
                    </div>
                );

            case 'waiting': {
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">
                            {t('review.waitingHint')}
                        </p>
                        <div className="space-y-2">
                            {waitingTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <p>{t('review.waitingEmpty')}</p>
                                </div>
                            ) : (
                                <>
                                    {waitingDue.length > 0 && waitingDue.map((task) => (
                                        <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                    ))}
                                    {waitingFuture.length > 0 && (
                                        <div className="pt-4">
                                            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                                {t('review.notDueYet')}
                                            </h4>
                                            {waitingFuture.map((task) => (
                                                <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );
            }
            case 'contexts': {
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">{t('review.contextsStepDesc')}</p>
                        {contextReviewGroups.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <p>{t('review.contextsEmpty')}</p>
                            </div>
                        ) : (
                            contextReviewGroups.map((group) => (
                                <div key={group.context} className="border border-border rounded-lg p-4 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <h3 className="font-semibold">{group.context}</h3>
                                        <span className="text-xs text-muted-foreground">{group.tasks.length}</span>
                                    </div>
                                    <div className="space-y-1.5">
                                        {(() => {
                                            const contextKey = group.context;
                                            const isExpanded = expandedContextGroups.has(contextKey);
                                            const visibleTasks = isExpanded ? group.tasks : group.tasks.slice(0, 4);
                                            return (
                                                <>
                                                    {visibleTasks.map((task) => (
                                                        <TaskItem key={`${group.context}-${task.id}`} task={task} showProjectBadgeInActions={false} />
                                                    ))}
                                                    {group.tasks.length > 4 && (
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleContextGroupExpanded(contextKey)}
                                                            className="text-xs text-primary hover:text-primary/80 font-medium"
                                                        >
                                                            {isExpanded
                                                                ? t('common.less')
                                                                : `+${group.tasks.length - visibleTasks.length} ${t('common.more').toLowerCase()}`}
                                                        </button>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                );
            }

            case 'stale': {
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">{t('review.staleStepDesc')}</p>
                        {staleItems.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <p>{t('review.aiEmpty')}</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {staleTaskEntries.map(({ daysStale, task }) => (
                                    <div key={task.id} className="flex items-center gap-3">
                                        <div className="flex-1 min-w-0">
                                            <TaskItem task={task} showProjectBadgeInActions={false} />
                                        </div>
                                        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                                            {formatI18nTemplate(t('review.staleDaysInactive'), { days: daysStale })}
                                        </span>
                                    </div>
                                ))}
                                {staleProjectItems.map((item) => (
                                    <div key={item.id} className="border border-border rounded-lg p-3 flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            <span className="text-sm font-medium truncate">{item.title}</span>
                                        </div>
                                        <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
                                            {formatI18nTemplate(t('review.staleDaysInactive'), { days: item.daysStale })}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                        {aiEnabled && (
                    <div className="space-y-4 border-t border-border pt-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="text-sm text-muted-foreground">
                                {t('review.aiStepDesc')}
                            </div>
                            <button
                                onClick={runAiAnalysis}
                                className="bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={aiLoading}
                            >
                                {aiLoading ? t('review.aiRunning') : t('review.aiRun')}
                            </button>
                        </div>

                        {aiError && (
                            <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-md p-3">
                                {aiError}
                            </div>
                        )}

                        {aiRan && !aiLoading && aiSuggestions.length === 0 && !aiError && (
                            <div className="text-sm text-muted-foreground">{t('review.aiEmpty')}</div>
                        )}

                        {aiSuggestions.length > 0 && (
                            <div className="space-y-3">
                                {aiSuggestions.map((suggestion) => {
                                    const actionable = isActionableSuggestion(suggestion);
                                    const suggestionTitle = staleItemTitleMap[suggestion.id] || suggestion.id;
                                    const actionLabel = t(`review.aiAction.${suggestion.action}`);
                                    return (
                                        <div
                                            key={suggestion.id}
                                            className="border border-border rounded-lg p-3 flex items-start gap-3"
                                        >
                                            {actionable ? (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleSuggestion(suggestion.id)}
                                                    className={cn(
                                                        "mt-1 h-4 w-4 rounded border flex items-center justify-center text-xs",
                                                        aiSelectedIds.has(suggestion.id)
                                                            ? "bg-primary text-primary-foreground border-primary"
                                                            : "border-border text-muted-foreground",
                                                    )}
                                                    aria-label={`${suggestionTitle}: ${actionLabel}`}
                                                    aria-pressed={aiSelectedIds.has(suggestion.id)}
                                                >
                                                    {aiSelectedIds.has(suggestion.id) ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
                                                </button>
                                            ) : (
                                                <span className="mt-1 h-4 w-4 rounded border border-border/50" />
                                            )}
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-sm font-medium">{suggestionTitle}</span>
                                                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                                                        {actionLabel}
                                                    </span>
                                                </div>
                                                <div className="text-xs text-muted-foreground mt-1">{suggestion.reason}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                                <div className="flex justify-end">
                                    <button
                                        onClick={applyAiSuggestions}
                                        className="bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                        disabled={aiSelectedIds.size === 0}
                                    >
                                        {t('review.aiApply')} ({aiSelectedIds.size})
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                        )}
                    </div>
                );
            }

            case 'projects': {
                return (
                    <div className="space-y-6">
                        <p className="text-muted-foreground">{t('review.projectsHint')}</p>
                        <div className="space-y-4">
                            {orderedProjects.map((project) => {
                                const projectTasks = tasks.filter((task) => (
                                    task.projectId === project.id
                                    && !task.deletedAt
                                    && task.status !== 'done'
                                    && task.status !== 'reference'
                                ));
                                const hasNextAction = projectTasks.some((task) => task.status === 'next');

                                return (
                                    <div key={project.id} className="border border-border rounded-lg p-4">
                                        <div className="flex items-center justify-between gap-3 mb-3">
                                            <div className="flex items-center gap-2">
                                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || DEFAULT_AREA_COLOR }} />
                                                <h3 className="font-semibold">{project.title}</h3>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setProjectTaskPrompt({ projectId: project.id, projectTitle: project.title })}
                                                    className="px-2.5 py-1 rounded-md border border-border text-xs text-foreground hover:bg-muted/40 transition-colors"
                                                >
                                                    {t('projects.addTask')}
                                                </button>
                                                <div
                                                    className={cn("text-xs px-2 py-1 rounded-full", hasNextAction ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600")}
                                                >
                                                    {hasNextAction ? t('review.hasNextAction') : t('review.needsAction')}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="space-y-2 pl-5">
                                            {projectTasks.map((task) => (
                                                <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                            ))}
                                            {projectTasks.length > 0 && (
                                                <div className="mt-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/50">
                                                    <span className="font-semibold mr-1">{t('review.stuckQuestion')}</span>
                                                    {t('review.stuckPrompt')}
                                                </div>
                                            )}
                                            {projectTasks.length === 0 && (
                                                <div className="text-sm text-muted-foreground italic">{t('review.noActiveTasks')}</div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                );
            }

            case 'someday': {
                return (
                    <div className="space-y-4">
                        <p className="text-muted-foreground">
                            {t('review.somedayHint')}
                        </p>
                        <div className="space-y-2">
                            {somedayTasks.length === 0 ? (
                                <div className="text-center py-12 text-muted-foreground">
                                    <p>{t('review.listEmpty')}</p>
                                </div>
                            ) : (
                                <>
                                    {somedayDue.length > 0 && somedayDue.map((task) => (
                                        <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                    ))}
                                    {somedayFuture.length > 0 && (
                                        <div className="pt-4">
                                            <h4 className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                                                {t('review.notDueYet')}
                                            </h4>
                                            {somedayFuture.map((task) => (
                                                <TaskItem key={task.id} task={task} showProjectBadgeInActions={false} />
                                            ))}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                );
            }

            case 'completed':
                return (
                    <div className="text-center space-y-6 py-12">
                        <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                            <Check className="w-10 h-10 text-green-600" />
                        </div>
                        <h2 className="text-3xl font-bold">{t('review.complete')}</h2>
                        <p className="text-muted-foreground text-lg max-w-md mx-auto">
                            {t('review.completeDesc')}
                        </p>
                        <div className="mx-auto max-w-lg text-left">
                            {renderMindSweepNudge()}
                        </div>
                        <button
                            onClick={onClose}
                            className="bg-primary text-primary-foreground px-8 py-3 rounded-lg text-lg font-medium hover:bg-primary/90 transition-colors"
                        >
                            {t('review.finish')}
                        </button>
                    </div>
                );
        }
    };

    return (
        <ModalPortal>
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            role="dialog"
            aria-modal="true"
            aria-label={t('review.title')}
            onClick={onClose}
        >
            <div
                className="bg-card border border-border rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                    <h3 className="text-[15px] font-semibold flex items-center gap-2.5">
                        <RefreshCw className="w-4 h-4 text-primary" />
                        {t('review.title')}
                    </h3>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-md hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t('common.close')}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-5 flex flex-col flex-1 min-h-0">
                    <div className="mb-5">
                        <div className="flex items-center justify-between mb-3">
                            <h1 className="text-lg font-semibold flex items-center gap-2">
                                {(() => {
                                    const Icon = steps[safeStepIndex].icon;
                                    return Icon && <Icon className="w-[18px] h-[18px] text-primary" />;
                                })()}
                                {steps[safeStepIndex].title}
                            </h1>
                            <span className="text-xs text-muted-foreground">
                                {t('review.step')} {safeStepIndex + 1} {t('review.of')} {steps.length}
                            </span>
                        </div>
                        <div className="h-1 bg-muted rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary transition-all duration-500 ease-in-out rounded-full"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                        {renderStepRail()}
                    </div>

                    <div className="flex-1 overflow-y-auto pr-2">
                        {renderStepContent()}
                    </div>

                    {displayedStep !== 'completed' && (
                        <div className="flex justify-between items-center pt-3.5 border-t border-border mt-5">
                            <button
                                onClick={prevStep}
                                className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" /> {t('review.back')}
                            </button>
                            <button
                                onClick={nextStep}
                                className="flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors"
                            >
                                {t('review.nextStepBtn')} <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
            <PromptModal
                isOpen={Boolean(projectTaskPrompt)}
                title={t('projects.addTask')}
                description={projectTaskPrompt ? `${projectTaskPrompt.projectTitle}` : undefined}
                placeholder={t('nav.addTask')}
                defaultValue=""
                confirmLabel={t('common.add')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setProjectTaskPrompt(null)}
                onConfirm={confirmProjectTaskPrompt}
            />
        </div>
        </ModalPortal>
    );
}
