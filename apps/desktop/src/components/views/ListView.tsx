import React, { memo, useState, useMemo, useDeferredValue, useEffect, useRef, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';
import {
    buildBulkOrganizeTaskUpdates,
    createTaskFilterPredicate,
    DEFAULT_AREA_COLOR,
    formatTimeEstimateLabel,
    getQuickAddProjectInitialProps,
    getTaskMetadataFilterVisibility,
    getWaitingPerson,
    hasActiveFilterCriteria,
    isTaskInActiveProject,
    parseQuickAdd,
    normalizeClockTimeInput,
    getDefaultTaskAreaMode,
    resolveDefaultNewTaskAreaId,
    safeParseDate,
    shallow,
    sortTasksBy,
    TaskPriority,
    TimeEstimate,
    translateWithFallback as translateTextWithFallback,
    useTaskStore,
} from '@mindwtr/core';
import type { FilterCriteria, Task, TaskStatus } from '@mindwtr/core';
import type { BulkOrganizeTaskUpdateInput } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { ConfirmModal } from '../ConfirmModal';
import { ErrorBoundary } from '../ErrorBoundary';
import { ListEmptyState } from './list/ListEmptyState';
import { ListControlsPanel } from './list/ListControlsPanel';
import { PromptModal } from '../PromptModal';
import { InboxProcessor } from './InboxProcessor';
import { MindSweepLauncher } from '../MindSweepModal';
import { TaskBulkOrganizeModal } from './list/TaskBulkOrganizeModal';
import { InboxProposalsZone } from '../InboxProposalsZone';
import { useLanguage } from '../../contexts/language-context';
import { useKeybindings } from '../../contexts/keybinding-context';
import { useListCopilot } from './list/useListCopilot';
import { useUiStore } from '../../store/ui-store';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { useListViewOptimizations } from '../../hooks/useListViewOptimizations';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import { dispatchNavigateEvent } from '../../lib/navigation-events';
import { reportError } from '../../lib/report-error';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '@mindwtr/core';
import { cn } from '../../lib/utils';
import { sortDoneTasksForListView } from './list/done-sort';
import { groupTasksByArea, groupTasksByContext, groupTasksByEnergy, groupTasksByPerson, groupTasksByPriority, groupTasksByProject, groupTasksByTag, groupTasksByAiStage, type NextGroupBy, type ReferenceGroupBy, type TaskGroup, type TaskListGroupBy } from './list/next-grouping';
import { useListSelection } from './list/useListSelection';
import { StoreTaskItem } from './list/StoreTaskItem';
import { AiAgentReviewControls } from '../AiAgentReviewControls';
import { RoutingTargetChip } from '../RoutingTargetChip';
import { LIST_VIRTUALIZATION_THRESHOLD, LIST_VIRTUAL_ROW_ESTIMATE, LIST_VIRTUAL_OVERSCAN } from './list/useVirtualList';


interface ListViewProps {
    title: string;
    statusFilter: TaskStatus | 'all';
    /**
     * When set, only tasks with this exact `assignedTo` value pass the filter.
     * Used by the dedicated "AI Agent" lane (`@ai-agent`) so we can surface
     * delegated tasks without overloading `status` (they stay `next`/`waiting`
     * per GTD semantics — only the view changes).
     */
    assignedToFilter?: string;
}

const EMPTY_PRIORITIES: TaskPriority[] = [];
const EMPTY_ESTIMATES: TimeEstimate[] = [];
const REFERENCE_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:reference:v1';
type ReferenceGroupCollapseKey = Exclude<ReferenceGroupBy, 'none'>;
type ReferencePersistedViewState = {
    collapsedGroups: Partial<Record<ReferenceGroupCollapseKey, string[]>>;
};
const DEFAULT_REFERENCE_VIEW_STATE: ReferencePersistedViewState = {
    collapsedGroups: {
        context: [],
        area: [],
        project: [],
        tag: [],
    },
};
type ShowToast = (
    message: string,
    tone?: 'success' | 'error' | 'info',
    durationMs?: number,
    action?: { label: string; onClick: () => void }
) => void;

function getListFilterTokens(criteria: FilterCriteria): string[] {
    return [...(criteria.contexts ?? []), ...(criteria.tags ?? [])];
}

function getListFilterPriorities(criteria: FilterCriteria): TaskPriority[] {
    return (criteria.priority ?? []).filter((priority): priority is TaskPriority => priority !== 'none');
}

function withListFilterValue<K extends keyof Pick<FilterCriteria, 'contexts' | 'tags' | 'priority' | 'timeEstimates'>>(
    criteria: FilterCriteria,
    key: K,
    values: NonNullable<FilterCriteria[K]>,
): FilterCriteria {
    const next = { ...criteria };
    if (values.length > 0) {
        next[key] = values;
    } else {
        delete next[key];
    }
    return next;
}

function sanitizeReferenceViewState(value: unknown, fallback: ReferencePersistedViewState): ReferencePersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<ReferencePersistedViewState>
        : {};
    const collapsedGroups = parsed.collapsedGroups && typeof parsed.collapsedGroups === 'object' && !Array.isArray(parsed.collapsedGroups)
        ? parsed.collapsedGroups as Partial<Record<ReferenceGroupCollapseKey, unknown>>
        : {};
    const sanitizeGroupIds = (ids: unknown, fallbackIds: string[] | undefined = []) => (
        Array.isArray(ids)
            ? Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)))
            : fallbackIds ?? []
    );
    return {
        collapsedGroups: {
            context: sanitizeGroupIds(collapsedGroups.context, fallback.collapsedGroups.context),
            area: sanitizeGroupIds(collapsedGroups.area, fallback.collapsedGroups.area),
            project: sanitizeGroupIds(collapsedGroups.project, fallback.collapsedGroups.project),
            tag: sanitizeGroupIds(collapsedGroups.tag, fallback.collapsedGroups.tag),
        },
    };
}

function getListDomIdSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

export function reportArchivedTaskQueryFailure(error: unknown, showToast: ShowToast): void {
    reportError('Failed to load archived tasks', error);
    showToast('Failed to load archived tasks', 'error');
}

