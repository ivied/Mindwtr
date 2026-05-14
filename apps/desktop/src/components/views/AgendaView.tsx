import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, TaskPriority, TimeEstimate, applyFilter, buildAdvancedFilterCriteriaChips, removeAdvancedFilterCriteriaChip, formatFocusTaskLimitText, generateUUID, getUsedTaskTokens, getFocusSequentialFirstTaskIds, hasActiveFilterCriteria, markSavedFilterDeleted, normalizeFocusTaskLimit, safeParseDate, safeParseDueDate, isDueForReview, isTaskInActiveProject, SAVED_FILTER_NO_PROJECT_ID, shouldShowTaskForStart, sortFocusNextActions, translateWithFallback } from '@mindwtr/core';
import type { FilterCriteria, SavedFilter, Task, TaskEnergyLevel } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/ui-store';
import { AlertCircle, Clock, Star, ArrowRight, Folder, CheckCircle2, Plus, X } from 'lucide-react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
import { PomodoroPanel } from './PomodoroPanel';
import { AgendaFiltersPanel, type AgendaActiveFilterChip, type AgendaProjectFilterOption } from './agenda/AgendaFiltersPanel';
import { AgendaHeader } from './agenda/AgendaHeader';
import { AgendaCollapsibleSection, AgendaProjectSection } from './agenda/AgendaSections';
import { StoreTaskItem } from './list/StoreTaskItem';
import { groupTasksByArea, groupTasksByContext, groupTasksByProject, type TaskGroup } from './list/next-grouping';
import { PromptModal } from '../PromptModal';
import { ConfirmModal } from '../ConfirmModal';

const AGENDA_VIRTUALIZATION_THRESHOLD = 25;
const NO_PROJECT_FILTER_ID = SAVED_FILTER_NO_PROJECT_ID;
const AGENDA_ACTIVE_STATUSES: Task['status'][] = ['inbox', 'next', 'waiting', 'someday'];

function getAgendaScrollElement(containerElement: HTMLDivElement | null): HTMLElement | null {
    if (containerElement) {
        const closestMainContent = containerElement.closest<HTMLElement>('[data-main-content]');
        if (closestMainContent) return closestMainContent;
    }
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>('[data-main-content]');
}

function getAgendaScrollMargin(containerElement: HTMLDivElement, scrollElement: HTMLElement) {
    const containerRect = containerElement.getBoundingClientRect();
    const scrollRect = scrollElement.getBoundingClientRect();
    return containerRect.top - scrollRect.top + scrollElement.scrollTop;
}

function buildFocusFilterCriteria({
    priorities,
    energyLevels,
    projects,
    timeEstimates,
    tokens,
}: {
    energyLevels: TaskEnergyLevel[];
    priorities: TaskPriority[];
    projects: string[];
    timeEstimates: TimeEstimate[];
    tokens: string[];
}): FilterCriteria {
    const contexts = tokens.filter((token) => token.trim().startsWith('@'));
    const tags = tokens.filter((token) => token.trim().startsWith('#'));
    return {
        ...(contexts.length > 0 ? { contexts } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(priorities.length > 0 ? { priority: priorities } : {}),
        ...(energyLevels.length > 0 ? { energy: energyLevels } : {}),
        ...(timeEstimates.length > 0 ? { timeEstimates } : {}),
    };
}

function getSavedFilterDefaultName(chips: AgendaActiveFilterChip[], fallback: string): string {
    const label = chips.slice(0, 3).map((chip) => chip.label).join(' + ');
    return label || fallback;
}

function AgendaTaskList({
    tasks,
    buildFocusToggle,
    showListDetails,
    highlightTaskId,
}: {
    tasks: Task[];
    buildFocusToggle: (task: Task) => {
        isFocused: boolean;
        canToggle: boolean;
        onToggle: () => void;
        title: string;
        ariaLabel: string;
        alwaysVisible?: boolean;
    };
    showListDetails: boolean;
    highlightTaskId: string | null;
}) {
    const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    // Desktop views scroll inside the shared main content pane, not the window.
    const scrollElement = useMemo(
        () => getAgendaScrollElement(containerElement),
        [containerElement]
    );
    const shouldVirtualize = Boolean(scrollElement) && !highlightTaskId && tasks.length > AGENDA_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? tasks.length : 0,
        getScrollElement: () => scrollElement,
        estimateSize: () => (showListDetails ? 96 : 82),
        overscan: 4,
        scrollMargin,
        getItemKey: (index) => tasks[index]?.id ?? index,
    });

    const updateScrollMargin = useCallback(() => {
        if (!containerElement || !scrollElement) return;
        const nextScrollMargin = getAgendaScrollMargin(containerElement, scrollElement);
        setScrollMargin((current) => (Math.abs(current - nextScrollMargin) < 1 ? current : nextScrollMargin));
    }, [containerElement, scrollElement]);

    useLayoutEffect(() => {
        updateScrollMargin();
    });

    useEffect(() => {
        if (!containerElement || !scrollElement || typeof window === 'undefined') return;
        window.addEventListener('resize', updateScrollMargin);
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateScrollMargin())
            : null;
        resizeObserver?.observe(containerElement);
        resizeObserver?.observe(scrollElement);
        return () => {
            window.removeEventListener('resize', updateScrollMargin);
            resizeObserver?.disconnect();
        };
    }, [containerElement, scrollElement, updateScrollMargin]);

    if (!shouldVirtualize) {
        return (
            <div className="divide-y divide-border/30">
                {tasks.map((task) => (
                    <StoreTaskItem
                        key={task.id}
                        taskId={task.id}
                        buildFocusToggle={buildFocusToggle}
                        showProjectBadgeInActions={false}
                        compactMetaEnabled={showListDetails}
                        enableDoubleClickEdit
                    />
                ))}
            </div>
        );
    }

    const virtualRows = rowVirtualizer.getVirtualItems();
    return (
        <div
            ref={setContainerElement}
            className="relative"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
        >
            {virtualRows.map((virtualRow) => {
                const task = tasks[virtualRow.index];
                if (!task) return null;
                const isLast = virtualRow.index === tasks.length - 1;
                return (
                    <div
                        key={virtualRow.key}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        className={cn(!isLast && 'border-b border-border/30')}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                        }}
                    >
                        <StoreTaskItem
                            taskId={task.id}
                            buildFocusToggle={buildFocusToggle}
                            showProjectBadgeInActions={false}
                            compactMetaEnabled={showListDetails}
                            enableDoubleClickEdit
                        />
                    </div>
                );
            })}
        </div>
    );
}

