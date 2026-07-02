import { useState, useEffect, useMemo, useCallback, useRef, type UIEvent } from 'react';
import {
    useTaskStore,
    matchesHierarchicalToken,
    isTaskInActiveProject,
    shallow,
    sortTasksBy,
    TaskStatus,
    TaskEnergyLevel,
    getFrequentTaskTokens,
    getUsedTaskTokens,
    buildBulkTaskTokenUpdates,
    collectBulkTaskTokens,
    tFallback,
    updateRangeSelection,
} from '@mindwtr/core';
import type { RangeSelectionOptions } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { ArrowUpDown, AtSign, CheckSquare, ChevronDown, ChevronRight, Filter, Hash, Tag, type LucideIcon } from 'lucide-react';
import { TokenPickerModal } from '../TokenPickerModal';
import { BulkSelectionToolbar } from './list/BulkSelectionToolbar';
import { ListBulkActions } from './list/ListBulkActions';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { resolveAreaFilter, taskMatchesAreaFilter } from '@mindwtr/core';
import { reportError } from '../../lib/report-error';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { VirtualTaskRow } from './list/VirtualTaskRow';
import {
    LIST_VIRTUALIZATION_THRESHOLD,
    LIST_VIRTUAL_ROW_ESTIMATE,
    LIST_VIRTUAL_OVERSCAN,
    useVirtualList,
} from './list/useVirtualList';
import { StoreTaskItem } from './list/StoreTaskItem';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';
import {
    CONTEXTS_VIEW_STATE_STORAGE_KEY,
    DEFAULT_CONTEXTS_VIEW_STATE,
    NO_CONTEXT_TOKEN,
    sanitizeContextsViewState,
    subscribeContextsTokenSelection,
} from '../../lib/contexts-view-state';

type BulkTokenPickerState = {
    field: 'tags' | 'contexts';
    action: 'add' | 'remove';
} | null;

