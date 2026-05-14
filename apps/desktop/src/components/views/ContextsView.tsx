import { useState, useEffect, useMemo, useCallback, useRef, type UIEvent } from 'react';
import {
    useTaskStore,
    matchesHierarchicalToken,
    isTaskInActiveProject,
    shallow,
    TaskStatus,
    TaskEnergyLevel,
    getFrequentTaskTokens,
    getUsedTaskTokens,
    buildBulkTaskTokenUpdates,
    collectBulkTaskTokens,
    tFallback,
} from '@mindwtr/core';
import { AtSign, ChevronDown, ChevronRight, Filter, Hash, Tag, type LucideIcon } from 'lucide-react';
import { TokenPickerModal } from '../TokenPickerModal';
import { ListBulkActions } from './list/ListBulkActions';
import { cn } from '../../lib/utils';
import { useLanguage } from '../../contexts/language-context';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { resolveAreaFilter, taskMatchesAreaFilter } from '../../lib/area-filter';
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

type BulkTokenPickerState = {
    field: 'tags' | 'contexts';
    action: 'add' | 'remove';
} | null;

const CONTEXTS_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:contexts:v1';
const NO_CONTEXT_TOKEN = '__no_context__';
const CONTEXT_STATUS_VALUES: Array<TaskStatus | 'all'> = ['all', 'inbox', 'next', 'waiting', 'someday', 'reference', 'done'];

type ContextsPersistedViewState = {
    selectedContext: string | null;
    statusFilter: TaskStatus | 'all';
};

const DEFAULT_CONTEXTS_VIEW_STATE: ContextsPersistedViewState = {
    selectedContext: null,
    statusFilter: 'all',
};

function sanitizeContextsViewState(value: unknown, fallback: ContextsPersistedViewState): ContextsPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<ContextsPersistedViewState>
        : {};
    const selectedContext = typeof parsed.selectedContext === 'string' && parsed.selectedContext.trim()
        ? parsed.selectedContext
        : null;
    return {
        selectedContext,
        statusFilter: CONTEXT_STATUS_VALUES.includes(parsed.statusFilter as TaskStatus | 'all')
            ? parsed.statusFilter as TaskStatus | 'all'
            : fallback.statusFilter,
    };
}

export function ContextsView() {
    const perf = usePerformanceMonitor('ContextsView');
    const { tasks, tasksById, projects, areas, settings } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            tasksById: state._tasksById,
            projects: state.projects,
            areas: state.areas,
            settings: state.settings,
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
    const statusFilter = persistedViewState.statusFilter;
    const [searchQuery, setSearchQuery] = useState('');
    const [selectionMode, setSelectionMode] = useState(false);
    const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
    const [bulkTokenPicker, setBulkTokenPicker] = useState<BulkTokenPickerState>(null);
    const [isBatchDeleting, setIsBatchDeleting] = useState(false);
    const [contextsCollapsed, setContextsCollapsed] = useState(false);
    const [tagsCollapsed, setTagsCollapsed] = useState(false);
    const listScrollRef = useRef<HTMLDivElement>(null);
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
    const setStatusFilter = useCallback((value: TaskStatus | 'all') => {
        setPersistedViewState((current) => ({
            ...current,
            statusFilter: value,
        }));
    }, [setPersistedViewState]);
    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
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
    const baseTasks = activeTasks.filter(t => t.status !== 'archived');
    const scopedTasks = statusFilter === 'all'
        ? baseTasks
        : baseTasks.filter(t => t.status === statusFilter);

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
        tasks: filteredTasks,
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
    };

    const toggleMultiSelect = (taskId: string) => {
        setMultiSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
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
            const visible = new Set(filteredTasks.map((task) => task.id));
            const next = new Set(Array.from(prev).filter((id) => visible.has(id)));
            if (next.size === prev.size) return prev;
            return next;
        });
    }, [filteredTasks]);

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
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => {
                                            if (selectionMode) exitSelectionMode();
                                            else setSelectionMode(true);
                                        }}
                                        className={cn(
                                            "text-xs px-3 py-1 rounded-md border transition-colors",
                                            selectionMode
                                                ? "bg-primary/10 text-primary border-primary"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground"
                                        )}
                                    >
                                        {selectionMode ? t('bulk.exitSelect') : t('bulk.select')}
                                    </button>
                                </div>
                            </div>
                        </header>
                        <div className="mb-4 flex flex-wrap gap-2">
                            {statusOptions.map((option) => {
                                const isActive = statusFilter === option.value;
                                return (
                                    <button
                                        key={option.value}
                                        onClick={() => setStatusFilter(option.value)}
                                        className={cn(
                                            'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                                            isActive
                                                ? 'border-primary bg-primary/10 text-primary'
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
                            {filteredTasks.length > 0 ? (
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
                                    filteredTasks.map(task => (
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