export function AgendaView() {
    const perf = usePerformanceMonitor('AgendaView');
    const { projects, areas, updateTask, updateSettings, settings, error, highlightTaskId, setHighlightTask } = useTaskStore(
        (state) => ({
            projects: state.projects,
            areas: state.areas,
            updateTask: state.updateTask,
            updateSettings: state.updateSettings,
            settings: state.settings,
            error: state.error,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
        }),
        shallow
    );
    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const { activeTasksByStatus, projectMap, sequentialProjectIds, tasksById } = getDerivedState();
    const { t } = useLanguage();
    const { showListDetails, nextGroupBy, top3Only, setListOptions, collapseAllTaskDetails } = useUiStore((state) => ({
        showListDetails: state.listOptions.showDetails,
        nextGroupBy: state.listOptions.nextGroupBy,
        top3Only: state.listOptions.focusTop3Only,
        setListOptions: state.setListOptions,
        collapseAllTaskDetails: state.collapseAllTaskDetails,
    }));
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
    const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
    const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
    const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
    const [saveFilterPromptOpen, setSaveFilterPromptOpen] = useState(false);
    const [filterPendingDelete, setFilterPendingDelete] = useState<SavedFilter | null>(null);
    const showFutureStarts = settings?.appearance?.showFutureStarts === true;
    const [expandedSections, setExpandedSections] = useState({
        schedule: true,
        nextActions: true,
        reviewDue: true,
    });
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const pomodoroEnabled = settings?.features?.pomodoro === true;
    const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
    const activePriorities = prioritiesEnabled ? selectedPriorities : [];
    const activeTimeEstimates = timeEstimatesEnabled ? selectedTimeEstimates : [];
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('AgendaView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const derivedActiveTasks = useMemo(() => (
        AGENDA_ACTIVE_STATUSES.flatMap((status) => activeTasksByStatus.get(status) ?? [])
    ), [activeTasksByStatus]);

    // Filter active tasks
    const baseActiveTasks = useMemo(() => (
        derivedActiveTasks.filter(t =>
            isTaskInActiveProject(t, projectMap)
            && taskMatchesAreaFilter(t, resolvedAreaFilter, projectMap, areaById)
        )
    ), [derivedActiveTasks, projectMap, resolvedAreaFilter, areaById]);

    const { activeTasks, allTokens, hiddenFutureStartCount } = useMemo(() => {
        const now = new Date();
        const active = baseActiveTasks.filter((task) => shouldShowTaskForStart(task, { showFutureStarts, now }));
        return {
            activeTasks: active,
            allTokens: getUsedTaskTokens(active, (task) => [...(task.contexts || []), ...(task.tags || [])]),
            hiddenFutureStartCount: baseActiveTasks.filter((task) => !shouldShowTaskForStart(task, { showFutureStarts: false, now })).length,
        };
    }, [baseActiveTasks, showFutureStarts]);
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const energyLevelOptions: TaskEnergyLevel[] = ['low', 'medium', 'high'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const projectOptions = useMemo<AgendaProjectFilterOption[]>(() => {
        const activeProjectIds = new Set(
            activeTasks
                .map((task) => task.projectId)
                .filter((projectId): projectId is string => Boolean(projectId))
        );
        return [...projects]
            .filter((project) => !project.deletedAt && project.status !== 'archived' && activeProjectIds.has(project.id))
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            })
            .map((project) => ({
                id: project.id,
                title: project.title,
                dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color || undefined,
            }));
    }, [activeTasks, areaById, projects]);
    const showNoProjectOption = useMemo(
        () => activeTasks.some((task) => !task.projectId),
        [activeTasks]
    );
    const formatEstimate = (estimate: TimeEstimate) => {
        if (estimate.endsWith('min')) return estimate.replace('min', 'm');
        if (estimate.endsWith('hr+')) return estimate.replace('hr+', 'h+');
        if (estimate.endsWith('hr')) return estimate.replace('hr', 'h');
        return estimate;
    };
    const savedFocusFilters = useMemo(
        () => (settings?.savedFilters ?? []).filter((filter) => filter.view === 'focus' && !filter.deletedAt),
        [settings?.savedFilters],
    );
    const activeSavedFilter = useMemo(
        () => savedFocusFilters.find((filter) => filter.id === activeSavedFilterId) ?? null,
        [activeSavedFilterId, savedFocusFilters],
    );
    const currentFilterCriteria = useMemo(() => buildFocusFilterCriteria({
        tokens: selectedTokens,
        projects: selectedProjects,
        priorities: activePriorities,
        energyLevels: selectedEnergyLevels,
        timeEstimates: activeTimeEstimates,
    }), [activePriorities, activeTimeEstimates, selectedEnergyLevels, selectedProjects, selectedTokens]);
    const rawEffectiveFilterCriteria = activeSavedFilter?.criteria ?? currentFilterCriteria;
    const effectiveFilterCriteria = useMemo<FilterCriteria>(() => ({
        ...rawEffectiveFilterCriteria,
        ...(prioritiesEnabled ? {} : { priority: undefined }),
        ...(timeEstimatesEnabled ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
    }), [prioritiesEnabled, rawEffectiveFilterCriteria, timeEstimatesEnabled]);
    const hasCurrentFilterCriteria = hasActiveFilterCriteria(currentFilterCriteria);
    const hasFilters = hasActiveFilterCriteria(effectiveFilterCriteria);
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const matchesSearchQuery = useCallback((title: string) => {
        if (!normalizedSearchQuery) return true;
        return title.toLowerCase().includes(normalizedSearchQuery);
    }, [normalizedSearchQuery]);
    const resolveText = useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);
    const toggleFutureStarts = useCallback(() => {
        void updateSettings({
            appearance: {
                ...(settings.appearance ?? {}),
                showFutureStarts: !showFutureStarts,
            },
        }).catch(() => undefined);
    }, [settings.appearance, showFutureStarts, updateSettings]);
    const formatFutureStartNotice = useCallback((count: number, shown: boolean) => {
        const template = shown
            ? (count === 1
                ? resolveText('agenda.futureStartsShownOne', '1 future-start task shown')
                : resolveText('agenda.futureStartsShownMany', '{count} future-start tasks shown'))
            : (count === 1
                ? resolveText('agenda.futureStartsHiddenOne', '1 task hidden (future start)')
                : resolveText('agenda.futureStartsHiddenMany', '{count} tasks hidden (future start)'));
        return template.replace('{count}', String(count));
    }, [resolveText]);
    const removeAdvancedSavedFilterCriterion = useCallback((chipId: string) => {
        if (!activeSavedFilter) return;
        const nextCriteria = removeAdvancedFilterCriteriaChip(activeSavedFilter.criteria, chipId);
        if (nextCriteria === activeSavedFilter.criteria) return;

        const nowIso = new Date().toISOString();
        const nextFilters = (settings?.savedFilters ?? []).map((filter) => (
            filter.id === activeSavedFilter.id
                ? { ...filter, criteria: nextCriteria, updatedAt: nowIso }
                : filter
        ));
        void updateSettings({ savedFilters: nextFilters }).catch(() => undefined);
    }, [activeSavedFilter, settings?.savedFilters, updateSettings]);
    const activeFilterChips = useMemo<AgendaActiveFilterChip[]>(() => {
        const chips: AgendaActiveFilterChip[] = [];
        selectedTokens.forEach((token) => {
            chips.push({
                id: `token:${token}`,
                label: token,
            });
        });
        selectedProjects.forEach((projectId) => {
            if (projectId === NO_PROJECT_FILTER_ID) {
                chips.push({
                    id: `project:${projectId}`,
                    label: resolveText('taskEdit.noProjectOption', 'No project'),
                });
                return;
            }
            const project = projectMap.get(projectId);
            if (!project) return;
            chips.push({
                id: `project:${project.id}`,
                label: project.title,
                dotColor: (project.areaId ? areaById.get(project.areaId)?.color : undefined) || project.color || undefined,
            });
        });
        activePriorities.forEach((priority) => {
            chips.push({
                id: `priority:${priority}`,
                label: t(`priority.${priority}`),
            });
        });
        selectedEnergyLevels.forEach((energyLevel) => {
            chips.push({
                id: `energy:${energyLevel}`,
                label: t(`energyLevel.${energyLevel}`),
            });
        });
        activeTimeEstimates.forEach((estimate) => {
            chips.push({
                id: `time:${estimate}`,
                label: formatEstimate(estimate),
            });
        });
        if (activeSavedFilter) {
            chips.push(...buildAdvancedFilterCriteriaChips(effectiveFilterCriteria, {
                getAreaColor: (areaId) => areaById.get(areaId)?.color,
                getAreaLabel: (areaId) => areaById.get(areaId)?.name,
                resolveText,
            }).map((chip) => ({
                id: `advanced:${chip.id}`,
                label: chip.label,
                dotColor: chip.color,
                isAdvanced: true,
                onRemove: () => removeAdvancedSavedFilterCriterion(chip.id),
            })));
        }
        return chips;
    }, [
        activeSavedFilter,
        activePriorities,
        activeTimeEstimates,
        areaById,
        effectiveFilterCriteria,
        formatEstimate,
        projectMap,
        removeAdvancedSavedFilterCriterion,
        resolveText,
        selectedEnergyLevels,
        selectedProjects,
        selectedTokens,
        t,
    ]);
    const saveFilterDefaultName = useMemo(
        () => getSavedFilterDefaultName(activeFilterChips, resolveText('savedFilters.defaultName', 'Focus filter')),
        [activeFilterChips, resolveText],
    );

    const { filteredActiveTasks, reviewDueCandidates } = useMemo(() => {
        const now = new Date();
        const filtered = applyFilter(activeTasks, effectiveFilterCriteria, { projects, now, tokenMatchMode: 'all' })
            .filter((task) => matchesSearchQuery(task.title));
        const reviewDueBase = baseActiveTasks
            .filter((task) => {
                if (!shouldShowTaskForStart(task, { showFutureStarts, now })) return false;
                if (!isDueForReview(task.reviewAt, now)) return false;
                if (!matchesSearchQuery(task.title)) return false;
                return true;
            });
        const reviewDue = applyFilter(reviewDueBase, effectiveFilterCriteria, { projects, now, tokenMatchMode: 'all' });
        return { filteredActiveTasks: filtered, reviewDueCandidates: reviewDue };
    }, [activeTasks, baseActiveTasks, effectiveFilterCriteria, matchesSearchQuery, projects, showFutureStarts]);

    const reviewDueProjects = useMemo(() => {
        const now = new Date();
        return projects
            .filter((project) => {
                if (project.deletedAt) return false;
                if (project.status === 'archived') return false;
                if (!projectMatchesAreaFilter(project, resolvedAreaFilter, areaById)) return false;
                if (!matchesSearchQuery(project.title)) return false;
                return isDueForReview(project.reviewAt, now);
            })
            .sort((a, b) => {
                const aReview = safeParseDate(a.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
                const bReview = safeParseDate(b.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY;
                if (aReview !== bReview) return aReview - bReview;
                return a.title.localeCompare(b.title);
            });
    }, [projects, matchesSearchQuery, resolvedAreaFilter, areaById]);
    const hasTaskFilters = hasFilters || Boolean(normalizedSearchQuery);
    const showFiltersPanel = filtersOpen;
    useEffect(() => {
        if (activeSavedFilterId && !activeSavedFilter) {
            setActiveSavedFilterId(null);
        }
    }, [activeSavedFilter, activeSavedFilterId]);
    const toggleTokenFilter = (token: string) => {
        setActiveSavedFilterId(null);
        setSelectedTokens((prev) =>
            prev.includes(token) ? prev.filter((item) => item !== token) : [...prev, token]
        );
    };
    const togglePriorityFilter = (priority: TaskPriority) => {
        setActiveSavedFilterId(null);
        setSelectedPriorities((prev) =>
            prev.includes(priority) ? prev.filter((item) => item !== priority) : [...prev, priority]
        );
    };
    const toggleProjectFilter = (projectId: string) => {
        setActiveSavedFilterId(null);
        setSelectedProjects((prev) =>
            prev.includes(projectId) ? prev.filter((item) => item !== projectId) : [...prev, projectId]
        );
    };
    const toggleEnergyFilter = (energyLevel: TaskEnergyLevel) => {
        setActiveSavedFilterId(null);
        setSelectedEnergyLevels((prev) =>
            prev.includes(energyLevel) ? prev.filter((item) => item !== energyLevel) : [...prev, energyLevel]
        );
    };
    const toggleTimeFilter = (estimate: TimeEstimate) => {
        setActiveSavedFilterId(null);
        setSelectedTimeEstimates((prev) =>
            prev.includes(estimate) ? prev.filter((item) => item !== estimate) : [...prev, estimate]
        );
    };
    const clearFilters = () => {
        setActiveSavedFilterId(null);
        setSelectedTokens([]);
        setSelectedProjects([]);
        setSelectedPriorities([]);
        setSelectedEnergyLevels([]);
        setSelectedTimeEstimates([]);
    };
    const clearAllFilters = () => {
        clearFilters();
        setSearchQuery('');
    };
    const applySavedFocusFilter = useCallback((filter: SavedFilter) => {
        const criteria = filter.criteria ?? {};
        const prioritySet = new Set<TaskPriority>(priorityOptions);
        const energySet = new Set<TaskEnergyLevel>(energyLevelOptions);
        const estimateSet = new Set<TimeEstimate>(timeEstimateOptions);
        setSelectedTokens([...(criteria.contexts ?? []), ...(criteria.tags ?? [])]);
        setSelectedProjects(criteria.projects ?? []);
        setSelectedPriorities((criteria.priority ?? []).filter((priority): priority is TaskPriority => (
            priority !== 'none' && prioritySet.has(priority)
        )));
        setSelectedEnergyLevels((criteria.energy ?? []).filter((energy): energy is TaskEnergyLevel => energySet.has(energy)));
        setSelectedTimeEstimates((criteria.timeEstimates ?? []).filter((estimate): estimate is TimeEstimate => estimateSet.has(estimate)));
        setActiveSavedFilterId(filter.id);
        setFiltersOpen(false);
    }, [energyLevelOptions, priorityOptions, timeEstimateOptions]);
    const handleSaveFilterConfirm = useCallback((name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName || !hasCurrentFilterCriteria) return;
        const nowIso = new Date().toISOString();
        const nextFilter: SavedFilter = {
            id: generateUUID(),
            name: trimmedName,
            view: 'focus',
            criteria: currentFilterCriteria,
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        void updateSettings({
            savedFilters: [...(settings?.savedFilters ?? []), nextFilter],
        }).then(() => {
            setSaveFilterPromptOpen(false);
            setActiveSavedFilterId(nextFilter.id);
        }).catch(() => undefined);
    }, [currentFilterCriteria, hasCurrentFilterCriteria, settings?.savedFilters, updateSettings]);
    const handleDeleteSavedFilterConfirm = useCallback(() => {
        if (!filterPendingDelete) return;
        const deleteId = filterPendingDelete.id;
        const nextFilters = markSavedFilterDeleted(settings?.savedFilters, deleteId);
        void updateSettings({ savedFilters: nextFilters }).then(() => {
            if (activeSavedFilterId === deleteId) {
                setActiveSavedFilterId(null);
            }
            setFilterPendingDelete(null);
        }).catch(() => undefined);
    }, [activeSavedFilterId, filterPendingDelete, settings?.savedFilters, updateSettings]);
    useEffect(() => {
        if (!prioritiesEnabled && selectedPriorities.length > 0) {
            setSelectedPriorities([]);
        }
        if (!timeEstimatesEnabled && selectedTimeEstimates.length > 0) {
            setSelectedTimeEstimates([]);
        }
    }, [prioritiesEnabled, timeEstimatesEnabled, selectedPriorities.length, selectedTimeEstimates.length]);

    useEffect(() => {
        if (!highlightTaskId) return;
        const el = document.querySelector(`[data-task-id="${highlightTaskId}"]`) as HTMLElement | null;
        if (el && typeof (el as any).scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'center' });
        }
        const timer = window.setTimeout(() => setHighlightTask(null), 4000);
        return () => window.clearTimeout(timer);
    }, [highlightTaskId, setHighlightTask]);
    // Today's Focus: tasks marked as isFocusedToday.
    const focusedTasks = useMemo(() =>
        filteredActiveTasks.filter(t => t.isFocusedToday),
        [filteredActiveTasks]
    );

    // Categorize tasks
    const sections = useMemo(() => {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const priorityRank: Record<TaskPriority, number> = {
            low: 1,
            medium: 2,
            high: 3,
            urgent: 4,
        };
        const sortWith = (items: Task[], getTime: (task: Task) => number) => {
            return [...items].sort((a, b) => {
                const timeDiff = getTime(a) - getTime(b);
                if (timeDiff !== 0) return timeDiff;
                if (prioritiesEnabled) {
                    const priorityDiff = (priorityRank[b.priority as TaskPriority] || 0) - (priorityRank[a.priority as TaskPriority] || 0);
                    if (priorityDiff !== 0) return priorityDiff;
                }
                const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
                const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
                return aCreated - bCreated;
            });
        };
        const sequentialFirstTasks = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, { now });
        const isSequentialBlocked = (task: Task) => {
            if (!task.projectId) return false;
            if (!sequentialProjectIds.has(task.projectId)) return false;
            return !sequentialFirstTasks.has(task.id);
        };
        const schedule = filteredActiveTasks.filter((task) => {
            if (task.isFocusedToday) return false;
            if (task.status !== 'next') return false;
            if (isSequentialBlocked(task)) return false;
            const dueDate = safeParseDueDate(task.dueDate);
            const startDate = safeParseDate(task.startTime);
            const startsToday = Boolean(
                startDate
                && startDate >= startOfToday
                && startDate <= endOfToday
            );
            return Boolean(dueDate && dueDate <= endOfToday)
                || startsToday;
        });
        const scheduleIds = new Set(schedule.map((task) => task.id));
        const nextActions = filteredActiveTasks.filter((task) => {
            if (task.status !== 'next' || task.isFocusedToday) return false;
            if (isSequentialBlocked(task)) return false;
            return !scheduleIds.has(task.id);
        });
        const reviewDue = reviewDueCandidates.filter(t => !t.isFocusedToday);
        const scheduleSortTime = (task: Task) => {
            const due = safeParseDueDate(task.dueDate)?.getTime();
            const start = safeParseDate(task.startTime)?.getTime();
            if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
            if (typeof due === 'number') return due;
            if (typeof start === 'number') return start;
            return Number.POSITIVE_INFINITY;
        };

        return {
            schedule: sortWith(schedule, scheduleSortTime),
            nextActions: sortFocusNextActions(nextActions, {
                now,
                prioritizeByPriority: prioritiesEnabled,
            }),
            reviewDue: sortWith(reviewDue, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY),
        };
    }, [baseActiveTasks, filteredActiveTasks, reviewDueCandidates, prioritiesEnabled, sequentialProjectIds]);
    const nextActionGroups = useMemo(() => {
        if (nextGroupBy === 'none') return [] as TaskGroup[];
        if (nextGroupBy === 'area') {
            return groupTasksByArea({
                areas,
                tasks: sections.nextActions,
                projectMap,
                generalLabel: resolveText('settings.general', 'General'),
            });
        }
        if (nextGroupBy === 'project') {
            return groupTasksByProject({
                tasks: sections.nextActions,
                projectMap,
                noProjectLabel: resolveText('taskEdit.noProjectOption', 'No project'),
            });
        }
        return groupTasksByContext({
            tasks: sections.nextActions,
            noContextLabel: resolveText('contexts.none', 'No context'),
        });
    }, [areas, nextGroupBy, projectMap, resolveText, sections.nextActions]);
    const focusedCount = focusedTasks.length;
    const { top3Tasks, remainingCount } = useMemo(() => {
        const byId = new Map<string, Task>();
        [...sections.schedule, ...sections.nextActions, ...sections.reviewDue].forEach((task) => {
            byId.set(task.id, task);
        });
        const candidates = Array.from(byId.values());
        const priorityRank: Record<TaskPriority, number> = {
            low: 1,
            medium: 2,
            high: 3,
            urgent: 4,
        };
        const parseDue = (value?: string) => {
            if (!value) return Number.POSITIVE_INFINITY;
            const parsed = safeParseDueDate(value);
            return parsed ? parsed.getTime() : Number.POSITIVE_INFINITY;
        };
        const sorted = [...candidates].sort((a, b) => {
            if (prioritiesEnabled) {
                const priorityDiff = (priorityRank[b.priority as TaskPriority] || 0) - (priorityRank[a.priority as TaskPriority] || 0);
                if (priorityDiff !== 0) return priorityDiff;
            }
            const dueDiff = parseDue(a.dueDate) - parseDue(b.dueDate);
            if (dueDiff !== 0) return dueDiff;
            const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
            const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
            return aCreated - bCreated;
        });
        const top3 = sorted.slice(0, 3);
        return {
            top3Tasks: top3,
            remainingCount: Math.max(candidates.length - top3.length, 0),
        };
    }, [sections, prioritiesEnabled]);

    const handleToggleFocus = useCallback((taskId: string) => {
        const task = tasksById.get(taskId);
        if (!task) return;

        if (task.isFocusedToday) {
            updateTask(taskId, { isFocusedToday: false });
        } else if (focusedCount < focusTaskLimit) {
            updateTask(taskId, {
                isFocusedToday: true,
                ...(task.status !== 'next' ? { status: 'next' as const } : {}),
            });
        }
    }, [focusTaskLimit, focusedCount, tasksById, updateTask]);

    const buildFocusToggle = useCallback((task: Task) => {
        const isFocused = Boolean(task.isFocusedToday);
        const canToggle = isFocused || focusedCount < focusTaskLimit;
        const title = isFocused
            ? t('agenda.removeFromFocus')
            : focusedCount >= focusTaskLimit
                ? formatFocusTaskLimitText(t('agenda.maxFocusItems'), focusTaskLimit)
                : t('agenda.addToFocus');
        return {
            isFocused,
            canToggle,
            onToggle: () => handleToggleFocus(task.id),
            title,
            ariaLabel: title,
            alwaysVisible: true,
        };
    }, [focusTaskLimit, focusedCount, handleToggleFocus, t]);

    const toggleSection = useCallback((sectionKey: keyof typeof expandedSections) => {
        setExpandedSections((current) => ({
            ...current,
            [sectionKey]: !current[sectionKey],
        }));
    }, []);

    const nextActionsCount = sections.nextActions.length;
    const hasAgendaContent = focusedTasks.length > 0
        || sections.schedule.length > 0
        || sections.nextActions.length > 0
        || sections.reviewDue.length > 0
        || reviewDueProjects.length > 0;
    const pomodoroTasks = useMemo(() => {
        const ordered = [
            ...focusedTasks,
            ...sections.schedule,
            ...sections.nextActions,
            ...sections.reviewDue,
        ];
        const byId = new Map<string, Task>();
        ordered.forEach((task) => {
            if (task.deletedAt) return;
            byId.set(task.id, task);
        });
        return Array.from(byId.values());
    }, [focusedTasks, sections]);
    const handleToggleDetails = useCallback(() => {
        if (showListDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, setListOptions, showListDetails]);

    return (
        <ErrorBoundary>
            <div className="space-y-6 w-full">
            <AgendaHeader
                nextActionsCount={nextActionsCount}
                nextGroupBy={nextGroupBy}
                onChangeGroupBy={(value) => setListOptions({ nextGroupBy: value })}
                onToggleDetails={handleToggleDetails}
                onToggleTop3={() => setListOptions({ focusTop3Only: !top3Only })}
                resolveText={resolveText}
                showListDetails={showListDetails}
                t={t}
                top3Only={top3Only}
            />

            <div className="flex items-center gap-2 overflow-x-auto pb-1">
                <button
                    type="button"
                    onClick={clearAllFilters}
                    aria-pressed={!hasTaskFilters}
                    className={cn(
                        'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                        !hasTaskFilters
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                >
                    {resolveText('common.all', 'All')}
                </button>
                {savedFocusFilters.map((filter) => {
                    const isActive = activeSavedFilterId === filter.id;
                    return (
                        <div key={filter.id} className="inline-flex shrink-0 items-center">
                            <button
                                type="button"
                                onClick={() => applySavedFocusFilter(filter)}
                                aria-pressed={isActive}
                                className={cn(
                                    'inline-flex max-w-[220px] shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors',
                                    isActive ? 'rounded-l-full rounded-r-none' : 'rounded-full',
                                    isActive
                                        ? 'border-primary bg-primary text-primary-foreground'
                                        : 'border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                                )}
                            >
                                {filter.icon && <span aria-hidden="true">{filter.icon}</span>}
                                <span className="truncate">{filter.name}</span>
                            </button>
                            {isActive && (
                                <button
                                    type="button"
                                    onClick={() => setFilterPendingDelete(filter)}
                                    aria-label={`${resolveText('common.delete', 'Delete')} ${resolveText('savedFilters.label', 'saved filter')} ${filter.name}`}
                                    title={`${resolveText('common.delete', 'Delete')} ${filter.name}`}
                                    className="inline-flex h-[30px] w-7 shrink-0 items-center justify-center rounded-l-none rounded-r-full border border-l-0 border-primary bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                                >
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            )}
                        </div>
                    );
                })}
                <button
                    type="button"
                    onClick={() => {
                        setActiveSavedFilterId(null);
                        setFiltersOpen(true);
                    }}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={resolveText('savedFilters.new', 'New saved filter')}
                    title={resolveText('savedFilters.new', 'New saved filter')}
                >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>

            {pomodoroEnabled && <PomodoroPanel tasks={pomodoroTasks} />}

            <AgendaFiltersPanel
                allTokens={allTokens}
                activeFilterChips={activeFilterChips}
                canSaveFilter={hasCurrentFilterCriteria && activeSavedFilterId === null}
                energyLevelOptions={energyLevelOptions}
                formatEstimate={formatEstimate}
                hasFilters={hasFilters}
                onClearFilters={clearFilters}
                onSaveFilter={() => setSaveFilterPromptOpen(true)}
                onSearchChange={setSearchQuery}
                onToggleEnergy={toggleEnergyFilter}
                onToggleFiltersOpen={() => setFiltersOpen((prev) => !prev)}
                onToggleProject={toggleProjectFilter}
                onTogglePriority={togglePriorityFilter}
                onToggleTime={toggleTimeFilter}
                onToggleToken={toggleTokenFilter}
                prioritiesEnabled={prioritiesEnabled}
                projectOptions={projectOptions}
                priorityOptions={priorityOptions}
                searchQuery={searchQuery}
                saveFilterLabel={resolveText('savedFilters.save', 'Save')}
                selectedEnergyLevels={selectedEnergyLevels}
                selectedProjects={selectedProjects}
                selectedPriorities={selectedPriorities}
                selectedTimeEstimates={selectedTimeEstimates}
                selectedTokens={selectedTokens}
                showNoProjectOption={showNoProjectOption}
                showFiltersPanel={showFiltersPanel}
                t={t}
                timeEstimateOptions={timeEstimateOptions}
                timeEstimatesEnabled={timeEstimatesEnabled}
            />

            {error && (
                <div
                    role="alert"
                    className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                        <p className="font-medium">{resolveText('errorBoundary.title', 'Something went wrong')}</p>
                        <p className="break-words text-destructive/90">{error}</p>
                    </div>
                </div>
            )}

            {hiddenFutureStartCount > 0 && (
                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/25 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">
                        {formatFutureStartNotice(hiddenFutureStartCount, showFutureStarts)}
                    </span>
                    <button
                        type="button"
                        className="text-sm font-medium text-primary hover:text-primary/80"
                        onClick={toggleFutureStarts}
                    >
                        {showFutureStarts
                            ? resolveText('agenda.hideFutureStarts', 'Hide')
                            : resolveText('agenda.showFutureStarts', 'Show')}
                    </button>
                </div>
            )}

            {top3Only ? (
                <div className="space-y-4">
                    <div className="space-y-2">
                        <h3 className="font-semibold">{t('agenda.top3Title')}</h3>
                                {top3Tasks.length > 0 ? (
                            <div className="divide-y divide-border/30">
                                {top3Tasks.map(task => (
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
                                        showProjectBadgeInActions={false}
                                        compactMetaEnabled={showListDetails}
                                        enableDoubleClickEdit
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="text-muted-foreground text-sm">{t('agenda.noTasks')}</p>
                        )}
                    </div>
                    {remainingCount > 0 && (
                        <button
                            type="button"
                            onClick={() => setListOptions({ focusTop3Only: false })}
                            className="text-xs px-3 py-2 rounded bg-muted/50 text-muted-foreground hover:bg-muted transition-colors"
                        >
                            {t('agenda.showMore').replace('{{count}}', `${remainingCount}`)}
                        </button>
                    )}
                </div>
            ) : (
                <>
                    {focusedTasks.length > 0 && (
                        <div className="bg-gradient-to-r from-yellow-50 to-orange-50 dark:from-yellow-900/40 dark:to-amber-900/25 border border-yellow-200 dark:border-amber-500/30 rounded-xl p-6">
                            <h3 className="font-bold text-lg flex items-center gap-2 mb-4 text-slate-900 dark:text-amber-100">
                                <Star className="w-5 h-5 text-yellow-500 fill-yellow-500 dark:text-amber-300 dark:fill-amber-300" />
                                {t('agenda.todaysFocus')}
                                <span className="text-sm font-normal text-slate-600 dark:text-amber-200">
                                    ({focusedCount}/{focusTaskLimit})
                                </span>
                            </h3>

                            <div className="divide-y divide-border/30">
                                {focusedTasks.map(task => (
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
                                        buildFocusToggle={buildFocusToggle}
                                        showProjectBadgeInActions={false}
                                        compactMetaEnabled={showListDetails}
                                        enableDoubleClickEdit
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Other Sections */}
                    <div className="space-y-6">
                        {sections.schedule.length > 0 && (
                            <AgendaCollapsibleSection
                                title={t('focus.schedule') || t('agenda.dueToday')}
                                icon={Clock}
                                color="text-yellow-600"
                                count={sections.schedule.length}
                                expanded={expandedSections.schedule}
                                onToggle={() => toggleSection('schedule')}
                                controlsId="agenda-section-schedule"
                            >
                                <AgendaTaskList
                                    tasks={sections.schedule}
                                    buildFocusToggle={buildFocusToggle}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        {nextGroupBy === 'none' ? (
                            sections.nextActions.length > 0 && (
                                <AgendaCollapsibleSection
                                    title={t('agenda.nextActions')}
                                    icon={ArrowRight}
                                    color="text-blue-600"
                                    count={sections.nextActions.length}
                                    expanded={expandedSections.nextActions}
                                    onToggle={() => toggleSection('nextActions')}
                                    controlsId="agenda-section-nextActions"
                                >
                                    <AgendaTaskList
                                        tasks={sections.nextActions}
                                        buildFocusToggle={buildFocusToggle}
                                        showListDetails={showListDetails}
                                        highlightTaskId={highlightTaskId}
                                    />
                                </AgendaCollapsibleSection>
                            )
                        ) : (
                            sections.nextActions.length > 0 && (
                                <AgendaCollapsibleSection
                                    title={t('agenda.nextActions')}
                                    icon={ArrowRight}
                                    color="text-blue-600"
                                    count={sections.nextActions.length}
                                    expanded={expandedSections.nextActions}
                                    onToggle={() => toggleSection('nextActions')}
                                    controlsId="agenda-section-nextActions"
                                >
                                    <div className="space-y-2">
                                        {nextActionGroups.map((group) => (
                                            <div key={group.id} className="rounded-md border border-border/40 bg-card/30">
                                                <div className={cn(
                                                    'border-b border-border/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide',
                                                    group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                                                )}>
                                                    <span className="inline-flex items-center gap-1.5">
                                                        {group.dotColor && (
                                                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: group.dotColor }} aria-hidden="true" />
                                                        )}
                                                        <span>{group.title}</span>
                                                    </span>
                                                    <span className="ml-2 text-muted-foreground">{group.tasks.length}</span>
                                                </div>
                                                <AgendaTaskList
                                                    tasks={group.tasks}
                                                    buildFocusToggle={buildFocusToggle}
                                                    showListDetails={showListDetails}
                                                    highlightTaskId={highlightTaskId}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </AgendaCollapsibleSection>
                            )
                        )}

                        {sections.reviewDue.length > 0 && (
                            <AgendaCollapsibleSection
                                title={t('agenda.reviewDue') || 'Review Due'}
                                icon={Clock}
                                color="text-purple-600"
                                count={sections.reviewDue.length}
                                expanded={expandedSections.reviewDue}
                                onToggle={() => toggleSection('reviewDue')}
                                controlsId="agenda-section-reviewDue"
                            >
                                <AgendaTaskList
                                    tasks={sections.reviewDue}
                                    buildFocusToggle={buildFocusToggle}
                                    showListDetails={showListDetails}
                                    highlightTaskId={highlightTaskId}
                                />
                            </AgendaCollapsibleSection>
                        )}

                        <AgendaProjectSection
                            title={t('agenda.reviewDueProjects') || 'Projects to review'}
                            icon={Folder}
                            projects={reviewDueProjects}
                            color="text-indigo-600"
                            t={t}
                        />
                    </div>
                </>
            )}

            {!top3Only && !hasAgendaContent && (
                <div className="text-center py-12 text-muted-foreground flex flex-col items-center gap-2">
                    <CheckCircle2 className="w-10 h-10 text-emerald-500/80" aria-hidden="true" strokeWidth={1.5} />
                    <p className="text-lg font-medium text-foreground">{t('agenda.allClear')}</p>
                    <p className="text-sm">{hasTaskFilters ? t('filters.noMatch') : t('agenda.noTasks')}</p>
                </div>
            )}
            <PromptModal
                isOpen={saveFilterPromptOpen}
                title={resolveText('savedFilters.saveTitle', 'Save filter')}
                description={resolveText('savedFilters.saveDescription', 'Name this Focus filter.')}
                placeholder={resolveText('savedFilters.namePlaceholder', 'Filter name')}
                defaultValue={saveFilterDefaultName}
                confirmLabel={resolveText('common.save', 'Save')}
                cancelLabel={t('common.cancel')}
                onConfirm={handleSaveFilterConfirm}
                onCancel={() => setSaveFilterPromptOpen(false)}
            />
            <ConfirmModal
                isOpen={Boolean(filterPendingDelete)}
                title={resolveText('savedFilters.deleteTitle', 'Delete saved filter?')}
                description={filterPendingDelete?.name}
                confirmLabel={resolveText('common.delete', 'Delete')}
                cancelLabel={t('common.cancel')}
                onConfirm={handleDeleteSavedFilterConfirm}
                onCancel={() => setFilterPendingDelete(null)}
            />
            </div>
        </ErrorBoundary>
    );
}
