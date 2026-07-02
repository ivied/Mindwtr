import React from 'react';
import {
    DndContext,
    DragOverlay,
    useDroppable,
    DragEndEvent,
    DragStartEvent,
    closestCorners,
    closestCenter,
    pointerWithin,
    rectIntersection,
    getFirstCollision,
    PointerSensor,
    useSensor,
    useSensors,
    type CollisionDetection,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TaskItem } from '../TaskItem';
import { ErrorBoundary } from '../ErrorBoundary';
import { shallow, useTaskStore, sortTasksBy, sortTasksByBoardOrder, safeParseDate, translateWithFallback, isTaskInActiveProject, createTaskFilterPredicate, hasActiveFilterCriteria, getUsedTaskTokens, SAVED_FILTER_NO_PROJECT_ID } from '@mindwtr/core';
import { resolveBoardDragEnd } from './board-view-dnd';
import type { Task, TaskStatus, FilterCriteria } from '@mindwtr/core';
import type { TaskSortBy } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { Filter, GripVertical } from 'lucide-react';
import { useUiStore } from '../../store/ui-store';
import { usePerformanceMonitor } from '../../hooks/usePerformanceMonitor';
import { checkBudget } from '../../config/performanceBudgets';
import { projectMatchesAreaFilter, resolveAreaFilter, taskMatchesAreaFilter } from '@mindwtr/core';
import { usePersistedViewState } from '../../hooks/usePersistedViewState';

const BOARD_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:board:v1';

type BoardPersistedViewState = {
    filtersOpen: boolean;
};

const DEFAULT_BOARD_VIEW_STATE: BoardPersistedViewState = {
    filtersOpen: false,
};

function sanitizeBoardViewState(value: unknown, fallback: BoardPersistedViewState): BoardPersistedViewState {
    const parsed = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Partial<BoardPersistedViewState>
        : {};
    return {
        filtersOpen: typeof parsed.filtersOpen === 'boolean' ? parsed.filtersOpen : fallback.filtersOpen,
    };
}

const getColumns = (t: (key: string) => string): { id: TaskStatus; label: string }[] => [
    { id: 'inbox', label: t('list.inbox') || 'Inbox' },
    { id: 'next', label: t('list.next') },
    { id: 'waiting', label: t('list.waiting') },
    { id: 'someday', label: t('list.someday') },
    { id: 'done', label: t('list.done') },
];

const DUE_DATE_PRESETS = ['today', 'this_week', 'this_month', 'overdue', 'no_date'] as const;
type DueDatePreset = (typeof DUE_DATE_PRESETS)[number];

const STATUS_BORDER: Record<TaskStatus, string> = {
    inbox: 'border-t-[hsl(var(--status-inbox))]',
    next: 'border-t-[hsl(var(--status-next))]',
    waiting: 'border-t-[hsl(var(--status-waiting))]',
    someday: 'border-t-[hsl(var(--status-someday))]',
    reference: 'border-t-[hsl(var(--status-reference))]',
    done: 'border-t-[hsl(var(--status-done))]',
    archived: 'border-t-[hsl(var(--status-archived))]',
};

