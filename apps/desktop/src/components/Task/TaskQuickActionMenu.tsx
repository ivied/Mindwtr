import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Calendar, CalendarClock, ChevronRight, Copy, FolderPlus, MapPin, Tag, Trash2 } from 'lucide-react';
import {
    getAdvancedReviewDate,
    hasTimeComponent,
    isDueForReview,
    safeFormatDate,
    safeParseDate,
    tFallback,
    type Area,
    type StoreActionResult,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';

import { reportError } from '../../lib/report-error';
import { cn } from '../../lib/utils';
import { FocusStarIcon } from '../FocusStarIcon';
import { Button } from '../ui/Button';
import { AreaSelector } from '../ui/AreaSelector';
import { normalizeDateInputValue } from './task-item-helpers';
import { ContextsField } from './fields/TaskMetadataFields';
import { DateField } from './TaskItemFieldRenderer';

const VIEWPORT_MARGIN_PX = 8;
const PANEL_GAP_PX = 8;
const MENU_WIDTH_PX = 224;

type QuickPanelId = 'startTime' | 'dueDate' | 'reviewAt' | 'area' | 'contexts' | null;

interface TaskQuickActionMenuProps {
    task: Task;
    x: number;
    y: number;
    t: (key: string) => string;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    contextOptions: string[];
    contextSuggestions?: string[];
    areas: Area[];
    readOnly: boolean;
    focusAction?: {
        isFocused: boolean;
        canToggle: boolean;
        label: string;
        title: string;
        onToggle: () => void;
    };
    onClose: () => void;
    onDuplicate: () => void;
    onPromoteToProject?: () => void;
    onDelete: () => void;
    onStatusChange: (status: TaskStatus) => void;
    onCreateArea: (name: string) => Promise<string | null>;
    onUpdateTask: (updates: Partial<Task>) => Promise<StoreActionResult>;
}

const clamp = (value: number, min: number, max: number) => {
    if (max <= min) return min;
    return Math.min(Math.max(value, min), max);
};

const parseTokenInput = (value: string) => Array.from(new Set(
    value
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean)
));

const getDueDateDraft = (value?: string) => {
    if (!value) return { date: '', time: '' };
    const parsed = safeParseDate(value);
    if (!parsed) return { date: '', time: '' };
    return {
        date: safeFormatDate(parsed, 'yyyy-MM-dd', value),
        time: hasTimeComponent(value) ? safeFormatDate(parsed, 'HH:mm', value) : '',
    };
};

