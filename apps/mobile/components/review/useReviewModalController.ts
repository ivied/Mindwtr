import { useCallback, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    createAIProvider,
    getStaleItems,
    isTaskInActiveProject,
    isDueForReview,
    safeParseDate,
    safeParseDueDate,
    type AIProviderId,
    type ExternalCalendarEvent,
    type Project,
    type ReviewSuggestion,
    type Task,
    type TaskStatus,
    useTaskStore,
} from '@mindwtr/core';
import {
    Calendar as CalendarIcon,
    CheckCircle2,
    Clock,
    FolderOpen,
    History,
    Inbox,
    Lightbulb,
    Tag,
    type LucideIcon,
} from 'lucide-react-native';

import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';
import { useQuickCapture } from '../../contexts/quick-capture-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { buildAIConfig, isAIKeyRequired, loadAIKey } from '../../lib/ai-config';
import { logError } from '../../lib/app-log';
import { fetchExternalCalendarEvents } from '../../lib/external-calendar';
import { maybeRequestStoreReviewAfterPositiveMoment } from '../../lib/store-review-prompt';
import { getReviewLabels } from '../review-modal.labels';

export type ReviewStep =
    | 'inbox'
    | 'stale'
    | 'calendar'
    | 'waiting'
    | 'contexts'
    | 'projects'
    | 'someday'
    | 'completed';

export type ReviewStepDefinition = {
    Icon: LucideIcon;
    hasWork: boolean;
    id: ReviewStep;
    title: string;
};

export type ExternalCalendarDaySummary = {
    dayStart: Date;
    events: ExternalCalendarEvent[];
    totalCount: number;
};

export type ContextReviewGroup = {
    context: string;
    tasks: Task[];
};

export type CalendarTaskReviewEntry = {
    task: Task;
    date: Date;
    kind: 'due' | 'start';
};

export type ReviewProjectEntry = {
    areaColor: string;
    hasNextAction: boolean;
    project: Project;
    tasks: Task[];
};

type UseReviewModalControllerParams = {
    onClose: () => void;
    visible: boolean;
};

