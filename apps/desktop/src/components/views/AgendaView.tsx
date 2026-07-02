import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, TaskPriority, TimeEstimate, applyFilter, buildAdvancedFilterCriteriaChips, removeAdvancedFilterCriteriaChip, formatFocusTaskLimitText, formatTimeEstimateLabel, generateUUID, getUsedTaskTokens, getFocusSequentialFirstTaskIds, getProjectDeadlineBoosts, getTaskMetadataFilterVisibility, hasActiveFilterCriteria, markSavedFilterDeleted, normalizeFocusTaskLimit, safeParseDate, safeParseDueDate, isDueForReview, isTaskInActiveProject, SAVED_FILTER_NO_PROJECT_ID, shouldShowTaskForStart, sortFocusNextActions, sortTasksBySavedPreference, translateWithFallback } from '@mindwtr/core';
import type { FilterCriteria, FocusGroupBy, MultiValueFilterMatchMode, ProjectDeadlineBoost, SavedFilter, SortField, Task, TaskEnergyLevel } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/ui-store';
import { AlertCircle, Clock, ArrowRight, Folder, CheckCircle2, X, ChevronDown, ChevronRight } from 'lucide-react';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '@mindwtr/core';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { PomodoroPanel } from './PomodoroPanel';
import { AgendaFiltersPanel, type AgendaActiveFilterChip, type AgendaProjectFilterOption } from './agenda/AgendaFiltersPanel';
import { AgendaHeader } from './agenda/AgendaHeader';
import { AgendaCollapsibleSection, AgendaProjectSection } from './agenda/AgendaSections';
import { StoreTaskItem } from './list/StoreTaskItem';
import { groupTasksByArea, groupTasksByContext, groupTasksByEnergy, groupTasksByPerson, groupTasksByPriority, groupTasksByProject, groupTasksByTag, type NextGroupBy, type TaskGroup } from './list/next-grouping';
import { PromptModal } from '../PromptModal';
import { ConfirmModal } from '../ConfirmModal';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { FocusStarIcon } from '../FocusStarIcon';

const AGENDA_VIRTUALIZATION_THRESHOLD = 25;
const NO_PROJECT_FILTER_ID = SAVED_FILTER_NO_PROJECT_ID;
const AGENDA_ACTIVE_STATUSES: Task['status'][] = ['inbox', 'next', 'waiting', 'someday'];
const DEFAULT_FOCUS_SORT_BY: SortField = 'default';
const FOCUS_GROUP_BY_VALUES = new Set<FocusGroupBy>(['none', 'context', 'project', 'area', 'energy', 'priority', 'person', 'tag']);
const FOCUS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:focus:v1';

type FocusSectionKey = 'schedule' | 'nextActions' | 'reviewDue';
type FocusGroupCollapseKey = Exclude<NextGroupBy, 'none'>;

type FocusPersistedViewState = {
    expandedSections: Record<FocusSectionKey, boolean>;
    collapsedGroups: Partial<Record<FocusGroupCollapseKey, string[]>>;
};

const DEFAULT_FOCUS_VIEW_STATE: FocusPersistedViewState = {
    expandedSections: {
        schedule: true,
        nextActions: true,
        reviewDue: true,
    },
    collapsedGroups: {
        context: [],
        area: [],
        project: [],
        energy: [],
        priority: [],
        person: [],
        tag: [],
    },
};