function DroppableColumn({
    id,
    label,
    tasks,
    emptyState,
    onQuickAdd,
    dragLabel,
    compact,
}: {
    id: TaskStatus;
    label: string;
    tasks: Task[];
    emptyState: { title: string; body: string; action: string };
    onQuickAdd: (status: TaskStatus) => void;
    dragLabel: string;
    compact?: boolean;
}) {
    const { setNodeRef } = useDroppable({ id });
    const columnPadding = compact ? 'p-2' : 'p-3';
    const headerMargin = compact ? 'mb-3' : 'mb-4';
    const listSpacing = compact ? 'space-y-2' : 'space-y-3';
    const columnMinWidth = compact ? 'min-w-[36ch]' : 'min-w-[40ch]';

    return (
        <div
            ref={setNodeRef}
            className={`flex flex-col h-full ${columnMinWidth} flex-1 bg-muted/20 rounded-xl border border-border/30 border-t-[3px] ${columnPadding} ${STATUS_BORDER[id]}`}
        >
            <h3 className={`font-semibold ${headerMargin} flex items-center justify-between text-sm`}>
                {label}
                <span className="text-[11px] font-medium bg-muted/60 px-2 py-0.5 rounded-full text-muted-foreground">{tasks.length}</span>
            </h3>
            <div
                className={`flex-1 ${listSpacing} overflow-y-auto min-h-[100px] focus:outline-none focus:ring-2 focus:ring-primary/50 rounded-md px-1`}
                tabIndex={0}
                role="list"
                aria-label={`${label} tasks list`}
            >
                {tasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center text-center text-xs text-muted-foreground py-6 px-2 gap-2">
                        <div className="text-sm font-medium text-foreground">{emptyState.title}</div>
                        <div>{emptyState.body}</div>
                        <button
                            type="button"
                            onClick={() => onQuickAdd(id)}
                            className="mt-1 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            {emptyState.action}
                        </button>
                    </div>
                ) : (
                    <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                        {tasks.map((task) => (
                            <DraggableTask key={task.id} task={task} dragLabel={dragLabel} />
                        ))}
                    </SortableContext>
                )}
            </div>
        </div>
    );
}

function DraggableTask({ task, dragLabel }: { task: Task; dragLabel: string }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: task.id,
        data: { task },
    });

    const style = transform || transition ? {
        transform: CSS.Transform.toString(transform),
        transition,
    } : undefined;

    if (isDragging) {
        return (
            <div ref={setNodeRef} style={style} className="opacity-50" role="listitem">
                <TaskItem
                    task={task}
                    readOnly={task.status === 'done'}
                    showStatusSelect={false}
                    showProjectBadgeInActions={false}
                    actionsOverlay
                    showHoverHint={false}
                    enableDoubleClickEdit
                    editorPresentation="modal"
                />
            </div>
        );
    }

    return (
        <div ref={setNodeRef} style={style} className="touch-none" role="listitem">
            <TaskItem
                task={task}
                readOnly={task.status === 'done'}
                showStatusSelect={false}
                showProjectBadgeInActions={false}
                actionsOverlay
                showHoverHint={false}
                dragHandle={(
                    <button
                        type="button"
                        {...listeners}
                        {...attributes}
                        onClick={(event) => event.stopPropagation()}
                        className="text-muted-foreground/70 hover:text-foreground p-1 rounded hover:bg-muted/50 cursor-grab active:cursor-grabbing"
                        aria-label={dragLabel}
                        title={dragLabel}
                    >
                        <GripVertical className="w-4 h-4" />
                    </button>
                )}
                enableDoubleClickEdit
                editorPresentation="modal"
            />
        </div>
    );
}