export function TaskQuickActionMenu({
    task,
    x,
    y,
    t,
    dateFormatSetting,
    nativeDateInputLocale,
    contextOptions,
    contextSuggestions = contextOptions,
    areas,
    readOnly,
    focusAction,
    onClose,
    onDuplicate,
    onPromoteToProject,
    onDelete,
    onStatusChange,
    onCreateArea,
    onUpdateTask,
}: TaskQuickActionMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const initialLayoutScrollSettledRef = useRef(false);
    const startButtonRef = useRef<HTMLButtonElement | null>(null);
    const dueButtonRef = useRef<HTMLButtonElement | null>(null);
    const reviewButtonRef = useRef<HTMLButtonElement | null>(null);
    const areaButtonRef = useRef<HTMLButtonElement | null>(null);
    const contextsButtonRef = useRef<HTMLButtonElement | null>(null);
    const [activePanel, setActivePanel] = useState<QuickPanelId>(null);
    const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
    const [menuSize, setMenuSize] = useState({ width: MENU_WIDTH_PX, height: 1 });
    const initialStartDraft = getDueDateDraft(task.startTime);
    const initialDueDraft = getDueDateDraft(task.dueDate);
    const initialReviewDraft = getDueDateDraft(task.reviewAt);
    const initialAreaDraft = task.areaId || '';
    const initialContextsDraft = task.contexts?.join(', ') || '';
    const [startDateDraft, setStartDateDraft] = useState(initialStartDraft.date);
    const [startTimeDraft, setStartTimeDraft] = useState(initialStartDraft.time);
    const [dueDateDraft, setDueDateDraft] = useState(initialDueDraft.date);
    const [dueTimeDraft, setDueTimeDraft] = useState(initialDueDraft.time);
    const [reviewDateDraft, setReviewDateDraft] = useState(initialReviewDraft.date);
    const [reviewTimeDraft, setReviewTimeDraft] = useState(initialReviewDraft.time);
    const [areaDraft, setAreaDraft] = useState(initialAreaDraft);
    const [contextsDraft, setContextsDraft] = useState(initialContextsDraft);
    const [savingPanel, setSavingPanel] = useState<Exclude<QuickPanelId, null> | null>(null);
    const startLabel = tFallback(t, 'taskEdit.startDateLabel', 'Start Date');
    const dueLabel = tFallback(t, 'taskEdit.dueDateLabel', 'Due Date');
    const reviewLabel = tFallback(t, 'taskEdit.reviewDateLabel', 'Review Date');
    const areaLabel = tFallback(t, 'taskEdit.areaLabel', 'Area');
    const contextsLabel = tFallback(t, 'taskEdit.contextsLabel', 'Contexts');
    const noAreaLabel = tFallback(t, 'taskEdit.noAreaOption', 'No Area');
    const duplicateLabel = tFallback(t, 'projects.duplicate', 'Duplicate');
    const promoteToProjectLabel = t('task.createProjectFromTask');
    const deleteLabel = tFallback(t, 'common.delete', 'Delete');
    const convertToReferenceLabel = tFallback(t, 'task.convertToReference', 'Convert to Reference');
    const markReviewedLabel = tFallback(t, 'review.markReviewed', 'Mark reviewed');
    const advanceReviewLabel = tFallback(t, 'review.advanceWeek', 'Review in 1 week');
    const saveLabel = tFallback(t, 'common.save', 'Save');
    const cancelLabel = tFallback(t, 'common.cancel', 'Cancel');
    const moreOptionsLabel = tFallback(t, 'taskEdit.moreOptions', 'More options');
    const searchAreasLabel = tFallback(t, 'areas.search', 'Search areas');
    const noMatchesLabel = tFallback(t, 'common.noMatches', 'No matches');
    const createAreaLabel = tFallback(t, 'areas.create', 'Create area');
    const canEditArea = !task.projectId;
    const canMarkReviewed = isDueForReview(task.reviewAt);
    const normalizedInitialContexts = parseTokenInput(initialContextsDraft);
    const normalizedDraftContexts = parseTokenInput(contextsDraft);
    const startDraftChanged = startDateDraft !== initialStartDraft.date || startTimeDraft !== initialStartDraft.time;
    const dueDraftChanged = dueDateDraft !== initialDueDraft.date || dueTimeDraft !== initialDueDraft.time;
    const reviewDraftChanged = reviewDateDraft !== initialReviewDraft.date || reviewTimeDraft !== initialReviewDraft.time;
    const areaDraftChanged = areaDraft !== initialAreaDraft;
    const contextsDraftChanged = normalizedDraftContexts.join('\u0000') !== normalizedInitialContexts.join('\u0000');

    useEffect(() => {
        const nextStartDraft = getDueDateDraft(task.startTime);
        const nextDueDraft = getDueDateDraft(task.dueDate);
        const nextReviewDraft = getDueDateDraft(task.reviewAt);
        setStartDateDraft(nextStartDraft.date);
        setStartTimeDraft(nextStartDraft.time);
        setDueDateDraft(nextDueDraft.date);
        setDueTimeDraft(nextDueDraft.time);
        setReviewDateDraft(nextReviewDraft.date);
        setReviewTimeDraft(nextReviewDraft.time);
        setAreaDraft(task.areaId || '');
        setContextsDraft(task.contexts?.join(', ') || '');
    }, [task.areaId, task.contexts, task.dueDate, task.id, task.reviewAt, task.startTime]);

    useEffect(() => {
        const focusTarget = startButtonRef.current
            ?? dueButtonRef.current
            ?? reviewButtonRef.current
            ?? areaButtonRef.current
            ?? contextsButtonRef.current
            ?? menuRef.current?.querySelector<HTMLButtonElement>('button');
        focusTarget?.focus();
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            initialLayoutScrollSettledRef.current = true;
        }, 120);
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        const isInsideMenuSurface = (target: Node | null) => {
            if (!target) return false;
            if (menuRef.current?.contains(target) || panelRef.current?.contains(target)) return true;
            const targetElement = target instanceof Element ? target : target.parentElement;
            return Boolean(targetElement?.closest('[data-selector-dropdown="true"]'));
        };
        const handlePointer = (event: Event) => {
            const target = event.target as Node | null;
            if (isInsideMenuSurface(target)) return;
            onClose();
        };
        const handleScrollOrResize = (event: Event) => {
            if (event.type === 'scroll' && !initialLayoutScrollSettledRef.current) return;
            onClose();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            if (activePanel) {
                setActivePanel(null);
                return;
            }
            onClose();
        };
        window.addEventListener('mousedown', handlePointer);
        window.addEventListener('scroll', handleScrollOrResize, true);
        window.addEventListener('resize', handleScrollOrResize);
        window.addEventListener('contextmenu', handlePointer);
        window.addEventListener('keydown', handleKeyDown);
        return () => {
            window.removeEventListener('mousedown', handlePointer);
            window.removeEventListener('scroll', handleScrollOrResize, true);
            window.removeEventListener('resize', handleScrollOrResize);
            window.removeEventListener('contextmenu', handlePointer);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [activePanel, onClose]);

    const menuPosition = {
        left: clamp(
            x,
            VIEWPORT_MARGIN_PX,
            window.innerWidth - menuSize.width - VIEWPORT_MARGIN_PX,
        ),
        top: clamp(
            y,
            VIEWPORT_MARGIN_PX,
            window.innerHeight - menuSize.height - VIEWPORT_MARGIN_PX,
        ),
    };

    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!menu) return;
        const rect = menu.getBoundingClientRect();
        const nextSize = {
            width: Math.ceil(rect.width) || MENU_WIDTH_PX,
            height: Math.ceil(rect.height) || 1,
        };
        setMenuSize((current) => (
            current.width === nextSize.width && current.height === nextSize.height
                ? current
                : nextSize
        ));
    }, [canEditArea, readOnly]);

    useLayoutEffect(() => {
        if (!activePanel) {
            setPanelPosition(null);
            return;
        }
        const anchor = activePanel === 'startTime'
            ? startButtonRef.current
            : activePanel === 'dueDate'
                ? dueButtonRef.current
                : activePanel === 'reviewAt'
                    ? reviewButtonRef.current
                    : activePanel === 'area'
                        ? areaButtonRef.current
                        : contextsButtonRef.current;
        const panel = panelRef.current;
        if (!anchor || !panel) return;
        const anchorRect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const preferredLeft = anchorRect.right + PANEL_GAP_PX;
        const fallbackLeft = anchorRect.left - panelRect.width - PANEL_GAP_PX;
        const shouldOpenLeft = preferredLeft + panelRect.width > window.innerWidth - VIEWPORT_MARGIN_PX
            && fallbackLeft >= VIEWPORT_MARGIN_PX;

        setPanelPosition({
            left: clamp(
                shouldOpenLeft ? fallbackLeft : preferredLeft,
                VIEWPORT_MARGIN_PX,
                window.innerWidth - panelRect.width - VIEWPORT_MARGIN_PX,
            ),
            top: clamp(
                anchorRect.top,
                VIEWPORT_MARGIN_PX,
                window.innerHeight - panelRect.height - VIEWPORT_MARGIN_PX,
            ),
        });
    }, [activePanel, menuPosition.left, menuPosition.top]);

    if (typeof document === 'undefined') return null;

    const openPanel = (panelId: Exclude<QuickPanelId, null>) => {
        if (panelId === activePanel) {
            setPanelPosition(null);
            setActivePanel(null);
            return;
        }
        setPanelPosition(null);
        if (panelId === 'startTime') {
            const nextStartDraft = getDueDateDraft(task.startTime);
            setStartDateDraft(nextStartDraft.date);
            setStartTimeDraft(nextStartDraft.time);
        } else if (panelId === 'dueDate') {
            const nextDueDraft = getDueDateDraft(task.dueDate);
            setDueDateDraft(nextDueDraft.date);
            setDueTimeDraft(nextDueDraft.time);
        } else if (panelId === 'reviewAt') {
            const nextReviewDraft = getDueDateDraft(task.reviewAt);
            setReviewDateDraft(nextReviewDraft.date);
            setReviewTimeDraft(nextReviewDraft.time);
        } else if (panelId === 'area') {
            setAreaDraft(task.areaId || '');
        } else {
            setContextsDraft(task.contexts?.join(', ') || '');
        }
        setActivePanel(panelId);
    };

    const handleStartDateSave = async (
        dateDraft = startDateDraft,
        timeDraft = startTimeDraft,
    ) => {
        setSavingPanel('startTime');
        try {
            const normalizedDate = normalizeDateInputValue(dateDraft);
            const nextStartTime = normalizedDate
                ? (timeDraft ? `${normalizedDate}T${timeDraft}` : normalizedDate)
                : undefined;
            const result = await onUpdateTask({ startTime: nextStartTime });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task start date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task start date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleDueDateSave = async (
        dateDraft = dueDateDraft,
        timeDraft = dueTimeDraft,
    ) => {
        setSavingPanel('dueDate');
        try {
            const normalizedDate = normalizeDateInputValue(dateDraft);
            const nextDueDate = normalizedDate
                ? (timeDraft ? `${normalizedDate}T${timeDraft}` : normalizedDate)
                : undefined;
            const result = await onUpdateTask({ dueDate: nextDueDate });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task due date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task due date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleReviewDateSave = async (
        dateDraft = reviewDateDraft,
        timeDraft = reviewTimeDraft,
    ) => {
        setSavingPanel('reviewAt');
        try {
            const normalizedDate = normalizeDateInputValue(dateDraft);
            const nextReviewAt = normalizedDate
                ? (timeDraft ? `${normalizedDate}T${timeDraft}` : normalizedDate)
                : undefined;
            const result = await onUpdateTask({ reviewAt: nextReviewAt });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task review date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task review date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleMarkReviewed = async () => {
        setSavingPanel('reviewAt');
        try {
            const result = await onUpdateTask({ reviewAt: undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to mark task reviewed');
            }
            onClose();
        } catch (error) {
            reportError('Failed to mark task reviewed from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleAdvanceReview = async () => {
        setSavingPanel('reviewAt');
        try {
            const result = await onUpdateTask({ reviewAt: getAdvancedReviewDate(task.reviewAt) });
            if (!result.success) {
                throw new Error(result.error || 'Failed to advance task review date');
            }
            onClose();
        } catch (error) {
            reportError('Failed to advance task review date from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleAreaSave = async () => {
        setSavingPanel('area');
        try {
            const result = await onUpdateTask({ areaId: areaDraft || undefined });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task area');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task area from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const handleContextsSave = async () => {
        setSavingPanel('contexts');
        try {
            const result = await onUpdateTask({ contexts: parseTokenInput(contextsDraft) });
            if (!result.success) {
                throw new Error(result.error || 'Failed to update task contexts');
            }
            onClose();
        } catch (error) {
            reportError('Failed to update task contexts from quick actions', error);
        } finally {
            setSavingPanel(null);
        }
    };

    const renderMenuAction = ({
        ref,
        icon,
        label,
        active = false,
        onClick,
        showChevron = false,
        disabled = false,
        title,
    }: {
        ref?: RefObject<HTMLButtonElement | null>;
        icon: ReactNode;
        label: string;
        active?: boolean;
        onClick: () => void;
        showChevron?: boolean;
        disabled?: boolean;
        title?: string;
    }) => (
        <button
            ref={ref}
            type="button"
            role="menuitem"
            aria-haspopup={showChevron ? 'dialog' : undefined}
            aria-expanded={showChevron ? active : undefined}
            disabled={disabled}
            title={title}
            onClick={onClick}
            className={cn(
                'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                disabled
                    ? 'cursor-not-allowed text-muted-foreground/50'
                    : active
                        ? 'bg-muted text-foreground'
                        : 'text-foreground hover:bg-muted',
            )}
        >
            <span className={disabled ? 'text-muted-foreground/50' : 'text-muted-foreground'}>{icon}</span>
            <span className="flex-1 truncate">{label}</span>
            {showChevron ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : null}
        </button>
    );

    return createPortal(
        <>
                <div
                    ref={menuRef}
                    role="menu"
                    aria-label={moreOptionsLabel}
                    className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
                    style={{ top: menuPosition.top, left: menuPosition.left }}
                    onContextMenu={(event) => event.preventDefault()}
                >
                {!readOnly && focusAction && renderMenuAction({
                    icon: (
                        <FocusStarIcon
                            className={cn(
                                'h-4 w-4',
                                focusAction.isFocused && 'text-yellow-500',
                            )}
                            filled={focusAction.isFocused}
                        />
                    ),
                    label: focusAction.label,
                    title: focusAction.title,
                    disabled: !focusAction.canToggle,
                    onClick: () => {
                        if (!focusAction.canToggle) return;
                        focusAction.onToggle();
                        onClose();
                    },
                })}
                {!readOnly && focusAction ? <div className="my-1 h-px bg-border/70" role="separator" /> : null}
                {!readOnly && renderMenuAction({
                    ref: startButtonRef,
                    icon: <Calendar className="h-4 w-4" />,
                    label: `${startLabel}…`,
                    active: activePanel === 'startTime',
                    onClick: () => openPanel('startTime'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: dueButtonRef,
                    icon: <Calendar className="h-4 w-4" />,
                    label: `${dueLabel}…`,
                    active: activePanel === 'dueDate',
                    onClick: () => openPanel('dueDate'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: reviewButtonRef,
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: `${reviewLabel}…`,
                    active: activePanel === 'reviewAt',
                    onClick: () => openPanel('reviewAt'),
                    showChevron: true,
                })}
                {!readOnly && canMarkReviewed && renderMenuAction({
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: markReviewedLabel,
                    onClick: () => { void handleMarkReviewed(); },
                })}
                {!readOnly && canMarkReviewed && renderMenuAction({
                    icon: <CalendarClock className="h-4 w-4" />,
                    label: advanceReviewLabel,
                    onClick: () => { void handleAdvanceReview(); },
                })}
                {!readOnly && canEditArea && renderMenuAction({
                    ref: areaButtonRef,
                    icon: <MapPin className="h-4 w-4" />,
                    label: `${areaLabel}…`,
                    active: activePanel === 'area',
                    onClick: () => openPanel('area'),
                    showChevron: true,
                })}
                {!readOnly && renderMenuAction({
                    ref: contextsButtonRef,
                    icon: <Tag className="h-4 w-4" />,
                    label: `${contextsLabel}…`,
                    active: activePanel === 'contexts',
                    onClick: () => openPanel('contexts'),
                    showChevron: true,
                })}
                {!readOnly && task.status !== 'reference' && renderMenuAction({
                    icon: <BookOpen className="h-4 w-4" />,
                    label: convertToReferenceLabel,
                    onClick: () => {
                        onStatusChange('reference');
                        onClose();
                    },
                })}
                {!readOnly ? <div className="my-1 h-px bg-border/70" role="separator" /> : null}
                {renderMenuAction({
                    icon: <Copy className="h-4 w-4" />,
                    label: duplicateLabel,
                    onClick: () => {
                        onDuplicate();
                        onClose();
                    },
                })}
                {!readOnly && onPromoteToProject && renderMenuAction({
                    icon: <FolderPlus className="h-4 w-4" />,
                    label: promoteToProjectLabel,
                    onClick: () => {
                        onPromoteToProject();
                        onClose();
                    },
                })}
                {renderMenuAction({
                    icon: <Trash2 className="h-4 w-4" />,
                    label: deleteLabel,
                    onClick: () => {
                        onDelete();
                        onClose();
                    },
                })}
            </div>

            {activePanel && (
                <div
                    ref={panelRef}
                    role="dialog"
                    aria-label={
                        activePanel === 'startTime'
                            ? startLabel
                            : activePanel === 'dueDate'
                                ? dueLabel
                                : activePanel === 'reviewAt'
                                ? reviewLabel
                                : activePanel === 'area'
                                    ? areaLabel
                                    : contextsLabel
                    }
                    className="fixed z-50 w-[min(30rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
                    style={{
                        top: panelPosition?.top ?? menuPosition.top,
                        left: panelPosition?.left ?? (menuPosition.left + 188),
                        visibility: panelPosition ? 'visible' : 'hidden',
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                >
                    {activePanel === 'startTime' ? (
                        <div className="space-y-3">
                            <DateField
                                t={t}
                                label={startLabel}
                                dateAriaLabel={startLabel}
                                dateValue={startDateDraft}
                                selectedDate={safeParseDate(startDateDraft)}
                                dateFormatSetting={dateFormatSetting}
                                nativeDateInputLocale={nativeDateInputLocale}
                                dateInputClassName="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                timeInput={
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.startTime')}
                                        value={startTimeDraft}
                                        disabled={!startDateDraft}
                                        onChange={(event) => setStartTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                }
                                onDateChange={(value) => {
                                    setStartDateDraft(value);
                                    if (!value) setStartTimeDraft('');
                                }}
                                onCalendarSelect={(value) => {
                                    setStartDateDraft(value);
                                    void handleStartDateSave(value, startTimeDraft);
                                }}
                                onClear={() => {
                                    setStartDateDraft('');
                                    setStartTimeDraft('');
                                }}
                                hasValue={Boolean(startDateDraft || startTimeDraft)}
                            />
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setStartDateDraft(initialStartDraft.date);
                                        setStartTimeDraft(initialStartDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void handleStartDateSave()}
                                    loading={savingPanel === 'startTime'}
                                    disabled={!startDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'dueDate' ? (
                        <div className="space-y-3">
                            <DateField
                                t={t}
                                label={dueLabel}
                                dateAriaLabel={dueLabel}
                                dateValue={dueDateDraft}
                                selectedDate={safeParseDate(dueDateDraft)}
                                dateFormatSetting={dateFormatSetting}
                                nativeDateInputLocale={nativeDateInputLocale}
                                dateInputClassName="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                timeInput={
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.dueTime')}
                                        value={dueTimeDraft}
                                        disabled={!dueDateDraft}
                                        onChange={(event) => setDueTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                }
                                onDateChange={(value) => {
                                    setDueDateDraft(value);
                                    if (!value) setDueTimeDraft('');
                                }}
                                onCalendarSelect={(value) => {
                                    setDueDateDraft(value);
                                    void handleDueDateSave(value, dueTimeDraft);
                                }}
                                onClear={() => {
                                    setDueDateDraft('');
                                    setDueTimeDraft('');
                                }}
                                hasValue={Boolean(dueDateDraft || dueTimeDraft)}
                            />
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setDueDateDraft(initialDueDraft.date);
                                        setDueTimeDraft(initialDueDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void handleDueDateSave()}
                                    loading={savingPanel === 'dueDate'}
                                    disabled={!dueDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'reviewAt' ? (
                        <div className="space-y-3">
                            <DateField
                                t={t}
                                label={reviewLabel}
                                dateAriaLabel={reviewLabel}
                                dateValue={reviewDateDraft}
                                selectedDate={safeParseDate(reviewDateDraft)}
                                dateFormatSetting={dateFormatSetting}
                                nativeDateInputLocale={nativeDateInputLocale}
                                dateInputClassName="rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                                timeInput={
                                    <input
                                        type="time"
                                        lang={nativeDateInputLocale}
                                        aria-label={t('task.aria.reviewTime')}
                                        value={reviewTimeDraft}
                                        disabled={!reviewDateDraft}
                                        onChange={(event) => setReviewTimeDraft(event.target.value)}
                                        className="w-24 shrink-0 rounded border border-border bg-muted/50 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                }
                                onDateChange={(value) => {
                                    setReviewDateDraft(value);
                                    if (!value) setReviewTimeDraft('');
                                }}
                                onCalendarSelect={(value) => {
                                    setReviewDateDraft(value);
                                    void handleReviewDateSave(value, reviewTimeDraft);
                                }}
                                onClear={() => {
                                    setReviewDateDraft('');
                                    setReviewTimeDraft('');
                                }}
                                hasValue={Boolean(reviewDateDraft || reviewTimeDraft)}
                            />
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setReviewDateDraft(initialReviewDraft.date);
                                        setReviewTimeDraft(initialReviewDraft.time);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void handleReviewDateSave()}
                                    loading={savingPanel === 'reviewAt'}
                                    disabled={!reviewDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : activePanel === 'area' ? (
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">{areaLabel}</label>
                                <AreaSelector
                                    areas={areas}
                                    value={areaDraft}
                                    onChange={setAreaDraft}
                                    onCreateArea={onCreateArea}
                                    placeholder={noAreaLabel}
                                    noAreaLabel={noAreaLabel}
                                    searchPlaceholder={searchAreasLabel}
                                    noMatchesLabel={noMatchesLabel}
                                    createAreaLabel={createAreaLabel}
                                    className="w-full"
                                />
                            </div>
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setAreaDraft(initialAreaDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleAreaSave}
                                    loading={savingPanel === 'area'}
                                    disabled={!areaDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <ContextsField
                                t={t}
                                value={contextsDraft}
                                options={contextOptions}
                                suggestions={contextSuggestions}
                                onChange={setContextsDraft}
                            />
                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => {
                                        setContextsDraft(initialContextsDraft);
                                        setActivePanel(null);
                                    }}
                                >
                                    {cancelLabel}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleContextsSave}
                                    loading={savingPanel === 'contexts'}
                                    disabled={!contextsDraftChanged}
                                >
                                    {saveLabel}
                                </Button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </>,
        document.body,
    );
}