function sanitizeFocusViewState(value: unknown, fallback: FocusPersistedViewState): FocusPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<FocusPersistedViewState>
        : {};
    const expandedSections = parsed.expandedSections && typeof parsed.expandedSections === 'object' && !Array.isArray(parsed.expandedSections)
        ? parsed.expandedSections as Partial<Record<FocusSectionKey, boolean>>
        : {};
    const collapsedGroups = parsed.collapsedGroups && typeof parsed.collapsedGroups === 'object' && !Array.isArray(parsed.collapsedGroups)
        ? parsed.collapsedGroups as Partial<Record<FocusGroupCollapseKey, unknown>>
        : {};
    const sanitizeGroupIds = (ids: unknown, fallbackIds: string[] | undefined = []) => (
        Array.isArray(ids)
            ? Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
            : fallbackIds ?? []
    );
    return {
        expandedSections: {
            schedule: typeof expandedSections.schedule === 'boolean' ? expandedSections.schedule : fallback.expandedSections.schedule,
            nextActions: typeof expandedSections.nextActions === 'boolean' ? expandedSections.nextActions : fallback.expandedSections.nextActions,
            reviewDue: typeof expandedSections.reviewDue === 'boolean' ? expandedSections.reviewDue : fallback.expandedSections.reviewDue,
        },
        collapsedGroups: {
            context: sanitizeGroupIds(collapsedGroups.context, fallback.collapsedGroups.context),
            area: sanitizeGroupIds(collapsedGroups.area, fallback.collapsedGroups.area),
            project: sanitizeGroupIds(collapsedGroups.project, fallback.collapsedGroups.project),
            energy: sanitizeGroupIds(collapsedGroups.energy, fallback.collapsedGroups.energy),
            priority: sanitizeGroupIds(collapsedGroups.priority, fallback.collapsedGroups.priority),
            person: sanitizeGroupIds(collapsedGroups.person, fallback.collapsedGroups.person),
            tag: sanitizeGroupIds(collapsedGroups.tag, fallback.collapsedGroups.tag),
        },
    };
}

function normalizeAgendaGroupBy(value: unknown): NextGroupBy {
    return FOCUS_GROUP_BY_VALUES.has(value as FocusGroupBy) ? value as NextGroupBy : 'none';
}

function getFocusGroupCollapseKey(value: NextGroupBy): FocusGroupCollapseKey | null {
    return value === 'none' ? null : value;
}

function getDomIdSegment(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'group';
}

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

function getProjectDeadlineBoostLabel(
    boost: ProjectDeadlineBoost | undefined,
    resolveText: (key: string, fallback: string) => string,
): string | undefined {
    if (!boost) return undefined;
    return boost.isOverdue
        ? resolveText('focus.projectOverdue', 'Project overdue')
        : resolveText('focus.projectDueToday', 'Project due today');
}

function buildFocusFilterCriteria({
    locations,
    priorities,
    energyLevels,
    projects,
    contextMatchMode,
    timeEstimates,
    tokens,
}: {
    contextMatchMode: MultiValueFilterMatchMode;
    energyLevels: TaskEnergyLevel[];
    locations: string[];
    priorities: TaskPriority[];
    projects: string[];
    timeEstimates: TimeEstimate[];
    tokens: string[];
}): FilterCriteria {
    const contexts = tokens.filter((token) => token.trim().startsWith('@'));
    const tags = tokens.filter((token) => token.trim().startsWith('#'));
    return {
        ...(contexts.length > 0 ? { contexts } : {}),
        ...(contexts.length > 1 ? { contextMatchMode } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(projects.length > 0 ? { projects } : {}),
        ...(locations.length > 0 ? { locations } : {}),
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
    getProjectDeadlineLabel,
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
    getProjectDeadlineLabel?: (taskId: string) => string | undefined;
    showListDetails: boolean;
    highlightTaskId: string | null;
}) {
    const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);
    // Desktop views scroll inside the shared main content pane, not the window.
    const scrollElement = getAgendaScrollElement(containerElement);
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
                        projectDeadlineLabel={getProjectDeadlineLabel?.(task.id)}
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
                            projectDeadlineLabel={getProjectDeadlineLabel?.(task.id)}
                        />
                    </div>
                );
            })}
        </div>
    );
}