export function ContextsView() {
    const perf = usePerformanceMonitor('ContextsView');
    const { tasks, tasksById, projects, areas, areaFilterId, taskSortBy, updateSettings } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            tasksById: state._tasksById,
            projects: state.projects,
            areas: state.areas,
            areaFilterId: state.settings?.filters?.areaId,
            taskSortBy: state.settings?.taskSortBy,
            updateSettings: state.updateSettings,
        }),
        shallow
    );
    const batchMoveTasks = useTaskStore((state) => state.batchMoveTasks);
    const batchDeleteTasks = useTaskStore((state) => state.batchDeleteTasks);
    const batchUpdateTasks = useTaskStore((state) => state.batchUpdateTasks);
    const { t } = useLanguage();
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        CONTEXTS_VIEW_STATE_STORAGE_KEY,
        DEFAULT_CONTEXTS_VIEW_STATE,
        sanitizeContextsViewState
    );
    const selectedContext = persistedViewState.selectedContext;
    const statusFilters = persistedViewState.statusFilters;
    const selectedStatusSet = useMemo(() => new Set(statusFilters), [statusFilters]);
    const sortBy = (taskSortBy ?? 'default') as TaskSortBy;
    const [searchQuery, setSearchQuery] = useState('');
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const [contextsCollapsed, setContextsCollapsed] = useState(false);
    const [tagsCollapsed, setTagsCollapsed] = useState(false);
    const listScrollRef = useRef<HTMLDivElement>(null);
    const multiSelectAnchorIdRef = useRef<string | null>(null);
    const rowHeightsRef = useRef<Map<string, number>>(new Map());
    const [measureVersion, setMeasureVersion] = useState(0);
    const [listScrollTop, setListScrollTop] = useState(0);
    const [listHeight, setListHeight] = useState(0);
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const setSelectedContext = useCallback((value: string | null) => {
        setPersistedViewState((current) => ({
            ...current,
            selectedContext: value,
        }));
    }, [setPersistedViewState]);
    const setStatusFilters = useCallback((updater: (current: TaskStatus[]) => TaskStatus[]) => {
        setPersistedViewState((current) => ({
            ...current,
            statusFilters: updater(current.statusFilters),
        }));
    }, [setPersistedViewState]);
    const clearStatusFilters = useCallback(() => {
        setStatusFilters(() => []);
    }, [setStatusFilters]);
    const toggleStatusFilter = useCallback((value: TaskStatus) => {
        setStatusFilters((current) => (
            current.includes(value)
                ? current.filter((status) => status !== value)
                : [...current, value]
        ));
    }, [setStatusFilters]);
    useEffect(() => subscribeContextsTokenSelection(({ selectedContext: nextSelectedContext }) => {
        setSelectedContext(nextSelectedContext);
        setSearchQuery('');
    }), [setSelectedContext]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(areaFilterId, areas),
        [areaFilterId, areas],
    );

    useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('ContextsView', perf.metrics, 'simple');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    useEffect(() => {
        const element = listScrollRef.current;
        if (!element) return;
        const updateHeight = () => {
            const nextHeight = element.clientHeight;
            setListHeight((current) => (current === nextHeight ? current : nextHeight));
        };
        updateHeight();
        window.addEventListener('resize', updateHeight);
        const resizeObserver = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => updateHeight())
            : null;
        resizeObserver?.observe(element);
        return () => {
            window.removeEventListener('resize', updateHeight);
            resizeObserver?.disconnect();
        };
    }, []);

    // Filter out deleted tasks first
    const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const activeTasks = tasks.filter(t =>
        !t.deletedAt
        && isTaskInActiveProject(t, projectMap)
        && taskMatchesAreaFilter(t, resolvedAreaFilter, projectMap, areaById)
    );
    const hasExplicitStatusFilter = statusFilters.length > 0;
    const baseTasks = activeTasks.filter(t =>
        t.status !== 'archived'
        && (selectedStatusSet.has('done') || t.status !== 'done')
    );
    const scopedTasks = hasExplicitStatusFilter
        ? baseTasks.filter(t => selectedStatusSet.has(t.status))
        : baseTasks;

    // Extract unique context and tag tokens separately for the selector sidebar.
    const allContextTokens = Array.from(new Set(scopedTasks.flatMap(t => t.contexts || []))).sort();
    const allTagTokens = Array.from(new Set(scopedTasks.flatMap(t => t.tags || []))).sort();
    const allTokens = [...allContextTokens, ...allTagTokens];

    useEffect(() => {
        // Keep persisted context selections through the empty startup frame; reset only after active tasks expose tokens.
        if (allTokens.length === 0) return;
        if (!selectedContext || selectedContext === NO_CONTEXT_TOKEN || allTokens.includes(selectedContext)) return;
        setSelectedContext(null);
    }, [allTokens, selectedContext, setSelectedContext]);

    const matchesSelected = (task: typeof activeTasks[number], context: string) => {
        const tokens = [...(task.contexts || []), ...(task.tags || [])];
        return tokens.some(token => matchesHierarchicalToken(context, token));
    };

    const hasContext = (task: typeof activeTasks[number]) =>
        (task.contexts?.length || 0) > 0 || (task.tags?.length || 0) > 0;

    const contextFilteredTasks = selectedContext === NO_CONTEXT_TOKEN
        ? scopedTasks.filter((t) => !hasContext(t))
        : selectedContext
            ? scopedTasks.filter(t => matchesSelected(t, selectedContext))
            : scopedTasks.filter((t) => hasContext(t));
    const normalizedSearchQuery = searchQuery.trim().toLowerCase();
    const filteredTasks = normalizedSearchQuery
        ? contextFilteredTasks.filter((task) => task.title.toLowerCase().includes(normalizedSearchQuery))
        : contextFilteredTasks;
    const sortedTasks = sortTasksBy(filteredTasks, sortBy);
    const filteredTaskIds = sortedTasks.map((task) => task.id);
    const selectedVisibleCount = filteredTaskIds.filter((id) => multiSelectedIds.has(id)).length;
    const allVisibleTasksSelected = filteredTaskIds.length > 0 && selectedVisibleCount === filteredTaskIds.length;
    const shouldVirtualize = filteredTasks.length > LIST_VIRTUALIZATION_THRESHOLD;
    const handleVirtualRowMeasure = useCallback((id: string, height: number) => {
        if (rowHeightsRef.current.get(id) === height) return;
        rowHeightsRef.current.set(id, height);
        setMeasureVersion((current) => current + 1);
    }, []);
    const handleVirtualScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
        setListScrollTop(event.currentTarget.scrollTop);
    }, []);
    const { rowOffsets, totalHeight, startIndex, visibleTasks } = useVirtualList({
        tasks: sortedTasks,
        shouldVirtualize,
        rowHeightsRef,
        measureVersion,
        listScrollTop,
        listHeight,
        rowEstimate: LIST_VIRTUAL_ROW_ESTIMATE,
        overscan: LIST_VIRTUAL_OVERSCAN,
    });
    const addTagOptions = useMemo(
        () => Array.from(new Set([
            ...getFrequentTaskTokens(activeTasks, (task) => task.tags, 12, { prefix: '#' }),
            ...getUsedTaskTokens(activeTasks, (task) => task.tags, { prefix: '#' }),
        ])),
        [activeTasks]
    );
    const addContextOptions = useMemo(
        () => Array.from(new Set([
            ...getFrequentTaskTokens(activeTasks, (task) => task.contexts, 12, { prefix: '@' }),
            ...getUsedTaskTokens(activeTasks, (task) => task.contexts, { prefix: '@' }),
        ])),
        [activeTasks]
    );

    const exitSelectionMode = () => {
        setSelectionMode(false);
        setMultiSelectedIds(new Set());
        multiSelectAnchorIdRef.current = null;
    };

    const toggleMultiSelect = (taskId: string, options: RangeSelectionOptions = {}) => {
        setMultiSelectedIds((prev) => {
            const result = updateRangeSelection({
                anchorId: multiSelectAnchorIdRef.current,
                range: options.range,
                selectedIds: prev,
                targetId: taskId,
                visibleIds: filteredTaskIds,
            });
            multiSelectAnchorIdRef.current = result.anchorId;
            return result.selectedIds;
        });
    };

    const selectAllVisibleTasks = () => {
        multiSelectAnchorIdRef.current = filteredTaskIds[0] ?? null;
        setMultiSelectedIds(new Set(filteredTaskIds));
    };

    const clearTaskSelection = () => {
        multiSelectAnchorIdRef.current = null;
        setMultiSelectedIds(new Set());
    };

    const selectedIdsArray = useMemo(() => Array.from(multiSelectedIds), [multiSelectedIds]);
    const removableTagOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'tags'),
        [selectedIdsArray, tasksById]
    );
    const removableContextOptions = useMemo(
        () => collectBulkTaskTokens(selectedIdsArray, tasksById, 'contexts'),
        [selectedIdsArray, tasksById]
    );
    const bulkAreaOptions = useMemo(
        () => [...areas]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((area) => ({ id: area.id, name: area.name })),
        [areas]
    );

    const handleBatchMove = async (newStatus: TaskStatus) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchMoveTasks(selectedIdsArray, newStatus);
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch move tasks in contexts view', error);
        }
    };

    const handleBatchDelete = async () => {
        if (selectedIdsArray.length === 0) return;
        const confirmed = await requestConfirmation({
            title: t('common.delete') || 'Delete',
            description: t('list.confirmBatchDelete') || 'Delete selected tasks?',
            confirmLabel: t('common.delete') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (!confirmed) return;
        setIsBatchDeleting(true);
        try {
            await batchDeleteTasks(selectedIdsArray);
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch delete tasks in contexts view', error);
        } finally {
            setIsBatchDeleting(false);
        }
    };

    const handleBatchRemoveTag = () => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'tags', action: 'remove' });
    };

    const handleBatchPickTag = () => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'tags', action: 'add' });
    };

    const handleBatchPickContext = (action: 'add' | 'remove') => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'contexts', action });
    };

    const handleBatchRemoveContext = () => {
        if (selectedIdsArray.length === 0) return;
        setBulkTokenPicker({ field: 'contexts', action: 'remove' });
    };

    const handleBatchAssignArea = async (areaId: string | null) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchUpdateTasks(selectedIdsArray.map((id) => ({
                id,
                updates: { areaId: areaId ?? undefined },
            })));
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch assign area in contexts view', error);
        }
    };

    const handleBatchAssignEnergyLevel = async (energyLevel: TaskEnergyLevel) => {
        if (selectedIdsArray.length === 0) return;
        try {
            await batchUpdateTasks(selectedIdsArray.map((id) => ({
                id,
                updates: { energyLevel },
            })));
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch assign energy level in contexts view', error);
        }
    };

    useEffect(() => {
        setMultiSelectedIds((prev) => {
            const visible = new Set(sortedTasks.map((task) => task.id));
            const next = new Set(Array.from(prev).filter((id) => visible.has(id)));
            if (next.size === prev.size) return prev;
            return next;
        });
        const visible = new Set(sortedTasks.map((task) => task.id));
        if (multiSelectAnchorIdRef.current && !visible.has(multiSelectAnchorIdRef.current)) {
            multiSelectAnchorIdRef.current = null;
        }
    }, [sortedTasks]);

    const removeTagLabelRaw = t('bulk.removeTag');
    const removeTagLabel = removeTagLabelRaw === 'bulk.removeTag' ? 'Remove tag' : removeTagLabelRaw;
    const tokenPickerTitle = (() => {
        if (!bulkTokenPicker) return '';
        if (bulkTokenPicker.field === 'tags') {
            return bulkTokenPicker.action === 'add' ? t('bulk.addTag') : removeTagLabel;
        }
        return bulkTokenPicker.action === 'add' ? t('bulk.addContext') : t('bulk.removeContext');
    })();
    const tokenPickerOptions = (() => {
        if (!bulkTokenPicker) return [] as string[];
        if (bulkTokenPicker.field === 'tags') {
            return bulkTokenPicker.action === 'add' ? addTagOptions : removableTagOptions;
        }
        return bulkTokenPicker.action === 'add' ? addContextOptions : removableContextOptions;
    })();
    const tokenPickerPlaceholder = bulkTokenPicker?.field === 'tags' ? '#tag' : '@context';

    const statusOptions: Array<{ value: TaskStatus | 'all'; label: string }> = [
        { value: 'all', label: t('common.all') || 'All' },
        { value: 'inbox', label: t('status.inbox') },
        { value: 'next', label: t('status.next') },
        { value: 'waiting', label: t('status.waiting') },
        { value: 'someday', label: t('status.someday') },
        { value: 'reference', label: t('status.reference') },
        { value: 'done', label: t('status.done') },
    ];
    const contextsLabel = tFallback(t, 'taskEdit.contextsLabel', 'Contexts');
    const tagsLabel = tFallback(t, 'taskEdit.tagsLabel', 'Tags');
    const allTokensLabel = `${contextsLabel} & ${tagsLabel}`;
    const sortLabel = tFallback(t, 'sort.label', 'Sort');

    const renderTokenRow = (token: string, marker: '@' | '#') => {
        const taskCount = scopedTasks.filter(t => matchesSelected(t, token)).length;
        return (
            <button
                key={token}
                type="button"
                onClick={() => setSelectedContext(token)}
                aria-label={`${token} (${taskCount})`}
                className={cn(
                    "flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition-colors",
                    selectedContext === token ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                )}
            >
                <span className="w-4 text-center text-muted-foreground">{marker}</span>
                <span className="flex-1 truncate">{token.replace(marker === '@' ? /^@/ : /^#/, '')}</span>
                <span className="text-xs text-muted-foreground">
                    {taskCount}
                </span>
            </button>
        );
    };

    const renderTokenSection = ({
        label,
        tokens,
        marker,
        icon: Icon,
        collapsed,
        onToggle,
    }: {
        label: string;
        tokens: string[];
        marker: '@' | '#';
        icon: LucideIcon;
        collapsed: boolean;
        onToggle: () => void;
    }) => {
        const ToggleIcon = collapsed ? ChevronRight : ChevronDown;
        return (
            <div className="mt-3 border-t border-border/60 pt-3">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={!collapsed}
                    aria-label={`${label} (${tokens.length})`}
                    className="flex w-full items-center gap-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                >
                    <ToggleIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="flex-1 text-left">{label}</span>
                    <span>{tokens.length}</span>
                </button>
                {!collapsed && (
                    <div className="mt-1 space-y-1">
                        {tokens.map((token) => renderTokenRow(token, marker))}
                    </div>
                )}
            </div>
        );
    };

    const handleBulkTokenConfirm = async (value: string) => {
        if (!bulkTokenPicker || selectedIdsArray.length === 0) return;
        try {
            const updates = buildBulkTaskTokenUpdates(
                selectedIdsArray,
                tasksById,
                bulkTokenPicker.field,
                value,
                bulkTokenPicker.action
            );
            if (updates.length === 0) {
                setBulkTokenPicker(null);
                return;
            }
            await batchUpdateTasks(updates);
            setBulkTokenPicker(null);
            exitSelectionMode();
        } catch (error) {
            reportError('Failed to batch update tokens in contexts view', error);
        }
    };

    return (
        <>
            <div className="h-full px-4 py-3">
                <div className="mx-auto flex h-full w-full max-w-[84rem] min-w-0 gap-5 xl:gap-6 2xl:max-w-[88rem]">
                    {/* Sidebar List of Contexts */}
                    <div className="min-w-[13.5rem] w-[clamp(13.5rem,16vw,15.5rem)] flex-shrink-0 flex flex-col gap-4 border-r border-border pr-5 xl:pr-6">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-bold tracking-tight">{t('contexts.title')}</h2>
                            <Filter className="w-5 h-5 text-muted-foreground" />
                        </div>

                        <div className="space-y-1 overflow-y-auto flex-1">
                            <button
                                type="button"
                                onClick={() => setSelectedContext(null)}
                                aria-label={`${allTokensLabel} (${scopedTasks.filter((t) => hasContext(t)).length})`}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition-colors",
                                    selectedContext === null ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                                )}
                            >
                                <Tag className="w-4 h-4" />
                                <span className="flex-1">{allTokensLabel}</span>
                                <span className="text-xs text-muted-foreground">
                                    {scopedTasks.filter((t) => hasContext(t)).length}
                                </span>
                            </button>

                            <button
                                type="button"
                                onClick={() => setSelectedContext(NO_CONTEXT_TOKEN)}
                                aria-label={`${t('contexts.none')} (${scopedTasks.filter((t) => !hasContext(t)).length})`}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-lg p-2 text-left text-sm transition-colors",
                                    selectedContext === NO_CONTEXT_TOKEN ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted/40 text-foreground"
                                )}
                            >
                                <Tag className="w-4 h-4" />
                                <span className="flex-1">{t('contexts.none')}</span>
                                <span className="text-xs text-muted-foreground">
                                    {scopedTasks.filter((t) => !hasContext(t)).length}
                                </span>
                            </button>

                            {allTokens.length === 0 ? (
                                <div className="text-sm text-muted-foreground text-center py-8">
                                    {t('contexts.noContexts')}
                                </div>
                            ) : (
                                <>
                                    {renderTokenSection({
                                        label: contextsLabel,
                                        tokens: allContextTokens,
                                        marker: '@',
                                        icon: AtSign,
                                        collapsed: contextsCollapsed,
                                        onToggle: () => setContextsCollapsed((value) => !value),
                                    })}
                                    {renderTokenSection({
                                        label: tagsLabel,
                                        tokens: allTagTokens,
                                        marker: '#',
                                        icon: Hash,
                                        collapsed: tagsCollapsed,
                                        onToggle: () => setTagsCollapsed((value) => !value),
                                    })}
                                </>
                            )}
                        </div>
                    </div>

                    {/* Context Tasks */}
                    <div className="min-w-0 flex-1 flex flex-col h-full overflow-hidden">
                        <header className="flex items-center gap-3 mb-6">
                            <div className="p-2 bg-primary/10 rounded-lg">
                                <Tag className="w-6 h-6 text-primary" />
                            </div>
                            <div>
                                <h2 className="text-2xl font-bold">
                                    {selectedContext === NO_CONTEXT_TOKEN ? t('contexts.none') : (selectedContext ?? allTokensLabel)}
                                </h2>
                                <p className="text-muted-foreground text-sm">
                                    {filteredTasks.length} {t('common.tasks')}
                                </p>
                            </div>
                            <div className="ml-auto">
                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        onClick={() => {
                                            if (selectionMode) exitSelectionMode();
                                            else setSelectionMode(true);
                                        }}
                                        className={cn(
                                            "inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40",
                                            selectionMode
                                                ? "bg-primary/10 text-primary border-primary"
                                                : "bg-card text-muted-foreground border-border hover:bg-muted/70 hover:text-foreground"
                                        )}
                                    >
                                        <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
                                        {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                                    </button>
                                    <div className="relative flex h-9 min-w-[160px] items-center rounded-lg border border-border bg-card pl-2 text-xs transition-colors hover:bg-muted/70 focus-within:ring-2 focus-within:ring-primary/40">
                                        <ArrowUpDown
                                            className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                            aria-hidden="true"
                                            data-testid="contexts-sort-icon"
                                        />
                                        <span className="mr-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                            {sortLabel}
                                        </span>
                                        <select
                                            value={sortBy}
                                            onChange={(event) => updateSettings({ taskSortBy: event.target.value as TaskSortBy })}
                                            aria-label={sortLabel}
                                            className="h-full min-w-0 flex-1 appearance-none bg-transparent pr-8 text-xs text-foreground focus:outline-none"
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
                                </div>
                            </div>
                        </header>
                        <div className="mb-4 flex flex-wrap gap-2">
                            {statusOptions.map((option) => {
                                const isActive = option.value === 'all'
                                    ? statusFilters.length === 0
                                    : selectedStatusSet.has(option.value);
                                return (
                                    <button
                                        key={option.value}
                                        onClick={() => {
                                            if (option.value === 'all') {
                                                clearStatusFilters();
                                                return;
                                            }
                                            toggleStatusFilter(option.value);
                                        }}
                                        className={cn(
                                            'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
                                                ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                                : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                                        )}
                                        aria-pressed={isActive}
                                    >
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                        <div className="mb-4">
                            <input
                                type="text"
                                data-view-filter-input
                                placeholder={t('common.search')}
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                                className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                            />
                        </div>

                        {selectionMode && (
                            <div className="mb-4">
                                <BulkSelectionToolbar
                                    selectionCount={selectedIdsArray.length}
                                    totalCount={filteredTasks.length}
                                    allSelected={allVisibleTasksSelected}
                                    onSelectAll={selectAllVisibleTasks}
                                    onClearSelection={clearTaskSelection}
                                    t={t}
                                />
                            </div>
                        )}

                        {selectionMode && selectedIdsArray.length > 0 && (
                            <div className="mb-4">
                                <ListBulkActions
                                    selectionCount={selectedIdsArray.length}
                                    onMoveToStatus={handleBatchMove}
                                    onAssignArea={handleBatchAssignArea}
                                    areaOptions={bulkAreaOptions}
                                    onAssignEnergyLevel={handleBatchAssignEnergyLevel}
                                    onAddTag={handleBatchPickTag}
                                    onRemoveTag={handleBatchRemoveTag}
                                    disableRemoveTag={removableTagOptions.length === 0}
                                    onAddContext={() => handleBatchPickContext('add')}
                                    onRemoveContext={handleBatchRemoveContext}
                                    disableRemoveContext={removableContextOptions.length === 0}
                                    onDelete={handleBatchDelete}
                                    isDeleting={isBatchDeleting}
                                    t={t}
                                />
                            </div>
                        )}

                        <div
                            ref={listScrollRef}
                            onScroll={handleVirtualScroll}
                            className={cn(
                                "flex-1 min-h-0 overflow-y-auto pr-2",
                                !shouldVirtualize && "divide-y divide-border/30",
                            )}
                        >
                            {sortedTasks.length > 0 ? (
                                shouldVirtualize ? (
                                    <div style={{ height: totalHeight, position: 'relative' }}>
                                        {visibleTasks.map((task, visibleIndex) => {
                                            const taskIndex = startIndex + visibleIndex;
                                            return (
                                                <VirtualTaskRow
                                                    key={task.id}
                                                    taskId={task.id}
                                                    index={taskIndex}
                                                    top={rowOffsets[taskIndex] ?? 0}
                                                    selectionMode={selectionMode}
                                                    isMultiSelected={multiSelectedIds.has(task.id)}
                                                    onToggleSelectId={toggleMultiSelect}
                                                    onMeasure={handleVirtualRowMeasure}
                                                    showProjectBadgeInActions={false}
                                                />
                                            );
                                        })}
                                    </div>
                                ) : (
                                    sortedTasks.map(task => (
                                        <StoreTaskItem
                                            key={task.id}
                                            taskId={task.id}
                                            selectionMode={selectionMode}
                                            isMultiSelected={multiSelectedIds.has(task.id)}
                                            onToggleSelectId={toggleMultiSelect}
                                            showProjectBadgeInActions={false}
                                        />
                                    ))
                                )
                            ) : (
                                <div className="text-center text-muted-foreground py-12">
                                    {normalizedSearchQuery ? t('filters.noMatch') : t('contexts.noTasks')}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
            <TokenPickerModal
                isOpen={bulkTokenPicker !== null}
                title={tokenPickerTitle}
                description={tokenPickerTitle}
                tokens={tokenPickerOptions}
                placeholder={tokenPickerPlaceholder}
                allowCustomValue={bulkTokenPicker?.action === 'add'}
                confirmLabel={t('common.save')}
                cancelLabel={t('common.cancel')}
                onCancel={() => setBulkTokenPicker(null)}
                onConfirm={handleBulkTokenConfirm}
            />
            {confirmModal}
        </>
    );
}