export function BoardView() {
    const perf = usePerformanceMonitor('BoardView');
    const { tasks, moveTask, reorderBoardTasks, settings, projects, areas } = useTaskStore(
        (state) => ({
            tasks: state.tasks,
            moveTask: state.moveTask,
            reorderBoardTasks: state.reorderBoardTasks,
            settings: state.settings,
            projects: state.projects,
            areas: state.areas,
        }),
        shallow
    );
    const { t } = useLanguage();
    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const isCompact = settings?.appearance?.density === 'compact';

    const [activeTask, setActiveTask] = React.useState<Task | null>(null);
    const [computeSequential, setComputeSequential] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const boardFilters = useUiStore((state) => state.boardFilters);
    const setBoardFilters = useUiStore((state) => state.setBoardFilters);
    const [persistedViewState, setPersistedViewState] = usePersistedViewState(
        BOARD_VIEW_STATE_STORAGE_KEY,
        DEFAULT_BOARD_VIEW_STATE,
        sanitizeBoardViewState
    );
    const criteria = boardFilters.criteria;
    const COLUMNS = getColumns(t);
    const hasFilters = hasActiveFilterCriteria(criteria);
    const hasSearch = searchQuery.trim().length > 0;
    const hasBoardFilters = hasFilters || hasSearch;
    const showFiltersPanel = persistedViewState.filtersOpen;
    const selectedContexts = criteria.contexts ?? [];
    const selectedTags = criteria.tags ?? [];
    const selectedProjectIds = criteria.projects ?? [];
    const selectedDuePreset = criteria.dueDateRange && 'preset' in criteria.dueDateRange
        ? criteria.dueDateRange.preset
        : undefined;
    const areaById = React.useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectMap = React.useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
    const resolvedAreaFilter = React.useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );
    const sortedProjects = React.useMemo(
        () =>
            projects
                .filter((project) => !project.deletedAt)
                .filter((project) => projectMatchesAreaFilter(project, resolvedAreaFilter, areaById))
                .sort((a, b) => a.title.localeCompare(b.title)),
        [projects, resolvedAreaFilter, areaById]
    );
    const projectOrderMap = React.useMemo(() => {
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
    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 6,
            },
        })
    );

    React.useEffect(() => {
        if (!perf.enabled) return;
        const timer = window.setTimeout(() => {
            checkBudget('BoardView', perf.metrics, 'complex');
        }, 0);
        return () => window.clearTimeout(timer);
    }, [perf.enabled]);

    React.useEffect(() => {
        const timer = window.setTimeout(() => setComputeSequential(true), 0);
        return () => window.clearTimeout(timer);
    }, []);
    const updateCriteria = (next: FilterCriteria) => {
        setBoardFilters({ criteria: next });
    };
    const toggleStringValue = (key: 'contexts' | 'tags' | 'projects', value: string) => {
        const current = criteria[key] ?? [];
        const next = current.includes(value)
            ? current.filter((item) => item !== value)
            : [...current, value];
        updateCriteria({ ...criteria, [key]: next.length > 0 ? next : undefined });
    };
    const toggleToken = (token: string) => {
        toggleStringValue(token.trim().startsWith('#') ? 'tags' : 'contexts', token);
    };
    const toggleProjectFilter = (projectId: string) => {
        toggleStringValue('projects', projectId);
    };
    const toggleDuePreset = (preset: DueDatePreset) => {
        updateCriteria({
            ...criteria,
            dueDateRange: selectedDuePreset === preset ? undefined : { preset },
        });
    };
    const clearFilters = () => {
        updateCriteria({});
        setSearchQuery('');
    };

    const handleDragStart = (event: DragStartEvent) => {
        setActiveTask(event.active.data.current?.task || null);
    };

    // Sort tasks for consistency, filter out deleted
    const sortedTasks = React.useMemo(
        () => sortTasksBy(tasks.filter(t => !t.deletedAt), sortBy),
        [tasks, sortBy],
    );
    const areaFilteredTasks = React.useMemo(
        () => sortedTasks.filter((task) =>
            isTaskInActiveProject(task, projectMap) &&
            taskMatchesAreaFilter(task, resolvedAreaFilter, projectMap, areaById)
        ),
        [sortedTasks, projectMap, resolvedAreaFilter, areaById]
    );
    const allTokens = React.useMemo(
        () => getUsedTaskTokens(areaFilteredTasks, (task) => [...(task.contexts || []), ...(task.tags || [])]),
        [areaFilteredTasks]
    );
    const criteriaFilteredTasks = React.useMemo(() => {
        const now = new Date();
        return hasFilters
            ? areaFilteredTasks.filter(createTaskFilterPredicate(criteria, { projects, now }))
            : areaFilteredTasks;
    }, [areaFilteredTasks, criteria, hasFilters, projects]);
    const normalizedSearchQuery = React.useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
    const filteredTasks = React.useMemo(() => {
        if (!normalizedSearchQuery) return criteriaFilteredTasks;
        return criteriaFilteredTasks.filter((task) => task.title.toLowerCase().includes(normalizedSearchQuery));
    }, [criteriaFilteredTasks, normalizedSearchQuery]);

    const sequentialProjectIds = React.useMemo(() => {
        return new Set(projects.filter((p) => p.isSequential && !p.deletedAt).map((p) => p.id));
    }, [projects]);

    const sequentialProjectFirstTasks = React.useMemo(() => {
        perf.trackUseMemo();
        return perf.measure('sequentialProjectFirstTasks', () => {
            if (!computeSequential) return new Set<string>();
            if (sequentialProjectIds.size === 0) return new Set<string>();
            const tasksByProject = new Map<string, Task[]>();
            for (const task of filteredTasks) {
                if (task.deletedAt || task.status !== 'next' || !task.projectId) continue;
                if (!sequentialProjectIds.has(task.projectId)) continue;
                const list = tasksByProject.get(task.projectId) ?? [];
                list.push(task);
                tasksByProject.set(task.projectId, list);
            }

            const firstTaskIds: string[] = [];
            tasksByProject.forEach((tasksForProject) => {
                const hasOrder = tasksForProject.some((task) =>
                    Number.isFinite(task.order) || Number.isFinite(task.orderNum)
                );
                let firstTaskId: string | null = null;
                let bestKey = Number.POSITIVE_INFINITY;
                tasksForProject.forEach((task) => {
                    const taskOrder = Number.isFinite(task.order)
                        ? (task.order as number)
                        : Number.isFinite(task.orderNum)
                            ? (task.orderNum as number)
                            : Number.POSITIVE_INFINITY;
                    const key = hasOrder
                        ? taskOrder
                        : new Date(task.createdAt).getTime();
                    if (!firstTaskId || key < bestKey) {
                        firstTaskId = task.id;
                        bestKey = key;
                    }
                });
                if (firstTaskId) firstTaskIds.push(firstTaskId);
            });
            return new Set(firstTaskIds);
        });
    }, [computeSequential, filteredTasks, sequentialProjectIds]);

    const sortByProjectOrder = React.useCallback((items: Task[]) => {
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

    const getColumnTasks = React.useCallback((status: TaskStatus) => {
        let list = filteredTasks.filter((task) => task.status === status);
        if (status === 'next') {
            list = list.filter((task) => {
                if (!task.projectId) return true;
                const project = projectMap.get(task.projectId);
                if (!project?.isSequential) return true;
                return !computeSequential || sequentialProjectFirstTasks.has(task.id);
            });
            if (sortBy === 'default') {
                list = sortByProjectOrder(list);
            }
        }
        return sortBy === 'default' ? sortTasksByBoardOrder(list) : list;
    }, [computeSequential, filteredTasks, projectMap, sequentialProjectFirstTasks, sortBy, sortByProjectOrder]);

    const columnIdSet = React.useMemo(
        () => new Set<string>(getColumns(t).map((column) => column.id)),
        [t]
    );
    // Lock onto the column the drag is over, then snap to the closest card *within* that
    // column (by the dragged item's rect, not the raw pointer). Without this, releasing in
    // the gap between cards falls through to the column droppable and lands at the bottom,
    // which made cross-column placement feel inconsistent (#791).
    const collisionDetection = React.useCallback<CollisionDetection>((args) => {
        const pointerHits = pointerWithin(args);
        const intersections = pointerHits.length > 0 ? pointerHits : rectIntersection(args);
        const overId = getFirstCollision(intersections, 'id');
        if (overId == null) return closestCorners(args);

        if (columnIdSet.has(String(overId))) {
            const cardIds = new Set(getColumnTasks(overId as TaskStatus).map((task) => task.id));
            const columnCards = args.droppableContainers.filter((container) => cardIds.has(String(container.id)));
            if (columnCards.length > 0) {
                const closest = closestCenter({ ...args, droppableContainers: columnCards });
                if (closest.length > 0) return closest;
            }
        }
        return [{ id: overId }];
    }, [columnIdSet, getColumnTasks]);

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        setActiveTask(null);
        if (!over) return;

        const currentTask = tasks.find((task) => task.id === active.id);
        if (activeTask && currentTask && currentTask.status !== activeTask.status) return;

        const overTask = over.data.current?.task as Task | undefined;
        const action = resolveBoardDragEnd({
            activeId: String(active.id),
            overId: String(over.id),
            columnIds: COLUMNS.map((column) => column.id),
            activeStatus: currentTask?.status,
            overStatus: overTask?.status,
            columnTaskIds: currentTask ? getColumnTasks(currentTask.status).map((task) => task.id) : [],
            overColumnTaskIds: overTask ? getColumnTasks(overTask.status).map((task) => task.id) : undefined,
            canReorder: sortBy === 'default',
        });
        if (action.type === 'move') {
            moveTask(action.taskId, action.status);
        } else if (action.type === 'reorder') {
            void reorderBoardTasks(action.status, action.orderedIds);
        } else if (action.type === 'moveAndReorder') {
            // Change status first (keeps recurrence handling), then place at the dropped index.
            void (async () => {
                await moveTask(action.taskId, action.status);
                await reorderBoardTasks(action.status, action.orderedIds);
            })();
        }
    };

    const resolveText = React.useCallback((key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    }, [t]);

    const openQuickAdd = (status: TaskStatus) => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', {
            detail: { initialProps: { status } },
        }));
    };

    const getEmptyState = (status: TaskStatus) => {
        switch (status) {
            case 'inbox':
                return {
                    title: t('list.inbox') || 'Inbox',
                    body: resolveText('inbox.emptyAddHint', 'Inbox is clear. Capture something new.'),
                    action: t('common.add') || 'Add',
                };
            case 'next':
                return {
                    title: t('list.next') || 'Next Actions',
                    body: resolveText('list.noTasks', 'No next actions yet.'),
                    action: t('common.add') || 'Add',
                };
            case 'waiting':
                return {
                    title: resolveText('waiting.empty', t('list.waiting') || 'Waiting'),
                    body: resolveText('waiting.emptyHint', 'Track delegated or pending items.'),
                    action: t('common.add') || 'Add',
                };
            case 'someday':
                return {
                    title: resolveText('someday.empty', t('list.someday') || 'Someday'),
                    body: resolveText('someday.emptyHint', 'Store ideas for later.'),
                    action: t('common.add') || 'Add',
                };
            case 'done':
                return {
                    title: t('list.done') || 'Done',
                    body: resolveText('list.noTasks', 'Completed tasks appear here.'),
                    action: t('common.add') || 'Add',
                };
            default:
                return {
                    title: t('list.inbox') || 'Inbox',
                    body: resolveText('list.noTasks', 'No tasks yet.'),
                    action: t('common.add') || 'Add',
                };
        }
    };

    return (
        <ErrorBoundary>
            <div className="flex h-full min-h-0 flex-col">
                <div className="shrink-0 px-4 pb-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <h2 className="text-2xl font-bold tracking-tight">{t('board.title')}</h2>
                            <span className="text-xs text-muted-foreground">
                                {filteredTasks.length} {t('common.tasks')}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            {hasBoardFilters && (
                                <button
                                    type="button"
                                    onClick={clearFilters}
                                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                    {t('filters.clear')}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => setPersistedViewState((current) => ({ filtersOpen: !current.filtersOpen }))}
                                aria-expanded={showFiltersPanel}
                                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                                {showFiltersPanel ? t('filters.hide') : t('filters.show')}
                            </button>
                        </div>
                    </div>
                    <div className="mt-3">
                        <input
                            type="text"
                            data-view-filter-input
                            placeholder={t('common.search')}
                            aria-label={t('common.search')}
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            className="w-full text-sm px-3 py-2 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                    </div>
                    {sortBy !== 'default' && (
                        <p className="mt-2 text-xs text-muted-foreground">
                            {resolveText('board.reorderFollowsSort', 'Ordering follows the selected sort. Switch to default sort to reorder cards.')}
                        </p>
                    )}

                    {showFiltersPanel && (
                        <div className="mt-3 bg-card border border-border rounded-lg p-3 space-y-4">
                            {allTokens.length > 0 && (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                                        <Filter className="w-4 h-4" />
                                        {t('filters.contexts')}
                                    </div>
                                    <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                                        {allTokens.map((token) => {
                                            const isActive = token.trim().startsWith('#')
                                                ? selectedTags.includes(token)
                                                : selectedContexts.includes(token);
                                            return (
                                                <button
                                                    key={token}
                                                    type="button"
                                                    onClick={() => toggleToken(token)}
                                                    aria-pressed={isActive}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                                                        isActive
                                                            ? "bg-primary text-primary-foreground"
                                                            : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                    }`}
                                                >
                                                    {token}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            <div className="space-y-2">
                                <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('search.due.label')}</div>
                                <div className="flex flex-wrap gap-2">
                                    {DUE_DATE_PRESETS.map((preset) => {
                                        const isActive = selectedDuePreset === preset;
                                        return (
                                            <button
                                                key={preset}
                                                type="button"
                                                onClick={() => toggleDuePreset(preset)}
                                                aria-pressed={isActive}
                                                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                                                    isActive
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                }`}
                                            >
                                                {t(`filters.datePreset.${preset}`)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            <div className="space-y-2">
                                <div className="text-xs text-muted-foreground uppercase tracking-wide">{t('filters.projects')}</div>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => toggleProjectFilter(SAVED_FILTER_NO_PROJECT_ID)}
                                        aria-pressed={selectedProjectIds.includes(SAVED_FILTER_NO_PROJECT_ID)}
                                        className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                                            selectedProjectIds.includes(SAVED_FILTER_NO_PROJECT_ID)
                                                ? "bg-primary text-primary-foreground"
                                                : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                        }`}
                                    >
                                        {t('taskEdit.noProjectOption')}
                                    </button>
                                    {sortedProjects.map((project) => {
                                        const isActive = selectedProjectIds.includes(project.id);
                                        const projectColor = project.areaId ? areaById.get(project.areaId)?.color : undefined;
                                        return (
                                            <button
                                                key={project.id}
                                                type="button"
                                                onClick={() => toggleProjectFilter(project.id)}
                                                aria-pressed={isActive}
                                                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors flex items-center gap-2 ${
                                                    isActive
                                                        ? "bg-primary text-primary-foreground"
                                                        : "bg-muted hover:bg-muted/80 text-muted-foreground"
                                                }`}
                                            >
                                                <span
                                                    className="w-2 h-2 rounded-full"
                                                    style={{ backgroundColor: projectColor || "#6B7280" }}
                                                />
                                                <span className="truncate max-w-[140px]">{project.title}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
                    <div className="flex gap-4 h-full min-w-full pb-4 px-4">
                        <DndContext
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                            collisionDetection={collisionDetection}
                            sensors={sensors}
                        >
                            {COLUMNS.map((col) => (
                                <DroppableColumn
                                    key={col.id}
                                    id={col.id}
                                    label={col.label}
                                    tasks={getColumnTasks(col.id)}
                                    emptyState={getEmptyState(col.id)}
                                    onQuickAdd={openQuickAdd}
                                    dragLabel={t('board.dragTask') || 'Drag task'}
                                    compact={isCompact}
                                />
                            ))}

                            <DragOverlay>
                                {activeTask ? (
                                    <div className="w-80 rotate-3 cursor-grabbing">
                                        <TaskItem
                                            task={activeTask}
                                            showStatusSelect={false}
                                            showProjectBadgeInActions={false}
                                            actionsOverlay
                                            showHoverHint={false}
                                        />
                                    </div>
                                ) : null}
                            </DragOverlay>
                        </DndContext>
                    </div>
                </div>
            </div>
        </ErrorBoundary>
    );
}