export function AgendaView() {
    const perf = usePerformanceMonitor('AgendaView');
    const { projects, areas, updateTask, updateSettings, settings, error, highlightTaskId, setHighlightTask, taskChangeToken } = useTaskStore(
        (state) => ({
            projects: state.projects,
            areas: state.areas,
            updateTask: state.updateTask,
            updateSettings: state.updateSettings,
            settings: state.settings,
            error: state.error,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
            taskChangeToken: state.lastDataChangeAt,
        }),
        shallow
    );
    const getDerivedState = useTaskStore((state) => state.getDerivedState);
    const { activeTasksByStatus, projectMap, sequentialProjectIds, sequentialWithinSectionProjectIds, tasksById } = getDerivedState();
    const { t } = useLanguage();
    const { showListDetails, nextGroupBy, top3Only, setListOptions, collapseAllTaskDetails, setProjectView } = useUiStore((state) => ({
        showListDetails: state.listOptions.showDetails,
        nextGroupBy: state.listOptions.nextGroupBy,
        top3Only: state.listOptions.focusTop3Only,
        setListOptions: state.setListOptions,
        collapseAllTaskDetails: state.collapseAllTaskDetails,
        setProjectView: state.setProjectView,
    }));
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
    const [selectedEnergyLevels, setSelectedEnergyLevels] = useState<TaskEnergyLevel[]>([]);
    const [selectedTimeEstimates, setSelectedTimeEstimates] = useState<TimeEstimate[]>([]);
    const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
    const [contextMatchMode, setContextMatchMode] = useState<MultiValueFilterMatchMode>('all');
    const [locationFilter, setLocationFilter] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
    const [focusSortBy, setFocusSortBy] = useState<SortField>(DEFAULT_FOCUS_SORT_BY);
    const [saveFilterPromptOpen, setSaveFilterPromptOpen] = useState(false);
    const [filterPendingDelete, setFilterPendingDelete] = useState<SavedFilter | null>(null);
    const filterInputRef = useRef<HTMLInputElement | null>(null);
    const showFutureStarts = settings?.appearance?.showFutureStarts === true;
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        FOCUS_VIEW_STATE_STORAGE_KEY,
        DEFAULT_FOCUS_VIEW_STATE,
        sanitizeFocusViewState
    );
    const expandedSections = persistedViewState.expandedSections;
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const pomodoroEnabled = settings?.features?.pomodoro === true;
    const focusTaskLimit = normalizeFocusTaskLimit(settings?.gtd?.focusTaskLimit);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = resolveAreaFilter(settings?.filters?.areaId, areas);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('AgendaView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const derivedActiveTasks = useMemo(() => (
        AGENDA_ACTIVE_STATUSES.flatMap((status) => activeTasksByStatus.get(status) ?? [])
    ), [activeTasksByStatus, taskChangeToken]);

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
    const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(activeTasks, {
        prioritiesEnabled,
        timeEstimatesEnabled,
    }), [activeTasks, prioritiesEnabled, timeEstimatesEnabled]);
    const showPriorityFilters = metadataFilterVisibility.priority;
    const showEnergyLevelFilters = metadataFilterVisibility.energyLevel;
    const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
    const showLocationFilter = metadataFilterVisibility.location;
    const activePriorities = showPriorityFilters ? selectedPriorities : [];
    const activeTimeEstimates = showTimeEstimateFilters ? selectedTimeEstimates : [];
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
    const showNoProjectOption = activeTasks.some((task) => !task.projectId);
    const formatEstimate = formatTimeEstimateLabel;
    const savedFocusFilters = (settings?.savedFilters ?? []).filter((filter) => filter.view === 'focus' && !filter.deletedAt);
    const activeSavedFilter = savedFocusFilters.find((filter) => filter.id === activeSavedFilterId) ?? null;
    const effectiveFocusSortBy = activeSavedFilter?.sortBy ?? focusSortBy;
    const effectiveNextGroupBy = normalizeAgendaGroupBy(activeSavedFilter?.groupBy ?? nextGroupBy);
    const currentFilterCriteria = buildFocusFilterCriteria({
        tokens: selectedTokens,
        contextMatchMode,
        projects: selectedProjects,
        locations: showLocationFilter && locationFilter.trim() ? [locationFilter.trim()] : [],
        priorities: activePriorities,
        energyLevels: showEnergyLevelFilters ? selectedEnergyLevels : [],
        timeEstimates: activeTimeEstimates,
    });
    const rawEffectiveFilterCriteria = activeSavedFilter?.criteria ?? currentFilterCriteria;
    const effectiveContextMatchMode = rawEffectiveFilterCriteria.contextMatchMode ?? 'all';
    const effectiveFilterCriteria: FilterCriteria = {
        ...rawEffectiveFilterCriteria,
        ...(showPriorityFilters ? {} : { priority: undefined }),
        ...(showEnergyLevelFilters ? {} : { energy: undefined }),
        ...(showLocationFilter ? {} : { locations: undefined }),
        ...(showTimeEstimateFilters ? {} : { timeEstimates: undefined, timeEstimateRange: undefined }),
    };
    const hasCurrentFilterCriteria = hasActiveFilterCriteria(currentFilterCriteria);
    const hasFilters = hasActiveFilterCriteria(effectiveFilterCriteria);
    const canSaveFocusPerspective = activeSavedFilterId === null
        && (
            hasCurrentFilterCriteria
            || focusSortBy !== DEFAULT_FOCUS_SORT_BY
            || effectiveNextGroupBy !== 'none'
        );
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
        (showPriorityFilters ? activePriorities : []).forEach((priority) => {
            chips.push({
                id: `priority:${priority}`,
                label: t(`priority.${priority}`),
            });
        });
        (showEnergyLevelFilters ? selectedEnergyLevels : []).forEach((energyLevel) => {
            chips.push({
                id: `energy:${energyLevel}`,
                label: t(`energyLevel.${energyLevel}`),
            });
        });
        (showTimeEstimateFilters ? activeTimeEstimates : []).forEach((estimate) => {
            chips.push({
                id: `time:${estimate}`,
                label: formatEstimate(estimate),
            });
        });
        const normalizedLocationFilter = locationFilter.trim();
        if (showLocationFilter && normalizedLocationFilter && !activeSavedFilter) {
            chips.push({
                id: `location:${normalizedLocationFilter}`,
                label: `${resolveText('taskEdit.locationLabel', 'Location')}: ${normalizedLocationFilter}`,
            });
        }
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
        locationFilter,
        selectedProjects,
        selectedTokens,
        t,
    ]);
    const activeFilterCount = activeFilterChips.length
        + (normalizedSearchQuery ? 1 : 0)
        + (effectiveFocusSortBy !== DEFAULT_FOCUS_SORT_BY ? 1 : 0)
        + (activeSavedFilterId && activeFilterChips.length === 0 && effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY ? 1 : 0);
    const saveFilterDefaultName = getSavedFilterDefaultName(activeFilterChips, resolveText('savedFilters.defaultName', 'Focus filter'));

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
    const handleOpenReviewProject = useCallback((projectId: string) => {
        setProjectView({ selectedProjectId: projectId });
        dispatchNavigateEvent('projects');
    }, [setProjectView]);
    const hasTaskFilters = hasFilters || Boolean(normalizedSearchQuery);
    const showFiltersPanel = filtersOpen;
    const shouldRenderFiltersPanel = filtersOpen
        || hasTaskFilters
        || focusSortBy !== DEFAULT_FOCUS_SORT_BY
        || Boolean(activeSavedFilterId);
    useEffect(() => {
        if (activeSavedFilterId && !activeSavedFilter) {
            setActiveSavedFilterId(null);
        }
    }, [activeSavedFilter, activeSavedFilterId]);
    useEffect(() => {
        if (!filtersOpen) return;
        filterInputRef.current?.focus();
    }, [filtersOpen]);
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
    const updateContextMatchMode = useCallback((mode: MultiValueFilterMatchMode) => {
        setActiveSavedFilterId(null);
        setContextMatchMode(mode);
    }, []);
    const updateLocationFilter = (value: string) => {
        setActiveSavedFilterId(null);
        setLocationFilter(value);
    };
    const updateFocusSortBy = useCallback((value: SortField) => {
        setActiveSavedFilterId(null);
        setFocusSortBy(value);
    }, []);
    const updateFocusGroupBy = useCallback((value: NextGroupBy) => {
        setActiveSavedFilterId(null);
        setListOptions({ nextGroupBy: value });
    }, [setListOptions]);
    const clearFilters = () => {
        setActiveSavedFilterId(null);
        setFocusSortBy(DEFAULT_FOCUS_SORT_BY);
        setSelectedTokens([]);
        setSelectedProjects([]);
        setLocationFilter('');
        setSelectedPriorities([]);
        setSelectedEnergyLevels([]);
        setSelectedTimeEstimates([]);
        setContextMatchMode('all');
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
        setLocationFilter((criteria.locations ?? [])[0] ?? '');
        setSelectedPriorities((criteria.priority ?? []).filter((priority): priority is TaskPriority => (
            priority !== 'none' && prioritySet.has(priority)
        )));
        setSelectedEnergyLevels((criteria.energy ?? []).filter((energy): energy is TaskEnergyLevel => energySet.has(energy)));
        setSelectedTimeEstimates((criteria.timeEstimates ?? []).filter((estimate): estimate is TimeEstimate => estimateSet.has(estimate)));
        setContextMatchMode(criteria.contextMatchMode ?? 'all');
        setFocusSortBy(filter.sortBy ?? DEFAULT_FOCUS_SORT_BY);
        setActiveSavedFilterId(filter.id);
        setFiltersOpen(false);
    }, [energyLevelOptions, priorityOptions, timeEstimateOptions]);
    const handleSaveFilterConfirm = useCallback((name: string) => {
        const trimmedName = name.trim();
        if (!trimmedName || !canSaveFocusPerspective) return;
        const nowIso = new Date().toISOString();
        const nextFilter: SavedFilter = {
            id: generateUUID(),
            name: trimmedName,
            view: 'focus',
            criteria: currentFilterCriteria,
            ...(focusSortBy !== DEFAULT_FOCUS_SORT_BY ? { sortBy: focusSortBy } : {}),
            ...(effectiveNextGroupBy !== 'none' ? { groupBy: effectiveNextGroupBy } : {}),
            createdAt: nowIso,
            updatedAt: nowIso,
        };
        void updateSettings({
            savedFilters: [...(settings?.savedFilters ?? []), nextFilter],
        }).then(() => {
            setSaveFilterPromptOpen(false);
            setActiveSavedFilterId(nextFilter.id);
        }).catch(() => undefined);
    }, [canSaveFocusPerspective, currentFilterCriteria, effectiveNextGroupBy, focusSortBy, settings?.savedFilters, updateSettings]);
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
        if (!showPriorityFilters && selectedPriorities.length > 0) {
            setSelectedPriorities([]);
        }
        if (!showEnergyLevelFilters && selectedEnergyLevels.length > 0) {
            setSelectedEnergyLevels([]);
        }
        if (!showLocationFilter && locationFilter.trim().length > 0) {
            setLocationFilter('');
        }
        if (!showTimeEstimateFilters && selectedTimeEstimates.length > 0) {
            setSelectedTimeEstimates([]);
        }
    }, [locationFilter, selectedEnergyLevels.length, selectedPriorities.length, selectedTimeEstimates.length, showEnergyLevelFilters, showLocationFilter, showPriorityFilters, showTimeEstimateFilters]);

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
    const sortBySavedPerspective = useCallback((items: Task[]) => {
        if (effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY) return items;
        return sortTasksBySavedPreference(items, effectiveFocusSortBy, {
            projects,
            prioritizeByPriority: prioritiesEnabled,
            sortOrder: activeSavedFilter?.sortOrder,
        });
    }, [activeSavedFilter?.sortOrder, effectiveFocusSortBy, prioritiesEnabled, projects]);

    const focusedTasks = useMemo(() => (
        sortBySavedPerspective(filteredActiveTasks.filter(t => t.isFocusedToday))
    ), [filteredActiveTasks, sortBySavedPerspective]);

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
        const sequentialFirstTasks = getFocusSequentialFirstTaskIds(baseActiveTasks, sequentialProjectIds, {
            now,
            sectionScopedProjectIds: sequentialWithinSectionProjectIds,
        });
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
        const projectDeadlineBoosts = effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
            ? getProjectDeadlineBoosts(nextActions, projects, { now })
            : new Map<string, ProjectDeadlineBoost>();
        const reviewDue = reviewDueCandidates.filter(t => !t.isFocusedToday);
        const scheduleSortTime = (task: Task) => {
            const due = safeParseDueDate(task.dueDate)?.getTime();
            const start = safeParseDate(task.startTime)?.getTime();
            if (typeof due === 'number' && typeof start === 'number') return Math.min(due, start);
            if (typeof due === 'number') return due;
            if (typeof start === 'number') return start;
            return Number.POSITIVE_INFINITY;
        };

        const sortSchedule = (items: Task[]) => (
            effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
                ? sortWith(items, scheduleSortTime)
                : sortBySavedPerspective(items)
        );
        const sortNextActions = (items: Task[]) => (
            effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
                ? sortFocusNextActions(items, {
                    now,
                    prioritizeByPriority: prioritiesEnabled,
                    projectDeadlineBoosts,
                })
                : sortBySavedPerspective(items)
        );
        const sortReviewDue = (items: Task[]) => (
            effectiveFocusSortBy === DEFAULT_FOCUS_SORT_BY
                ? sortWith(items, (task) => safeParseDate(task.reviewAt)?.getTime() ?? Number.POSITIVE_INFINITY)
                : sortBySavedPerspective(items)
        );

        return {
            schedule: sortSchedule(schedule),
            nextActions: sortNextActions(nextActions),
            reviewDue: sortReviewDue(reviewDue),
            projectDeadlineBoosts,
        };
    }, [
        baseActiveTasks,
        effectiveFocusSortBy,
        filteredActiveTasks,
        prioritiesEnabled,
        projects,
        reviewDueCandidates,
        sequentialProjectIds,
        sequentialWithinSectionProjectIds,
        sortBySavedPerspective,
    ]);
    const nextActionGroups = useMemo(() => {
        if (effectiveNextGroupBy === 'none') return [] as TaskGroup[];
        if (effectiveNextGroupBy === 'area') {
            return groupTasksByArea({
                areas,
                tasks: sections.nextActions,
                projectMap,
                generalLabel: resolveText('settings.general', 'General'),
            });
        }
        if (effectiveNextGroupBy === 'project') {
            return groupTasksByProject({
                tasks: sections.nextActions,
                projectMap,
                noProjectLabel: resolveText('taskEdit.noProjectOption', 'No project'),
            });
        }
        if (effectiveNextGroupBy === 'priority') {
            return groupTasksByPriority({
                tasks: sections.nextActions,
                getPriorityLabel: (priority) => t(`priority.${priority}`),
                noPriorityLabel: resolveText('focus.group.noPriority', 'No priority'),
            });
        }
        if (effectiveNextGroupBy === 'energy') {
            return groupTasksByEnergy({
                tasks: sections.nextActions,
                getEnergyLabel: (energy) => t(`energyLevel.${energy}`),
                noEnergyLabel: resolveText('focus.group.noEnergy', 'No energy'),
            });
        }
        if (effectiveNextGroupBy === 'person') {
            return groupTasksByPerson({
                tasks: sections.nextActions,
                unassignedLabel: resolveText('people.unassigned', 'Unassigned'),
            });
        }
        if (effectiveNextGroupBy === 'tag') {
            return groupTasksByTag({
                tasks: sections.nextActions,
                noTagLabel: resolveText('projects.noTags', 'No tags'),
            });
        }
        return groupTasksByContext({
            tasks: sections.nextActions,
            noContextLabel: resolveText('contexts.none', 'No context'),
        });
    }, [areas, effectiveNextGroupBy, projectMap, resolveText, sections.nextActions, t]);
    const activeGroupCollapseKey = getFocusGroupCollapseKey(effectiveNextGroupBy);
    const collapsedNextActionGroupIds = useMemo(() => new Set(
        activeGroupCollapseKey ? persistedViewState.collapsedGroups[activeGroupCollapseKey] ?? [] : []
    ), [activeGroupCollapseKey, persistedViewState.collapsedGroups]);
    const getProjectDeadlineLabel = useCallback((taskId: string) => (
        getProjectDeadlineBoostLabel(sections.projectDeadlineBoosts.get(taskId), resolveText)
    ), [resolveText, sections.projectDeadlineBoosts]);
    const focusedCount = focusedTasks.length;
    const { top3Tasks, remainingCount } = useMemo(() => {
        const byId = new Map<string, Task>();
        [...sections.schedule, ...sections.nextActions, ...sections.reviewDue].forEach((task) => {
            if (!byId.has(task.id)) {
                byId.set(task.id, task);
            }
        });
        const candidates = Array.from(byId.values());
        const top3 = candidates.slice(0, 3);
        return {
            top3Tasks: top3,
            remainingCount: Math.max(candidates.length - top3.length, 0),
        };
    }, [sections]);

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

    const toggleSection = useCallback((sectionKey: FocusSectionKey) => {
        setPersistedViewState((current) => ({
            ...current,
            expandedSections: {
                ...current.expandedSections,
                [sectionKey]: !current.expandedSections[sectionKey],
            },
        }));
    }, [setPersistedViewState]);
    const toggleNextActionGroup = useCallback((groupId: string) => {
        const collapseKey = getFocusGroupCollapseKey(effectiveNextGroupBy);
        if (!collapseKey) return;
        setPersistedViewState((current) => {
            const currentIds = current.collapsedGroups[collapseKey] ?? [];
            const nextIds = currentIds.includes(groupId)
                ? currentIds.filter((id) => id !== groupId)
                : [...currentIds, groupId];
            return {
                ...current,
                collapsedGroups: {
                    ...current.collapsedGroups,
                    [collapseKey]: nextIds,
                },
            };
        });
    }, [effectiveNextGroupBy, setPersistedViewState]);

    const nextActionsCount = sections.nextActions.length;
    const hasAgendaContent = focusedTasks.length > 0
        || sections.schedule.length > 0
        || sections.nextActions.length > 0
        || sections.reviewDue.length > 0
        || reviewDueProjects.length > 0;
    const pomodoroTasks = (() => {
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
    })();
    const handleToggleDetails = useCallback(() => {
        if (showListDetails) {
            collapseAllTaskDetails();
            setListOptions({ showDetails: false });
            return;
        }
        setListOptions({ showDetails: true });
    }, [collapseAllTaskDetails, setListOptions, showListDetails]);
    const todaysFocusSection = focusedTasks.length > 0 ? (
        <div
            data-testid="todays-focus-section"
            className="rounded-xl border border-border/70 border-l-4 border-l-amber-400 bg-card/70 p-6 shadow-sm dark:border-border/60 dark:border-l-amber-400/80 dark:bg-card/60"
        >
            <h3 className="font-bold text-lg flex items-center gap-2 mb-4 text-foreground">
                <FocusStarIcon className="w-5 h-5 text-yellow-500 dark:text-amber-300" filled />
                {t('agenda.todaysFocus')}
                <span className="text-sm font-normal text-muted-foreground">
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
    ) : null;

    return (
        <ErrorBoundary>
            <div className="space-y-6 w-full">
            <AgendaHeader
                filterCount={activeFilterCount}
                filtersOpen={filtersOpen}
                nextActionsCount={nextActionsCount}
                nextGroupBy={effectiveNextGroupBy}
                onChangeGroupBy={updateFocusGroupBy}
                onToggleFilters={() => setFiltersOpen((prev) => !prev)}
                onToggleDetails={handleToggleDetails}
                onToggleTop3={() => setListOptions({ focusTop3Only: !top3Only })}
                resolveText={resolveText}
                showListDetails={showListDetails}
                t={t}
                top3Only={top3Only}
            />

            {savedFocusFilters.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                    <button
                        type="button"
                        onClick={clearAllFilters}
                        aria-pressed={!hasTaskFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY}
                        className={cn(
                            'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                            !hasTaskFilters && !activeSavedFilterId && focusSortBy === DEFAULT_FOCUS_SORT_BY
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
                </div>
            )}

            {pomodoroEnabled && <PomodoroPanel tasks={pomodoroTasks} />}

            {shouldRenderFiltersPanel && (
                <AgendaFiltersPanel
                    allTokens={allTokens}
                    activeFilterChips={activeFilterChips}
                    canSaveFilter={canSaveFocusPerspective}
                    contextMatchMode={effectiveContextMatchMode}
                    contextMatchModeLabels={{
                        title: resolveText('filters.contextMatchMode', 'Context match'),
                        any: resolveText('filters.matchAny', 'Any'),
                        all: resolveText('common.all', 'All'),
                    }}
                    energyLevelOptions={energyLevelOptions}
                    focusSortBy={effectiveFocusSortBy}
                    formatEstimate={formatEstimate}
                    hasFilters={activeFilterCount > 0}
                    locationFilter={locationFilter}
                    showEnergyLevelFilters={showEnergyLevelFilters}
                    showLocationFilter={showLocationFilter}
                    onClearFilters={clearAllFilters}
                    onLocationChange={updateLocationFilter}
                    onSaveFilter={() => setSaveFilterPromptOpen(true)}
                    onContextMatchModeChange={updateContextMatchMode}
                    onSearchChange={setSearchQuery}
                    onSortChange={updateFocusSortBy}
                    onToggleEnergy={toggleEnergyFilter}
                    onToggleFiltersOpen={() => setFiltersOpen((prev) => !prev)}
                    onToggleProject={toggleProjectFilter}
                    onTogglePriority={togglePriorityFilter}
                    onToggleTime={toggleTimeFilter}
                    onToggleToken={toggleTokenFilter}
                    showPriorityFilters={showPriorityFilters}
                    projectOptions={projectOptions}
                    priorityOptions={priorityOptions}
                    searchInputRef={filterInputRef}
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
                    showTimeEstimateFilters={showTimeEstimateFilters}
                />
            )}

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
                    {todaysFocusSection}
                    <div className="space-y-2">
                        <h3 className="font-semibold">{t('agenda.top3Title')}</h3>
                        {top3Tasks.length > 0 ? (
                            <div className="divide-y divide-border/30">
                                {top3Tasks.map(task => (
                                    <StoreTaskItem
                                        key={task.id}
                                        taskId={task.id}
                                        buildFocusToggle={buildFocusToggle}
                                        showProjectBadgeInActions={false}
                                        compactMetaEnabled={showListDetails}
                                        enableDoubleClickEdit
                                        projectDeadlineLabel={getProjectDeadlineLabel(task.id)}
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
                    {todaysFocusSection}

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

                        {effectiveNextGroupBy === 'none' ? (
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
                                        getProjectDeadlineLabel={getProjectDeadlineLabel}
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
                                        {nextActionGroups.map((group, index) => {
                                            const collapsed = collapsedNextActionGroupIds.has(group.id);
                                            const controlsId = `agenda-next-group-${getDomIdSegment(effectiveNextGroupBy)}-${index}-${getDomIdSegment(group.id)}`;
                                            return (
                                                <div key={group.id} className="overflow-hidden rounded-lg border border-border/50 bg-card/40">
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleNextActionGroup(group.id)}
                                                        aria-expanded={!collapsed}
                                                        aria-controls={controlsId}
                                                        className={cn(
                                                            'flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30',
                                                            'focus:outline-none focus:ring-2 focus:ring-primary/30',
                                                            !collapsed && 'border-b border-border/30',
                                                        )}
                                                    >
                                                        <span className={cn(
                                                            'inline-flex min-w-0 items-center gap-2 text-sm font-semibold',
                                                            group.muted ? 'text-muted-foreground' : 'text-foreground',
                                                        )}>
                                                            {collapsed ? (
                                                                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                            ) : (
                                                                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                            )}
                                                            {group.dotColor && (
                                                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: group.dotColor }} aria-hidden="true" />
                                                            )}
                                                            <span className="truncate">{group.title}</span>
                                                        </span>
                                                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                                            {group.tasks.length}
                                                        </span>
                                                    </button>
                                                    {!collapsed && (
                                                        <div id={controlsId} className="ml-4 border-l border-border/40 pl-3">
                                                            <AgendaTaskList
                                                                tasks={group.tasks}
                                                                buildFocusToggle={buildFocusToggle}
                                                                getProjectDeadlineLabel={getProjectDeadlineLabel}
                                                                showListDetails={showListDetails}
                                                                highlightTaskId={highlightTaskId}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
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
                            onProjectPress={handleOpenReviewProject}
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