export function useReviewModalController({
    onClose,
    visible,
}: UseReviewModalControllerParams) {
    const { tasks, projects, areas, updateTask, deleteTask, settings, batchUpdateTasks, addTask } = useTaskStore();
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const { isDark } = useTheme();
    const { t } = useLanguage();
    const { openQuickCapture } = useQuickCapture();
    const [currentStep, setCurrentStep] = useState<ReviewStep>('inbox');
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [showEditModal, setShowEditModal] = useState(false);
    const [expandedProject, setExpandedProject] = useState<string | null>(null);
    const [aiSuggestions, setAiSuggestions] = useState<ReviewSuggestion[]>([]);
    const [aiSelectedIds, setAiSelectedIds] = useState<Set<string>>(new Set());
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiRan, setAiRan] = useState(false);
    const [externalCalendarEvents, setExternalCalendarEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalCalendarLoading, setExternalCalendarLoading] = useState(false);
    const [externalCalendarError, setExternalCalendarError] = useState<string | null>(null);
    const [expandedExternalDays, setExpandedExternalDays] = useState<Set<string>>(new Set());
    const [expandedContextGroups, setExpandedContextGroups] = useState<Set<string>>(new Set());
    const [projectTaskPrompt, setProjectTaskPrompt] = useState<{ projectId: string; projectTitle: string } | null>(null);
    const [projectTaskTitle, setProjectTaskTitle] = useState('');

    const labels = useMemo(() => getReviewLabels(t), [t]);
    const tc = useThemeColors();
    const aiEnabled = settings?.ai?.enabled === true;
    const includeContextStep = settings?.gtd?.weeklyReview?.includeContextStep !== false;
    const aiProvider = (settings?.ai?.provider ?? 'openai') as AIProviderId;

    const handleClose = useCallback(() => {
        setCurrentStep('inbox');
        setExpandedExternalDays(new Set());
        setExpandedContextGroups(new Set());
        onClose();
    }, [onClose]);

    const handleTaskPress = useCallback((task: Task) => {
        setEditingTask(task);
        setShowEditModal(true);
    }, []);

    const closeEditModal = useCallback(() => {
        setShowEditModal(false);
    }, []);

    const handleStatusChange = useCallback((taskId: string, status: string) => {
        return updateTask(taskId, { status: status as TaskStatus });
    }, [updateTask]);

    const handleDelete = useCallback((taskId: string) => {
        deleteTask(taskId);
    }, [deleteTask]);

    const handleSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
        updateTask(taskId, updates);
    }, [updateTask]);

    const openReviewQuickAdd = useCallback((initialProps?: Partial<Task>) => {
        openQuickCapture({ initialProps });
    }, [openQuickCapture]);

    const openProjectTaskPrompt = useCallback((projectId: string, projectTitle: string) => {
        setProjectTaskPrompt({ projectId, projectTitle });
        setProjectTaskTitle('');
    }, []);

    const closeProjectTaskPrompt = useCallback(() => {
        setProjectTaskPrompt(null);
        setProjectTaskTitle('');
    }, []);

    const submitProjectTask = useCallback(async () => {
        const title = projectTaskTitle.trim();
        const targetProject = projectTaskPrompt;
        if (!title || !targetProject) return;
        try {
            await addTask(title, { projectId: targetProject.projectId, status: 'next' });
            closeProjectTaskPrompt();
        } catch (error) {
            void logError(error, {
                scope: 'review',
                extra: { message: 'Failed to add task from project review', projectId: targetProject.projectId },
            });
        }
    }, [addTask, closeProjectTaskPrompt, projectTaskPrompt, projectTaskTitle]);

    const toggleExternalDayExpanded = useCallback((dayKey: string) => {
        setExpandedExternalDays((prev) => {
            const next = new Set(prev);
            if (next.has(dayKey)) {
                next.delete(dayKey);
            } else {
                next.add(dayKey);
            }
            return next;
        });
    }, []);

    const toggleContextGroupExpanded = useCallback((contextKey: string) => {
        setExpandedContextGroups((prev) => {
            const next = new Set(prev);
            if (next.has(contextKey)) {
                next.delete(contextKey);
            } else {
                next.add(contextKey);
            }
            return next;
        });
    }, []);

    useEffect(() => {
        if (!visible) return;
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
                const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
                if (cancelled) return;
                setExternalCalendarEvents(events);
            } catch (error) {
                if (cancelled) return;
                setExternalCalendarError(error instanceof Error ? error.message : String(error));
                setExternalCalendarEvents([]);
            } finally {
                if (!cancelled) setExternalCalendarLoading(false);
            }
        };
        void loadCalendar();
        return () => {
            cancelled = true;
        };
    }, [visible]);

    const handleFinish = useCallback(async () => {
        try {
            await AsyncStorage.setItem('lastWeeklyReview', new Date().toISOString());
        } catch (error) {
            void logError(error, { scope: 'review', extra: { message: 'Failed to save review time' } });
        }
        handleClose();
        setTimeout(() => {
            void maybeRequestStoreReviewAfterPositiveMoment();
        }, 650);
    }, [handleClose]);

    const staleItems = useMemo(() => getStaleItems(tasks, projects), [tasks, projects]);
    const staleItemTitleMap = useMemo(() => staleItems.reduce((acc, item) => {
        acc[item.id] = item.title;
        return acc;
    }, {} as Record<string, string>), [staleItems]);
    const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
    const staleTasks = useMemo(() => staleItems.flatMap((item) => {
        if (item.id.startsWith('project:')) return [];
        const task = taskById.get(item.id);
        return task ? [task] : [];
    }), [staleItems, taskById]);
    const staleProjectItems = useMemo(
        () => staleItems.filter((item) => item.id.startsWith('project:')),
        [staleItems],
    );

    const isActionableSuggestion = useCallback((suggestion: ReviewSuggestion) => {
        if (suggestion.id.startsWith('project:')) return false;
        return suggestion.action === 'someday' || suggestion.action === 'archive';
    }, []);

    const toggleSuggestion = useCallback((id: string) => {
        setAiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const runAiAnalysis = useCallback(async () => {
        setAiError(null);
        setAiRan(true);
        if (!aiEnabled) {
            setAiError('AI is disabled. Enable it in Settings.');
            return;
        }
        const apiKey = await loadAIKey(aiProvider);
        if (isAIKeyRequired(settings) && !apiKey) {
            setAiError('Missing API key. Add it in Settings.');
            return;
        }
        if (staleItems.length === 0) {
            setAiSuggestions([]);
            setAiSelectedIds(new Set());
            return;
        }
        setAiLoading(true);
        try {
            const provider = createAIProvider(buildAIConfig(settings, apiKey));
            const response = await provider.analyzeReview({ items: staleItems });
            const suggestions = response.suggestions || [];
            setAiSuggestions(suggestions);
            const defaultSelected = new Set(
                suggestions.filter(isActionableSuggestion).map((suggestion) => suggestion.id),
            );
            setAiSelectedIds(defaultSelected);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setAiError(message || 'AI request failed.');
        } finally {
            setAiLoading(false);
        }
    }, [aiEnabled, aiProvider, isActionableSuggestion, settings, staleItems]);

    const applyAiSuggestions = useCallback(async () => {
        const updates = aiSuggestions
            .filter((suggestion) => aiSelectedIds.has(suggestion.id))
            .filter(isActionableSuggestion)
            .map((suggestion) => {
                if (suggestion.action === 'someday') {
                    return { id: suggestion.id, updates: { status: 'someday' as TaskStatus } };
                }
                if (suggestion.action === 'archive') {
                    return {
                        id: suggestion.id,
                        updates: { status: 'archived' as TaskStatus, completedAt: new Date().toISOString() },
                    };
                }
                return null;
            })
            .filter(Boolean) as { id: string; updates: Partial<Task> }[];

        if (updates.length === 0) return;
        await batchUpdateTasks(updates);
    }, [aiSelectedIds, aiSuggestions, batchUpdateTasks, isActionableSuggestion]);

    const inboxTasks = useMemo(
        () => tasks.filter((task) => (
            task.status === 'inbox'
            && !task.deletedAt
            && isTaskInActiveProject(task, projectById)
        )),
        [projectById, tasks],
    );
    const waitingTasks = useMemo(
        () => tasks.filter((task) => (
            task.status === 'waiting'
            && !task.deletedAt
            && isTaskInActiveProject(task, projectById)
        )),
        [projectById, tasks],
    );
    const somedayTasks = useMemo(
        () => tasks.filter((task) => (
            task.status === 'someday'
            && !task.deletedAt
            && isTaskInActiveProject(task, projectById)
        )),
        [projectById, tasks],
    );
    const waitingDue = useMemo(
        () => waitingTasks.filter((task) => isDueForReview(task.reviewAt)),
        [waitingTasks],
    );
    const waitingFuture = useMemo(
        () => waitingTasks.filter((task) => !isDueForReview(task.reviewAt)),
        [waitingTasks],
    );
    const orderedWaitingTasks = useMemo(
        () => [...waitingDue, ...waitingFuture],
        [waitingDue, waitingFuture],
    );
    const somedayDue = useMemo(
        () => somedayTasks.filter((task) => isDueForReview(task.reviewAt)),
        [somedayTasks],
    );
    const somedayFuture = useMemo(
        () => somedayTasks.filter((task) => !isDueForReview(task.reviewAt)),
        [somedayTasks],
    );
    const orderedSomedayTasks = useMemo(
        () => [...somedayDue, ...somedayFuture],
        [somedayDue, somedayFuture],
    );
    const activeProjects = useMemo(
        () => projects.filter((project) => project.status === 'active' && !project.deletedAt),
        [projects],
    );
    const dueProjects = useMemo(
        () => activeProjects.filter((project) => isDueForReview(project.reviewAt)),
        [activeProjects],
    );
    const futureProjects = useMemo(
        () => activeProjects.filter((project) => !isDueForReview(project.reviewAt)),
        [activeProjects],
    );
    const orderedProjects = useMemo(
        () => [...dueProjects, ...futureProjects],
        [dueProjects, futureProjects],
    );
    const calendarReviewItems = useMemo<CalendarTaskReviewEntry[]>(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const upcomingEnd = new Date(startOfToday);
        upcomingEnd.setDate(upcomingEnd.getDate() + 7);
        const entries: CalendarTaskReviewEntry[] = [];

        tasks.forEach((task) => {
            if (task.deletedAt) return;
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            if (!isTaskInActiveProject(task, projectById)) return;
            const dueDate = safeParseDueDate(task.dueDate);
            if (dueDate) entries.push({ task, date: dueDate, kind: 'due' });
            const startTime = safeParseDate(task.startTime);
            if (startTime) entries.push({ task, date: startTime, kind: 'start' });
        });

        return entries
            .filter((entry) => entry.date >= startOfToday && entry.date < upcomingEnd)
            .sort((a, b) => a.date.getTime() - b.date.getTime());
    }, [projectById, tasks]);

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
            if (task.status === 'done' || task.status === 'archived' || task.status === 'reference') return;
            if (!isTaskInActiveProject(task, projectById)) return;
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
    }, [projectById, tasks]);

    const projectReviewEntries = useMemo<ReviewProjectEntry[]>(() => orderedProjects.map((project) => {
        const projectTasks = tasks.filter(
            (task) =>
                task.projectId === project.id
                && task.status !== 'done'
                && task.status !== 'reference'
                && !task.deletedAt,
        );
        return {
            areaColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || tc.tint,
            hasNextAction: projectTasks.some((task) => task.status === 'next'),
            project,
            tasks: projectTasks,
        };
    }), [areaById, orderedProjects, tasks, tc.tint]);

    const steps = useMemo<ReviewStepDefinition[]>(() => {
        const calendarHasWork = calendarReviewItems.length > 0
            || externalCalendarReviewItems.length > 0
            || Boolean(externalCalendarError);
        const list: ReviewStepDefinition[] = [
            { id: 'inbox', title: labels.inbox, Icon: Inbox, hasWork: inboxTasks.length > 0 },
            { id: 'stale', title: labels.stale, Icon: History, hasWork: staleItems.length > 0 },
        ];
        list.push(
            { id: 'calendar', title: labels.calendar, Icon: CalendarIcon, hasWork: calendarHasWork },
            { id: 'waiting', title: labels.waiting, Icon: Clock, hasWork: waitingTasks.length > 0 },
        );
        if (includeContextStep) {
            list.push({ id: 'contexts', title: labels.contexts, Icon: Tag, hasWork: contextReviewGroups.length > 0 });
        }
        list.push(
            { id: 'projects', title: labels.projects, Icon: FolderOpen, hasWork: projectReviewEntries.length > 0 },
            { id: 'someday', title: labels.someday, Icon: Lightbulb, hasWork: somedayTasks.length > 0 },
            { id: 'completed', title: labels.done, Icon: CheckCircle2, hasWork: true },
        );
        return list;
    }, [
        calendarReviewItems.length,
        contextReviewGroups.length,
        externalCalendarError,
        externalCalendarReviewItems.length,
        inboxTasks.length,
        includeContextStep,
        labels,
        projectReviewEntries.length,
        somedayTasks.length,
        staleItems.length,
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

    const nextStep = useCallback(() => {
        if (activeStepIndex < 0) {
            setCurrentStep(activeSteps[0]?.id ?? 'completed');
            return;
        }
        if (activeStepIndex < activeSteps.length - 1) {
            setCurrentStep(activeSteps[activeStepIndex + 1].id);
        }
    }, [activeStepIndex, activeSteps]);

    const prevStep = useCallback(() => {
        if (activeStepIndex > 0) {
            setCurrentStep(activeSteps[activeStepIndex - 1].id);
        }
    }, [activeStepIndex, activeSteps]);

    const handleNavigateToProject = useCallback((projectId: string) => {
        onClose();
        openProjectScreen(projectId);
    }, [onClose]);

    const handleNavigateToToken = useCallback((token: string) => {
        onClose();
        openContextsScreen(token);
    }, [onClose]);

    const toggleExpandedProject = useCallback((projectId: string) => {
        setExpandedProject((prev) => (prev === projectId ? null : projectId));
    }, []);

    return {
        aiEnabled,
        aiError,
        aiLoading,
        aiRan,
        aiSelectedIds,
        aiSuggestions,
        applyAiSuggestions,
        calendarReviewItems,
        closeEditModal,
        closeProjectTaskPrompt,
        contextReviewGroups,
        currentStep: displayedStep,
        editingTask,
        expandedContextGroups,
        expandedExternalDays,
        expandedProject,
        externalCalendarError,
        externalCalendarLoading,
        externalCalendarReviewItems,
        handleClose,
        handleDelete,
        handleFinish,
        handleNavigateToProject,
        handleNavigateToToken,
        handleSaveTask,
        handleStatusChange,
        handleTaskPress,
        includeContextStep,
        inboxTasks,
        isActionableSuggestion,
        isDark,
        labels,
        nextStep,
        openProjectTaskPrompt,
        openReviewQuickAdd,
        orderedSomedayTasks,
        orderedWaitingTasks,
        prevStep,
        progress,
        projectReviewEntries,
        projectTaskPrompt,
        projectTaskTitle,
        runAiAnalysis,
        safeStepIndex,
        setProjectTaskTitle,
        showEditModal,
        somedayTasks,
        staleItemTitleMap,
        staleProjectItems,
        staleTasks,
        steps,
        submitProjectTask,
        tc,
        toggleContextGroupExpanded,
        toggleExpandedProject,
        toggleExternalDayExpanded,
        toggleSuggestion,
        waitingTasks,
    };
}