export const ListView = memo(function ListView({ title, statusFilter, assignedToFilter }: ListViewProps) {
    const perf = usePerformanceMonitor('ListView');
    const {
        tasks,
        projects,
        areas,
        lastDataChangeAt,
        highlightTaskId,
    } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        areas: state.areas,
        lastDataChangeAt: state.lastDataChangeAt,
        highlightTaskId: state.highlightTaskId,
    }), shallow);
    const settings = useTaskStore((state) => state.settings);
    const {
        updateSettings,
        addTask,
        addProject,
        updateTask,
        updateProject,
        deleteTask,
        restoreTask,
        moveTask,
        batchMoveTasks,
        batchDeleteTasks,
        batchUpdateTasks,
        queryTasks,
        getDerivedState,
        setHighlightTask,
    } = useTaskStore((state) => ({
        updateSettings: state.updateSettings,
        addTask: state.addTask,
        addProject: state.addProject,
        updateTask: state.updateTask,
        updateProject: state.updateProject,
        deleteTask: state.deleteTask,
        restoreTask: state.restoreTask,
        moveTask: state.moveTask,
        batchMoveTasks: state.batchMoveTasks,
        batchDeleteTasks: state.batchDeleteTasks,
        batchUpdateTasks: state.batchUpdateTasks,
        queryTasks: state.queryTasks,
        getDerivedState: state.getDerivedState,
        setHighlightTask: state.setHighlightTask,
    }), shallow);
    const { t } = useLanguage();
    const { registerTaskListScope } = useKeybindings();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const isCompact = settings?.appearance?.density === 'compact';
    const densityMode = isCompact ? 'compact' : 'comfortable';
    const resolvedAreaFilter = resolveAreaFilter(settings?.filters?.areaId, areas);
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [quickAddSyntaxOpen, setQuickAddSyntaxOpen] = useState(false);
    const listFilters = useUiStore((state) => state.listFilters);
    const setListFilters = useUiStore((state) => state.setListFilters);
    const resetListFilters = useUiStore((state) => state.resetListFilters);
    const showToast = useUiStore((state) => state.showToast);
    const translateWithFallback = useCallback((key: string, fallback: string) => {
        return translateTextWithFallback(t, key, fallback);
    }, [t]);
    const showListDetails = useUiStore((state) => state.listOptions.showDetails);
    const nextGroupBy = useUiStore((state) => state.listOptions.nextGroupBy);
    const referenceGroupBy = useUiStore((state) => state.listOptions.referenceGroupBy);
    const setListOptions = useUiStore((state) => state.setListOptions);
    const collapseAllTaskDetails = useUiStore((state) => state.collapseAllTaskDetails);
    const setProjectView = useUiStore((state) => state.setProjectView);
    const [baseTasks, setBaseTasks] = useState<Task[]>(() => (statusFilter === 'archived' ? [] : tasks));
    const queryCacheRef = useRef<Map<string, Task[]>>(new Map());
    const listFilterCriteria = listFilters.criteria;
    const selectedTokens = useMemo(() => getListFilterTokens(listFilterCriteria), [listFilterCriteria]);
    const selectedPriorities = useMemo(() => getListFilterPriorities(listFilterCriteria), [listFilterCriteria]);
    const selectedTimeEstimates = listFilterCriteria.timeEstimates ?? EMPTY_ESTIMATES;
    const filtersOpen = listFilters.open;
    const [selectedWaitingPerson, setSelectedWaitingPerson] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const addInputRef = useRef<HTMLInputElement>(null);
    const viewFilterInputRef = useRef<HTMLInputElement>(null);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const [referenceViewState, setReferenceViewState] = usePersistedViewState(
        REFERENCE_VIEW_STATE_STORAGE_KEY,
        DEFAULT_REFERENCE_VIEW_STATE,
        sanitizeReferenceViewState,
    );
    const prioritiesEnabled = settings?.features?.priorities !== false;
    const timeEstimatesEnabled = settings?.features?.timeEstimates !== false;
    const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
    const showQuickDone = statusFilter !== 'done' && statusFilter !== 'archived';
    const readOnly = statusFilter === 'done';
    const showViewFilterInput = statusFilter !== 'inbox';
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const metadataProjectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const metadataAreaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const listFilterableTasks = useMemo(() => {
        const allowDeferredProjectTasks = statusFilter === 'done' || statusFilter === 'archived';
        return baseTasks.filter((task) => {
            if (task.deletedAt) return false;
            if (statusFilter !== 'all' && task.status !== statusFilter) return false;
            if (!allowDeferredProjectTasks && !isTaskInActiveProject(task, metadataProjectMap)) return false;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, metadataProjectMap, metadataAreaById)) return false;
            return true;
        });
    }, [baseTasks, metadataAreaById, metadataProjectMap, resolvedAreaFilter, statusFilter]);
    const metadataFilterVisibility = useMemo(() => getTaskMetadataFilterVisibility(listFilterableTasks, {
        prioritiesEnabled,
        timeEstimatesEnabled,
    }), [listFilterableTasks, prioritiesEnabled, timeEstimatesEnabled]);
    const showPriorityFilters = metadataFilterVisibility.priority;
    const showTimeEstimateFilters = metadataFilterVisibility.timeEstimate;
    const activePriorities = showPriorityFilters ? selectedPriorities : EMPTY_PRIORITIES;
    const activeTimeEstimates = showTimeEstimateFilters ? selectedTimeEstimates : EMPTY_ESTIMATES;
    const activeListFilterCriteria = useMemo<FilterCriteria>(() => ({
        ...listFilterCriteria,
        priority: showPriorityFilters ? activePriorities : undefined,
        timeEstimates: showTimeEstimateFilters ? activeTimeEstimates : undefined,
        timeEstimateRange: showTimeEstimateFilters ? listFilterCriteria.timeEstimateRange : undefined,
    }), [
        activePriorities,
        activeTimeEstimates,
        listFilterCriteria,
        showPriorityFilters,
        showTimeEstimateFilters,
    ]);
    const defaultAreaMode = getDefaultTaskAreaMode(settings);
    const activeNewTaskAreaId = resolvedAreaFilter !== AREA_FILTER_ALL && resolvedAreaFilter !== AREA_FILTER_NONE
        ? resolvedAreaFilter
        : undefined;
    const defaultNewTaskAreaId = defaultAreaMode === 'active'
        ? activeNewTaskAreaId
        : resolveDefaultNewTaskAreaId(settings, areas);

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ListView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    const [isProcessing, setIsProcessing] = useState(false);
    const [bulkOrganizeOpen, setBulkOrganizeOpen] = useState(false);
    const [isBulkOrganizing, setIsBulkOrganizing] = useState(false);
    const {
        allContexts,
        allTags,
        projectMap,
        sequentialProjectFirstTasks,
        tasksById,
        tokenCounts,
        nextCount,
    } = useListViewOptimizations(tasks, baseTasks, statusFilter, perf);
    const allTokens = Array.from(new Set([...allContexts, ...allTags])).sort();
    const quickAddParseOptions = useMemo(
        () => ({
            knownContexts: allContexts,
            knownTags: allTags,
            defaultScheduleTime: normalizeClockTimeInput(settings.gtd?.defaultScheduleTime) || undefined,
            preserveText: settings.quickAddAutoClean !== true,
        }),
        [allContexts, allTags, settings.gtd?.defaultScheduleTime, settings.quickAddAutoClean],
    );

    const {
        aiEnabled,
        copilotSuggestion,
        copilotApplied,
        copilotContext,
        copilotTags,
        applyCopilotSuggestion,
        resetCopilot,
    } = useListCopilot({
        settings,
        newTaskTitle,
        allContexts,
        allTags,
    });

    const projectOrderMap = useMemo(() => {
        const sorted = [...projects]
            .filter((project) => !project.deletedAt)
            .sort((a, b) => {
                const aOrder = Number.isFinite(a.order) ? (a.order as number) : Number.POSITIVE_INFINITY;
                const bOrder = Number.isFinite(b.order) ? (b.order as number) : Number.POSITIVE_INFINITY;
                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.title.localeCompare(b.title);
            });
        const map = new Map<string, number>();
        sorted.forEach((project, index) => map.set(project.id, index));
        return map;
    }, [projects]);

    const sortByProjectOrder = useCallback((items: Task[]) => {
        return [...items].sort((a, b) => {
            const aProjectOrder = a.projectId ? (projectOrderMap.get(a.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            const bProjectOrder = b.projectId ? (projectOrderMap.get(b.projectId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
            if (aProjectOrder !== bProjectOrder) return aProjectOrder - bProjectOrder;
            const aOrder = Number.isFinite(a.order)
                ? (a.order as number)
                : Number.isFinite(a.orderNum)
                    ? (a.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order)
                ? (b.order as number)
                : Number.isFinite(b.orderNum)
                    ? (b.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
            const aCreated = safeParseDate(a.createdAt)?.getTime() ?? 0;
            const bCreated = safeParseDate(b.createdAt)?.getTime() ?? 0;
            return aCreated - bCreated;
        });
    }, [projectOrderMap]);

    // For sequential projects, get only the first task to show in Next view

    useEffect(() => {
        perf.trackUseEffect();
        let cancelled = false;
        const status = statusFilter === 'all' ? undefined : statusFilter;
        const cacheKey = `${statusFilter}-${lastDataChangeAt}`;
        const cached = queryCacheRef.current.get(cacheKey);
        if (statusFilter !== 'archived') {
            const { activeTasksByStatus } = getDerivedState();
            const indexedTasks = statusFilter === 'all'
                ? tasks
                : activeTasksByStatus.get(statusFilter) ?? [];
            setBaseTasks(indexedTasks);
            queryCacheRef.current.set(cacheKey, indexedTasks);
            if (queryCacheRef.current.size > 10) {
                const firstKey = queryCacheRef.current.keys().next().value;
                if (firstKey) queryCacheRef.current.delete(firstKey);
            }
        } else if (cached) {
            setBaseTasks(cached);
            return;
        }
        if (statusFilter === 'archived') {
            queryTasks({
                status,
                includeArchived: status === 'archived',
                includeDeleted: false,
            }).then((result) => {
                if (cancelled) return;
                setBaseTasks(result);
                queryCacheRef.current.set(cacheKey, result);
                if (queryCacheRef.current.size > 10) {
                    const firstKey = queryCacheRef.current.keys().next().value;
                    if (firstKey) queryCacheRef.current.delete(firstKey);
                }
            }).catch((error) => {
                if (!cancelled) {
                    reportArchivedTaskQueryFailure(error, showToast);
                    setBaseTasks([]);
                }
            });
        }
        return () => {
            cancelled = true;
        };
    }, [statusFilter, queryTasks, getDerivedState, lastDataChangeAt, showToast, tasks]);

    useEffect(() => {
        setSearchQuery('');
    }, [statusFilter]);

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const waitingPeople = useMemo(() => {
        if (statusFilter !== 'waiting') return [];
        const people = new Map<string, string>();
        for (const task of baseTasks) {
            if (task.deletedAt || task.status !== 'waiting') continue;
            if (!isTaskInActiveProject(task, projectMap)) continue;
            if (!taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)) continue;
            const person = getWaitingPerson(task);
            if (!person) continue;
            const key = person.toLowerCase();
            if (!people.has(key)) people.set(key, person);
        }
        return [...people.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }, [areaById, baseTasks, projectMap, resolvedAreaFilter, statusFilter]);

    useEffect(() => {
        if (statusFilter !== 'waiting' && selectedWaitingPerson) {
            setSelectedWaitingPerson('');
            return;
        }
        if (!selectedWaitingPerson) return;
        const selectedKey = selectedWaitingPerson.toLowerCase();
        const exists = waitingPeople.some((person) => person.toLowerCase() === selectedKey);
        if (!exists) setSelectedWaitingPerson('');
    }, [selectedWaitingPerson, statusFilter, waitingPeople]);

    // Only show the filtering banner for user-driven filter changes.
    // Background task refreshes can still be deferred without shifting the list UI.
    const filterFeedbackInputs = useMemo(() => ({
        statusFilter,
        filterCriteria: activeListFilterCriteria,
        resolvedAreaFilter,
        selectedWaitingPerson,
        normalizedSearchQuery,
    }), [
        statusFilter,
        activeListFilterCriteria,
        resolvedAreaFilter,
        selectedWaitingPerson,
        normalizedSearchQuery,
    ]);
    const deferredFilterFeedbackInputs = useDeferredValue(filterFeedbackInputs);
    const isFiltering = deferredFilterFeedbackInputs !== filterFeedbackInputs;

    const filterInputs = useMemo(() => ({
        baseTasks,
        statusFilter,
        filterCriteria: activeListFilterCriteria,
        assignedToFilter,
        sequentialProjectFirstTasks,
        projectMap,
        projects,
        sortBy,
        sortByProjectOrder,
        resolvedAreaFilter,
        areaById,
        selectedWaitingPerson,
    }), [
        baseTasks,
        statusFilter,
        activeListFilterCriteria,
        assignedToFilter,
        sequentialProjectFirstTasks,
        projectMap,
        projects,
        sortBy,
        sortByProjectOrder,
        resolvedAreaFilter,
        areaById,
        selectedWaitingPerson,
    ]);
    const deferredFilterInputs = useDeferredValue(filterInputs);

    const filteredTasks = useMemo(() => {
        perf.trackUseMemo();
        return perf.measure('filteredTasks', () => {
            const now = new Date();
            const allowDeferredProjectTasks =
                deferredFilterInputs.statusFilter === 'done'
                || deferredFilterInputs.statusFilter === 'archived';
            const criteriaPredicate = hasActiveFilterCriteria(deferredFilterInputs.filterCriteria)
                ? createTaskFilterPredicate(deferredFilterInputs.filterCriteria, {
                    projects: deferredFilterInputs.projects,
                    tokenMatchMode: 'all',
                })
                : null;
            const filtered = deferredFilterInputs.baseTasks.filter(t => {
                // Always filter out soft-deleted tasks
                if (t.deletedAt) return false;

                if (deferredFilterInputs.statusFilter !== 'all' && t.status !== deferredFilterInputs.statusFilter) return false;
                if (deferredFilterInputs.assignedToFilter && t.assignedTo !== deferredFilterInputs.assignedToFilter) return false;
                // Agent-owned tasks live only in their own @ai-agent lane — keep
                // them out of Focus/Next/Inbox and every other normal view.
                if (deferredFilterInputs.assignedToFilter !== '@ai-agent' && t.assignedTo === '@ai-agent') return false;
                // Respect statusFilter (handled above).
                if (!allowDeferredProjectTasks && !isTaskInActiveProject(t, deferredFilterInputs.projectMap)) return false;
                if (!taskMatchesAreaFilter(
                    t,
                    deferredFilterInputs.resolvedAreaFilter,
                    deferredFilterInputs.projectMap,
                    deferredFilterInputs.areaById
                )) return false;

                if (deferredFilterInputs.statusFilter === 'next') {
                    const start = safeParseDate(t.startTime);
                    if (start && start > now) return false;
                }

                // Sequential project filter: for 'next' status, only show first task from sequential projects
                if (deferredFilterInputs.statusFilter === 'next' && t.projectId) {
                    const project = deferredFilterInputs.projectMap.get(t.projectId);
                    if (project?.isSequential) {
                        // Only include if this is the first task
                        if (!deferredFilterInputs.sequentialProjectFirstTasks.has(t.id)) return false;
                    }
                }


                if (criteriaPredicate && !criteriaPredicate(t)) return false;
                if (deferredFilterInputs.statusFilter === 'waiting' && deferredFilterInputs.selectedWaitingPerson) {
                    const person = getWaitingPerson(t);
                    if (!person || person.toLowerCase() !== deferredFilterInputs.selectedWaitingPerson.toLowerCase()) return false;
                }
                if (showViewFilterInput && normalizedSearchQuery && !t.title.toLowerCase().includes(normalizedSearchQuery)) {
                    return false;
                }
                return true;
            });

            if (deferredFilterInputs.statusFilter === 'next' && deferredFilterInputs.sortBy === 'default') {
                return deferredFilterInputs.sortByProjectOrder(filtered);
            }
            if (deferredFilterInputs.statusFilter === 'done' && deferredFilterInputs.sortBy === 'default') {
                return sortDoneTasksForListView(filtered);
            }

            return sortTasksBy(filtered, deferredFilterInputs.sortBy);
        });
    }, [deferredFilterInputs, normalizedSearchQuery, showViewFilterInput]);
    const resolveText = useCallback((key: string, fallback: string) => {
        return translateTextWithFallback(t, key, fallback);
    }, [t]);
    const activeNextGroupBy: NextGroupBy = statusFilter !== 'reference' ? nextGroupBy : 'none';
    const activeReferenceGroupBy: ReferenceGroupBy = statusFilter === 'reference' ? (referenceGroupBy ?? 'area') : 'none';
    const activeGroupBy: TaskListGroupBy = statusFilter === 'reference' ? activeReferenceGroupBy : activeNextGroupBy;
    const groupByOptions: TaskListGroupBy[] = statusFilter === 'reference'
        ? ['none', 'context', 'area', 'project', 'tag']
        : ['none', 'context', 'area', 'project', 'tag', 'energy', 'priority', 'person'];
    const isReferenceGrouping = statusFilter === 'reference' && activeReferenceGroupBy !== 'none';
    // AI Agent lane: always group by ai-stage so the user sees Review / Doing
    // / Queued / Error as separate sections.
    const isAiAgentGrouping = assignedToFilter === '@ai-agent';
    const aiStageGroups = useMemo(() => {
        if (!isAiAgentGrouping) return [] as TaskGroup[];
        return groupTasksByAiStage({ tasks: filteredTasks });
    }, [filteredTasks, isAiAgentGrouping]);
    const isListGrouping = isAiAgentGrouping || activeGroupBy !== 'none';
    const groupedTasks = useMemo(() => {
        if (isAiAgentGrouping) return aiStageGroups;
        if (activeGroupBy === 'none') return [] as TaskGroup[];
        if (activeGroupBy === 'area') {
            return groupTasksByArea({
                areas,
                tasks: filteredTasks,
                projectMap,
                generalLabel: resolveText('settings.general', 'General'),
            });
        }
        if (activeGroupBy === 'project') {
            return groupTasksByProject({
                tasks: filteredTasks,
                projectMap,
                noProjectLabel: resolveText('taskEdit.noProjectOption', 'No project'),
            });
        }
        if (activeGroupBy === 'priority') {
            return groupTasksByPriority({
                tasks: filteredTasks,
                getPriorityLabel: (priority) => t(`priority.${priority}`),
                noPriorityLabel: resolveText('focus.group.noPriority', 'No priority'),
            });
        }
        if (activeGroupBy === 'energy') {
            return groupTasksByEnergy({
                tasks: filteredTasks,
                getEnergyLabel: (energy) => t(`energyLevel.${energy}`),
                noEnergyLabel: resolveText('focus.group.noEnergy', 'No energy'),
            });
        }
        if (activeGroupBy === 'person') {
            return groupTasksByPerson({
                tasks: filteredTasks,
                unassignedLabel: resolveText('people.unassigned', 'Unassigned'),
            });
        }
        if (activeGroupBy === 'tag') {
            return groupTasksByTag({
                tasks: filteredTasks,
                noTagLabel: resolveText('projects.noTags', 'No tags'),
            });
        }
        return groupTasksByContext({
            tasks: filteredTasks,
            noContextLabel: resolveText('contexts.none', 'No context'),
        });
    }, [activeGroupBy, aiStageGroups, areas, filteredTasks, isAiAgentGrouping, projectMap, resolveText, t]);
    const activeReferenceCollapseKey: ReferenceGroupCollapseKey | null = isReferenceGrouping
        ? activeReferenceGroupBy as ReferenceGroupCollapseKey
        : null;
    const collapsedReferenceGroupIds = useMemo(() => {
        if (!activeReferenceCollapseKey) return new Set<string>();
        return new Set(referenceViewState.collapsedGroups[activeReferenceCollapseKey] ?? []);
    }, [activeReferenceCollapseKey, referenceViewState.collapsedGroups]);
    const toggleReferenceGroup = useCallback((groupId: string) => {
        if (!activeReferenceCollapseKey) return;
        setReferenceViewState((current) => {
            const currentIds = current.collapsedGroups[activeReferenceCollapseKey] ?? [];
            const nextIds = new Set(currentIds);
            if (nextIds.has(groupId)) {
                nextIds.delete(groupId);
            } else {
                nextIds.add(groupId);
            }
            return {
                collapsedGroups: {
                    ...current.collapsedGroups,
                    [activeReferenceCollapseKey]: Array.from(nextIds),
                },
            };
        });
    }, [activeReferenceCollapseKey, setReferenceViewState]);
    const taskIndexById = useMemo(() => {
        const map = new Map<string, number>();
        filteredTasks.forEach((task, index) => map.set(task.id, index));
        return map;
    }, [filteredTasks]);

    const showDeferredProjects = statusFilter === 'someday' || statusFilter === 'waiting';
    const deferredProjects = showDeferredProjects
        ? [...projects]
            .filter((project) => !project.deletedAt && project.status === statusFilter)
            .filter((project) => projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
            .sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title))
        : [];
    const showDeferredProjectSection = showDeferredProjects && deferredProjects.length > 0;
    const showEmptyState = filteredTasks.length === 0 && !showDeferredProjectSection;
    const handleOpenProject = useCallback((projectId: string) => {
        setProjectView({ selectedProjectId: projectId });
        dispatchNavigateEvent('projects');
    }, [setProjectView]);
    const handleReactivateProject = useCallback((projectId: string) => {
        updateProject(projectId, { status: 'active' })
            .catch((error) => {
                reportError('Failed to reactivate project', error);
                showToast(t('projects.reactivateFailed') || 'Failed to reactivate project', 'error');
            });
    }, [showToast, t, updateProject]);

    const shouldVirtualize = !isListGrouping && filteredTasks.length > LIST_VIRTUALIZATION_THRESHOLD;
    const rowVirtualizer = useVirtualizer({
        count: shouldVirtualize ? filteredTasks.length : 0,
        getScrollElement: () => listScrollRef.current,
        estimateSize: () => (isCompact ? 90 : LIST_VIRTUAL_ROW_ESTIMATE),
        overscan: Math.max(2, Math.ceil(LIST_VIRTUAL_OVERSCAN / LIST_VIRTUAL_ROW_ESTIMATE)),
        getItemKey: (index) => filteredTasks[index]?.id ?? index,
    });
    const virtualRows = shouldVirtualize ? rowVirtualizer.getVirtualItems() : [];
    const totalHeight = shouldVirtualize ? rowVirtualizer.getTotalSize() : 0;
    const {
        confirmBatchDelete,
        confirmSingleDelete,
        contextPromptMode,
        contextPromptOpen,
        exitSelectionMode,
        handleBatchAddContext,
        handleBatchAddTag,
        handleBatchAssignArea,
        handleBatchDelete,
        handleBatchMove,
        handleBatchRemoveContext,
        handleConfirmContextPrompt,
        handleConfirmTagPrompt,
        handleSelectIndex,
        isBatchDeleting,
        allVisibleTasksSelected,
        clearTaskSelection,
        multiSelectedIds,
        pendingBatchDeleteIds,
        pendingDeleteTask,
        selectedIdsArray,
        selectedIndex,
        selectAllVisibleTasks,
        selectionMode,
        setContextPromptOpen,
        setPendingBatchDeleteIds,
        setPendingDeleteTask,
        setTagPromptOpen,
        tagPromptOpen,
        toggleMultiSelect,
        toggleSelectionMode,
    } = useListSelection({
        activeNextGroupBy,
        addInputRef,
        batchDeleteTasks,
        batchMoveTasks,
        batchUpdateTasks,
        deleteTask,
        filteredTasks,
        highlightTaskId,
        isProcessing,
        moveTask,
        prioritiesEnabled,
        registerTaskListScope,
        restoreTask,
        scrollToVirtualIndex: (index, align) => rowVirtualizer.scrollToIndex(index, { align }),
        selectedPriorities,
        selectedTimeEstimates,
        selectedTokens,
        selectedWaitingPerson,
        setHighlightTask,
        shouldVirtualize,
        showToast,
        showViewFilterInput,
        statusFilter,
        t,
        tasksById,
        timeEstimatesEnabled,
        translateWithFallback,
        undoNotificationsEnabled,
        viewFilterInputRef,
    });
    const bulkAreaOptions = [...areas]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((area) => ({ id: area.id, name: area.name }));
    const handleApplyTaskBulkOrganize = useCallback(async (input: BulkOrganizeTaskUpdateInput) => {
        if (selectedIdsArray.length === 0 || isBulkOrganizing) return;
        const updates = buildBulkOrganizeTaskUpdates(selectedIdsArray, tasksById, input);
        if (updates.length === 0) return;
        setIsBulkOrganizing(true);
        try {
            await batchUpdateTasks(updates);
            setBulkOrganizeOpen(false);
            exitSelectionMode();
            const message = translateWithFallback(
                'bulk.organizeApplied',
                '{{count}} selected tasks organized',
            ).replace('{{count}}', String(updates.length));
            showToast(message, 'success');
        } catch (error) {
            reportError('Failed to bulk organize selected tasks', error);
            showToast(translateWithFallback('bulk.organizeFailed', 'Failed to organize selected tasks'), 'error');
        } finally {
            setIsBulkOrganizing(false);
        }
    }, [
        batchUpdateTasks,
        exitSelectionMode,
        isBulkOrganizing,
        selectedIdsArray,
        showToast,
        tasksById,
        translateWithFallback,
    ]);

    const handleAddTask = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTaskTitle.trim()) return;
        try {
            const { title: parsedTitle, props, projectTitle, invalidDateCommands, detectedDate } = parseQuickAdd(
                newTaskTitle,
                projects,
                new Date(),
                areas,
                quickAddParseOptions,
            );
            if (invalidDateCommands && invalidDateCommands.length > 0) {
                showToast(`${t('quickAdd.invalidDateCommand')}: ${invalidDateCommands.join(', ')}`, 'error');
                return;
            }
            const initialProps: Partial<Task> = { ...props };
            const shouldApplyDetectedDate = Boolean(detectedDate?.date && !initialProps.dueDate);
            if (shouldApplyDetectedDate && detectedDate) {
                initialProps.dueDate = detectedDate.date;
            }
            const finalTitle = shouldApplyDetectedDate && detectedDate
                ? detectedDate.titleWithoutDate
                : (parsedTitle || newTaskTitle);
            if (!initialProps.projectId && projectTitle) {
                const created = await addProject(
                    projectTitle,
                    DEFAULT_AREA_COLOR,
                    getQuickAddProjectInitialProps(initialProps, defaultNewTaskAreaId),
                );
                if (!created) return;
                initialProps.projectId = created.id;
            }
            if (!initialProps.projectId && !initialProps.areaId && defaultNewTaskAreaId) {
                initialProps.areaId = defaultNewTaskAreaId;
            }
            // Only set status if we have an explicit filter and parser didn't set one
            if (!initialProps.status && statusFilter !== 'all') {
                initialProps.status = statusFilter;
            }
            if (copilotContext) {
                const existing = initialProps.contexts ?? [];
                initialProps.contexts = Array.from(new Set([...existing, copilotContext]));
            }
            if (copilotTags.length) {
                const existingTags = initialProps.tags ?? [];
                initialProps.tags = Array.from(new Set([...existingTags, ...copilotTags]));
            }
            await addTask(finalTitle, initialProps);
            setNewTaskTitle('');
            resetCopilot();
        } catch (error) {
            reportError('Failed to add task from quick add', error);
            showToast(t('task.addFailed') || 'Failed to add task', 'error');
        }
    };

    const showFilters = ['next', 'all'].includes(statusFilter);
    const isInbox = statusFilter === 'inbox';
    const isNextView = statusFilter === 'next';
    const isWaitingView = statusFilter === 'waiting';
    const showQuickAdd = isInbox;
    const priorityOptions: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
    const timeEstimateOptions: TimeEstimate[] = ['5min', '10min', '15min', '30min', '1hr', '2hr', '3hr', '4hr', '4hr+'];
    const formatEstimate = formatTimeEstimateLabel;
    const filterSummary = [
        ...(normalizedSearchQuery ? [`${t('common.search')}: ${searchQuery.trim()}`] : []),
        ...selectedTokens,
        ...(showPriorityFilters ? selectedPriorities.map((priority) => t(`priority.${priority}`)) : []),
        ...(showTimeEstimateFilters ? selectedTimeEstimates.map(formatEstimate) : []),
        ...(selectedWaitingPerson ? [`${t('process.delegateWhoLabel')}: ${selectedWaitingPerson}`] : []),
    ];
    const hasFilters = filterSummary.length > 0;
    const filterSummaryLabel = filterSummary.slice(0, 3).join(', ');
    const filterSummarySuffix = filterSummary.length > 3 ? ` +${filterSummary.length - 3}` : '';
    const showFiltersPanel = filtersOpen;
    const toggleTokenFilter = useCallback((token: string) => {
        const key = token.trim().startsWith('#') ? 'tags' : 'contexts';
        const current = listFilterCriteria[key] ?? [];
        const nextValues = current.includes(token)
            ? current.filter((item) => item !== token)
            : [...current, token];
        setListFilters({ criteria: withListFilterValue(listFilterCriteria, key, nextValues) });
    }, [listFilterCriteria, setListFilters]);
    const togglePriorityFilter = useCallback((priority: TaskPriority) => {
        const nextPriorities = selectedPriorities.includes(priority)
            ? selectedPriorities.filter((item) => item !== priority)
            : [...selectedPriorities, priority];
        setListFilters({ criteria: withListFilterValue(listFilterCriteria, 'priority', nextPriorities) });
    }, [listFilterCriteria, selectedPriorities, setListFilters]);
    const toggleTimeFilter = useCallback((estimate: TimeEstimate) => {
        const nextEstimates = selectedTimeEstimates.includes(estimate)
            ? selectedTimeEstimates.filter((item) => item !== estimate)
            : [...selectedTimeEstimates, estimate];
        setListFilters({ criteria: withListFilterValue(listFilterCriteria, 'timeEstimates', nextEstimates) });
    }, [listFilterCriteria, selectedTimeEstimates, setListFilters]);
    const clearFilters = () => {
        resetListFilters();
    };

    useEffect(() => {
        let nextCriteria: FilterCriteria | null = null;
        if (!showPriorityFilters && selectedPriorities.length > 0) {
            nextCriteria = { ...(nextCriteria ?? listFilterCriteria) };
            delete nextCriteria.priority;
        }
        if (!showTimeEstimateFilters && selectedTimeEstimates.length > 0) {
            nextCriteria = { ...(nextCriteria ?? listFilterCriteria) };
            delete nextCriteria.timeEstimates;
            delete nextCriteria.timeEstimateRange;
        }
        if (nextCriteria) setListFilters({ criteria: nextCriteria });
    }, [listFilterCriteria, selectedPriorities.length, selectedTimeEstimates.length, setListFilters, showPriorityFilters, showTimeEstimateFilters]);

    const openQuickAdd = useCallback((status: TaskStatus | 'all', captureMode?: 'text' | 'audio') => {
        const initialStatus = status === 'all' ? 'inbox' : status;
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status: initialStatus }, captureMode },
        }));
    }, []);

    const emptyState = (() => {
        switch (statusFilter) {
            case 'inbox':
                return {
                    title: t('list.inbox') || 'Inbox',
                    body: resolveText('inbox.emptyAddHint', 'Inbox is clear. Capture something new.'),
                    action: t('nav.addTask') || 'Add task',
                };
            case 'next':
                return {
                    title: t('list.next') || 'Next Actions',
                    body: resolveText('list.noTasks', 'No next actions yet.'),
                };
            case 'waiting':
                return {
                    title: resolveText('waiting.empty', t('list.waiting') || 'Waiting'),
                    body: resolveText('waiting.emptyHint', 'Track delegated or pending items.'),
                };
            case 'someday':
                return {
                    title: resolveText('someday.empty', t('list.someday') || 'Someday'),
                    body: resolveText('someday.emptyHint', 'Store ideas for later.'),
                };
            case 'reference':
                return {
                    title: resolveText('reference.empty', t('list.reference') || 'Reference'),
                    body: resolveText('reference.emptyHint', 'Reference holds info you might want later — no action required.'),
                };
            case 'done':
                return {
                    title: t('list.done') || 'Done',
                    body: resolveText('done.emptyHint', 'Completed tasks land here — a running log of what you finished.'),
                };
            default:
                return {
                    title: t('list.tasks') || 'Tasks',
                    body: resolveText('list.noTasks', 'No tasks yet.'),
                };
        }
    })();
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
            <div className="flex h-full flex-col">
                <ListControlsPanel
                    title={title}
                    t={t}
                    nextCount={nextCount}
                    taskCount={filteredTasks.length}
                    hasFilters={hasFilters}
                    filterSummaryLabel={filterSummaryLabel}
                    filterSummarySuffix={filterSummarySuffix}
                    sortBy={sortBy}
                    onChangeSortBy={(value) => updateSettings({ taskSortBy: value })}
                    activeGroupBy={activeGroupBy}
                    groupByOptions={groupByOptions}
                    showGroupBy
                    onChangeGroupBy={(value) => {
                        if (statusFilter === 'reference') {
                            setListOptions({ referenceGroupBy: value as ReferenceGroupBy });
                            return;
                        }
                        setListOptions({ nextGroupBy: value as NextGroupBy });
                    }}
                    selectionMode={selectionMode}
                    onToggleSelection={toggleSelectionMode}
                    showListDetails={showListDetails}
                    onToggleDetails={handleToggleDetails}
                    densityMode={densityMode}
                    onToggleDensity={() => {
                        void updateSettings({
                            appearance: {
                                density: densityMode === 'compact' ? 'comfortable' : 'compact',
                            },
                        });
                    }}
                    isProcessing={isProcessing}
                    isBatchDeleting={isBatchDeleting}
                    selectedCount={selectedIdsArray.length}
                    allVisibleTasksSelected={allVisibleTasksSelected}
                    onSelectAllVisible={selectAllVisibleTasks}
                    onClearSelection={clearTaskSelection}
                    onMoveToStatus={handleBatchMove}
                    onAssignArea={handleBatchAssignArea}
                    areaOptions={bulkAreaOptions}
                    onBulkOrganize={() => setBulkOrganizeOpen(true)}
                    onAddTag={handleBatchAddTag}
                    onAddContext={handleBatchAddContext}
                    onRemoveContext={handleBatchRemoveContext}
                    onDeleteSelection={handleBatchDelete}
                    isNextView={isNextView}
                    showDeferredProjectSection={showDeferredProjectSection}
                    deferredProjects={deferredProjects}
                    areaById={areaById}
                    onOpenProject={handleOpenProject}
                    onReactivateProject={handleReactivateProject}
                    inboxProcessor={(
                        <InboxProcessor
                            t={t}
                            isInbox={isInbox}
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
                    )}
                    showViewFilterInput={showViewFilterInput}
                    searchQuery={searchQuery}
                    onChangeSearch={setSearchQuery}
                    isWaitingView={isWaitingView}
                    waitingPeople={waitingPeople}
                    selectedWaitingPerson={selectedWaitingPerson}
                    onChangeSelectedWaitingPerson={setSelectedWaitingPerson}
                    onClearSelectedWaitingPerson={() => setSelectedWaitingPerson('')}
                    showFilters={showFilters}
                    showFiltersPanel={showFiltersPanel}
                    onClearFilters={clearFilters}
                    onToggleFiltersOpen={() => setListFilters({ open: !filtersOpen })}
                    allTokens={allTokens}
                    selectedTokens={selectedTokens}
                    tokenCounts={tokenCounts}
                    onToggleToken={toggleTokenFilter}
                    showPriorityFilters={showPriorityFilters}
                    priorityOptions={priorityOptions}
                    selectedPriorities={selectedPriorities}
                    onTogglePriority={togglePriorityFilter}
                    showTimeEstimateFilters={showTimeEstimateFilters}
                    timeEstimateOptions={timeEstimateOptions}
                    selectedTimeEstimates={selectedTimeEstimates}
                    onToggleEstimate={toggleTimeFilter}
                    formatEstimate={formatEstimate}
                    showQuickAdd={showQuickAdd}
                    quickAddValue={newTaskTitle}
                    addInputRef={addInputRef}
                    projects={projects}
                    areas={areas}
                    onCreateProject={async (title) => {
                        const created = await addProject(
                            title,
                            DEFAULT_AREA_COLOR,
                            getQuickAddProjectInitialProps({}, defaultNewTaskAreaId),
                        );
                        return created?.id ?? null;
                    }}
                    onChangeQuickAdd={setNewTaskTitle}
                    onSubmitQuickAdd={handleAddTask}
                    onOpenAudioQuickAdd={() => openQuickAdd(statusFilter, 'audio')}
                    onResetCopilot={resetCopilot}
                    quickAddFooter={(
                        <>
                            {aiEnabled && copilotSuggestion && !copilotApplied && (
                                <button
                                    type="button"
                                    onClick={() => applyCopilotSuggestion(copilotSuggestion)}
                                    className="mt-2 rounded border border-border bg-muted/30 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/60"
                                >
                                    ✨ {t('copilot.suggested')}{' '}
                                    {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                                    {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                                    <span className="ml-2 text-muted-foreground/70">{t('copilot.applyHint')}</span>
                                </button>
                            )}
                            {aiEnabled && copilotApplied && (
                                <div className="mt-2 rounded border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground">
                                    ✅ {t('copilot.applied')}{' '}
                                    {copilotContext ? `${copilotContext} ` : ''}
                                    {copilotTags.length ? copilotTags.join(' ') : ''}
                                </div>
                            )}
                            {!isProcessing && (
                                <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                                    <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="min-w-0 truncate">
                                            {t('quickAdd.inlineHint')}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setQuickAddSyntaxOpen((open) => !open)}
                                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                            aria-label={t('quickAdd.syntaxHelp')}
                                            aria-expanded={quickAddSyntaxOpen}
                                            title={t('quickAdd.help')}
                                        >
                                            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                    </div>
                                    {quickAddSyntaxOpen && (
                                        <p className="rounded border border-border bg-muted/30 px-2 py-1 leading-relaxed text-muted-foreground">
                                            {t('quickAdd.help')}
                                        </p>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                />
            <div
                ref={listScrollRef}
                className="flex-1 min-h-0 overflow-y-auto pt-3"
                role="list"
                aria-label={t('list.tasks') || 'Task list'}
            >
                {isFiltering && (
                    <div className="px-3 pb-2 text-xs text-muted-foreground">
                        {t('list.filtering') || 'Filtering...'}
                    </div>
                )}
                {showEmptyState ? (
                    <ListEmptyState
                        hasFilters={hasFilters}
                        emptyState={emptyState}
                        onAddTask={() => openQuickAdd(statusFilter)}
                        primaryAction={isInbox && !hasFilters
                            ? <MindSweepLauncher t={t} addTask={addTask} variant="primary" />
                            : undefined}
                        t={t}
                    />
                ) : shouldVirtualize ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                        {virtualRows.map((virtualRow) => {
                            const task = filteredTasks[virtualRow.index];
                            if (!task) return null;
                            return (
                                <div
                                    key={virtualRow.key}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={virtualRow.index}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <div className={cn(isCompact ? "pb-1" : "pb-1.5")}>
                                        <StoreTaskItem
                                            taskId={task.id}
                                            isSelected={virtualRow.index === selectedIndex}
                                            index={virtualRow.index}
                                            onSelectIndex={handleSelectIndex}
                                            selectionMode={selectionMode}
                                            isMultiSelected={multiSelectedIds.has(task.id)}
                                            onToggleSelectId={toggleMultiSelect}
                                            showQuickDone={showQuickDone}
                                            readOnly={readOnly}
                                            compactMetaEnabled={showListDetails}
                                            showProjectBadgeInActions={false}
                                        />
                                        <div className="mx-3 mt-1 h-px bg-border/30" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : isListGrouping ? (
                    <div className="space-y-2">
                        {groupedTasks.map((group, groupIndex) => {
                            const collapsed = isReferenceGrouping && collapsedReferenceGroupIds.has(group.id);
                            const controlsId = isReferenceGrouping
                                ? `reference-group-${getListDomIdSegment(activeReferenceGroupBy)}-${groupIndex}-${getListDomIdSegment(group.id)}`
                                : undefined;
                            const groupTitle = (
                                <span className="inline-flex min-w-0 items-center gap-1.5">
                                    {isReferenceGrouping && (
                                        collapsed ? (
                                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        ) : (
                                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        )
                                    )}
                                    {group.dotColor && (
                                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: group.dotColor }} aria-hidden="true" />
                                    )}
                                    <span className="truncate">{group.title}</span>
                                </span>
                            );
                            return (
                                <div key={group.id} className="rounded-md border border-border/40 bg-card/30">
                                    {isReferenceGrouping ? (
                                        <button
                                            type="button"
                                            onClick={() => toggleReferenceGroup(group.id)}
                                            aria-expanded={!collapsed}
                                            aria-controls={controlsId}
                                            className={cn(
                                                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide transition-colors hover:bg-muted/30',
                                                'focus:outline-none focus:ring-2 focus:ring-primary/30',
                                                !collapsed && 'border-b border-border/30',
                                                group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                                            )}
                                        >
                                            {groupTitle}
                                            <span className="shrink-0 text-muted-foreground">{group.tasks.length}</span>
                                        </button>
                                    ) : (
                                        <div className={cn(
                                            'flex items-center justify-between gap-3 border-b border-border/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide',
                                            group.muted ? 'text-muted-foreground' : 'text-foreground/90',
                                        )}>
                                            {groupTitle}
                                            <span className="shrink-0 text-muted-foreground">{group.tasks.length}</span>
                                        </div>
                                    )}
                                    {!collapsed && (
                                        <div id={controlsId} className="divide-y divide-border/30">
                                            {group.tasks.map((task) => {
                                                const index = taskIndexById.get(task.id) ?? 0;
                                                const showReviewControls =
                                                    isAiAgentGrouping &&
                                                    (task.tags ?? []).some(
                                                        (tg) => tg === 'ai-stage:review' || tg === 'ai-stage:error'
                                                    );
                                                return (
                                                    <div key={task.id}>
                                                        <StoreTaskItem
                                                            taskId={task.id}
                                                            isSelected={index === selectedIndex}
                                                            index={index}
                                                            onSelectIndex={handleSelectIndex}
                                                            selectionMode={selectionMode}
                                                            isMultiSelected={multiSelectedIds.has(task.id)}
                                                            onToggleSelectId={toggleMultiSelect}
                                                            showQuickDone={showQuickDone}
                                                            readOnly={readOnly}
                                                            compactMetaEnabled={showListDetails}
                                                            showProjectBadgeInActions={false}
                                                        />
                                                        {isAiAgentGrouping && !showReviewControls ? (
                                                            <RoutingTargetChip task={task} />
                                                        ) : null}
                                                        {showReviewControls ? (
                                                            <AiAgentReviewControls task={task} />
                                                        ) : null}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="divide-y divide-border/30">
                        {filteredTasks.map((task, index) => (
                            <StoreTaskItem
                                key={task.id}
                                taskId={task.id}
                                isSelected={index === selectedIndex}
                                index={index}
                                onSelectIndex={handleSelectIndex}
                                selectionMode={selectionMode}
                                isMultiSelected={multiSelectedIds.has(task.id)}
                                onToggleSelectId={toggleMultiSelect}
                                showQuickDone={showQuickDone}
                                readOnly={readOnly}
                                compactMetaEnabled={showListDetails}
                                showProjectBadgeInActions={false}
                            />
                        ))}
                    </div>
                )}
                {statusFilter === 'inbox' ? <InboxProposalsZone /> : null}
            </div>
        </div>
        <PromptModal
            isOpen={tagPromptOpen}
            title={t('bulk.addTag')}
            description={t('bulk.addTag')}
            placeholder={t('bulk.tagPlaceholder')}
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setTagPromptOpen(false)}
            onConfirm={handleConfirmTagPrompt}
        />
        <PromptModal
            isOpen={contextPromptOpen}
            title={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
            description={contextPromptMode === 'add' ? t('bulk.addContext') : t('bulk.removeContext')}
            placeholder={t('bulk.contextPlaceholder')}
            defaultValue=""
            confirmLabel={t('common.save')}
            cancelLabel={t('common.cancel')}
            onCancel={() => setContextPromptOpen(false)}
            onConfirm={handleConfirmContextPrompt}
        />
        <ConfirmModal
            isOpen={pendingDeleteTask !== null}
            title={t('common.delete') || 'Delete'}
            description={t('task.deleteConfirmBody') || 'Move this task to Trash?'}
            confirmLabel={t('common.delete') || 'Delete'}
            cancelLabel={t('common.cancel')}
            onCancel={() => setPendingDeleteTask(null)}
            onConfirm={confirmSingleDelete}
        />
        <ConfirmModal
            isOpen={pendingBatchDeleteIds.length > 0}
            title={t('common.delete') || 'Delete'}
            description={t('list.confirmBatchDelete') || 'Delete selected tasks?'}
            confirmLabel={t('common.delete') || 'Delete'}
            cancelLabel={t('common.cancel')}
            onCancel={() => setPendingBatchDeleteIds([])}
            onConfirm={confirmBatchDelete}
        />
        <TaskBulkOrganizeModal
            isOpen={bulkOrganizeOpen}
            selectedCount={selectedIdsArray.length}
            projects={projects}
            areas={areas}
            isApplying={isBulkOrganizing}
            t={t}
            titleKey={isInbox ? 'bulk.organizeInbox' : 'bulk.organizeTasks'}
            titleFallback={isInbox ? 'Bulk organize Inbox' : 'Bulk organize tasks'}
            onCancel={() => setBulkOrganizeOpen(false)}
            onApply={handleApplyTaskBulkOrganize}
        />
        </ErrorBoundary>
    );
});
