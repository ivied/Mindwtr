import { useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, X } from 'lucide-react';
import {
    isSelectableProjectForTaskAssignment,
    parseBulkOrganizeTokenInput,
    tFallback,
    type Area,
    type BulkOrganizeStatus,
    type BulkOrganizeTaskUpdateInput,
    type Project,
} from '@mindwtr/core';

import { ModalPortal } from '../../ModalPortal';
import { Button } from '../../ui/Button';

type TaskBulkOrganizeModalProps = {
    isOpen: boolean;
    selectedCount: number;
    projects: Project[];
    areas: Area[];
    isApplying: boolean;
    t: (key: string) => string;
    titleKey?: string;
    titleFallback?: string;
    onApply: (input: BulkOrganizeTaskUpdateInput) => Promise<void> | void;
    onCancel: () => void;
};

const STATUS_OPTIONS: BulkOrganizeStatus[] = ['next', 'waiting', 'someday', 'reference', 'done'];
const KEEP_VALUE = '__KEEP__';
const NONE_VALUE = '__NONE__';

export function TaskBulkOrganizeModal({
    isOpen,
    selectedCount,
    projects,
    areas,
    isApplying,
    t,
    titleKey = 'bulk.organizeTasks',
    titleFallback = 'Bulk organize tasks',
    onApply,
    onCancel,
}: TaskBulkOrganizeModalProps) {
    const [status, setStatus] = useState<BulkOrganizeStatus>('next');
    const [projectChoice, setProjectChoice] = useState(KEEP_VALUE);
    const [areaChoice, setAreaChoice] = useState(KEEP_VALUE);
    const [contextsInput, setContextsInput] = useState('');
    const [tagsInput, setTagsInput] = useState('');
    const [startDate, setStartDate] = useState('');
    const [dueDate, setDueDate] = useState('');
    const [reviewDate, setReviewDate] = useState('');
    const [delegateWho, setDelegateWho] = useState('');
    const [showValidation, setShowValidation] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        setStatus('next');
        setProjectChoice(KEEP_VALUE);
        setAreaChoice(KEEP_VALUE);
        setContextsInput('');
        setTagsInput('');
        setStartDate('');
        setDueDate('');
        setReviewDate('');
        setDelegateWho('');
        setShowValidation(false);
    }, [isOpen]);

    const activeProjects = useMemo(
        () => projects
            .filter(isSelectableProjectForTaskAssignment)
            .sort((a, b) => a.title.localeCompare(b.title)),
        [projects],
    );
    const activeAreas = useMemo(
        () => areas
            .filter((area) => !area.deletedAt)
            .sort((a, b) => a.name.localeCompare(b.name)),
        [areas],
    );

    if (!isOpen || typeof document === 'undefined') return null;

    const isWaiting = status === 'waiting';
    const canApply = selectedCount > 0 && (!isWaiting || delegateWho.trim().length > 0);
    const selectedProjectId = projectChoice !== KEEP_VALUE && projectChoice !== NONE_VALUE ? projectChoice : undefined;
    const title = tFallback(t, titleKey, titleFallback);

    const apply = () => {
        if (!canApply) {
            setShowValidation(true);
            return;
        }

        const input: BulkOrganizeTaskUpdateInput = {
            status,
            contexts: parseBulkOrganizeTokenInput(contextsInput, '@'),
            tags: parseBulkOrganizeTokenInput(tagsInput, '#'),
        };

        if (projectChoice !== KEEP_VALUE) {
            input.projectId = projectChoice === NONE_VALUE ? null : projectChoice;
        }
        if (!selectedProjectId && areaChoice !== KEEP_VALUE) {
            input.areaId = areaChoice === NONE_VALUE ? null : areaChoice;
        }
        if (startDate.trim()) input.startTime = startDate.trim();
        if (dueDate.trim()) input.dueDate = dueDate.trim();
        if (reviewDate.trim()) input.reviewAt = reviewDate.trim();
        if (isWaiting) input.assignedTo = delegateWho.trim();

        void onApply(input);
    };

    return (
        <ModalPortal>
        <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[8vh]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-bulk-organize-title"
            onClick={onCancel}
        >
            <div
                className="flex max-h-[84vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                    <div>
                        <div className="flex items-center gap-2">
                            <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                            <h3 id="task-bulk-organize-title" className="font-semibold">
                                {title}
                            </h3>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {selectedCount} {tFallback(t, 'bulk.selected', 'selected')} - {tFallback(t, 'bulk.organizeHint', 'Apply shared organizing fields. Titles and descriptions stay unchanged.')}
                        </p>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={onCancel}
                        aria-label={tFallback(t, 'common.close', 'Close')}
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto p-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'bulk.organizeStatus', 'Status')}</span>
                            <select
                                value={status}
                                onChange={(event) => {
                                    setStatus(event.currentTarget.value as BulkOrganizeStatus);
                                    setShowValidation(false);
                                }}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            >
                                {STATUS_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {tFallback(t, `status.${option}`, option)}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'taskEdit.projectLabel', 'Project')}</span>
                            <select
                                value={projectChoice}
                                onChange={(event) => {
                                    setProjectChoice(event.currentTarget.value);
                                    if (event.currentTarget.value !== KEEP_VALUE && event.currentTarget.value !== NONE_VALUE) {
                                        setAreaChoice(KEEP_VALUE);
                                    }
                                }}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            >
                                <option value={KEEP_VALUE}>{tFallback(t, 'bulk.keepProject', 'Keep project')}</option>
                                <option value={NONE_VALUE}>{tFallback(t, 'taskEdit.noProjectOption', 'No project')}</option>
                                {activeProjects.map((project) => (
                                    <option key={project.id} value={project.id}>
                                        {project.title}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'projects.areaLabel', 'Area')}</span>
                            <select
                                value={areaChoice}
                                onChange={(event) => setAreaChoice(event.currentTarget.value)}
                                disabled={Boolean(selectedProjectId)}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value={KEEP_VALUE}>{tFallback(t, 'bulk.keepArea', 'Keep area')}</option>
                                <option value={NONE_VALUE}>{tFallback(t, 'taskEdit.noAreaOption', 'No area')}</option>
                                {activeAreas.map((area) => (
                                    <option key={area.id} value={area.id}>
                                        {area.name}
                                    </option>
                                ))}
                            </select>
                        </label>

                        {isWaiting && (
                            <label className="space-y-1 text-xs font-medium text-muted-foreground">
                                <span>{tFallback(t, 'process.delegateWhoLabel', 'Waiting for')}</span>
                                <input
                                    value={delegateWho}
                                    onChange={(event) => {
                                        setDelegateWho(event.currentTarget.value);
                                        setShowValidation(false);
                                    }}
                                    className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                    placeholder={tFallback(t, 'process.delegateWhoPlaceholder', 'Person or team')}
                                />
                            </label>
                        )}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'taskEdit.startDateLabel', 'Start')}</span>
                            <input
                                type="date"
                                value={startDate}
                                onChange={(event) => setStartDate(event.currentTarget.value)}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                        </label>
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'taskEdit.dueDateLabel', 'Due')}</span>
                            <input
                                type="date"
                                value={dueDate}
                                onChange={(event) => setDueDate(event.currentTarget.value)}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                        </label>
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{isWaiting ? tFallback(t, 'process.followUpLabel', 'Follow-up') : tFallback(t, 'taskEdit.reviewDateLabel', 'Review')}</span>
                            <input
                                type="date"
                                value={reviewDate}
                                onChange={(event) => setReviewDate(event.currentTarget.value)}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                        </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'taskEdit.contextsLabel', 'Contexts')}</span>
                            <input
                                value={contextsInput}
                                onChange={(event) => setContextsInput(event.currentTarget.value)}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                placeholder="@computer, @office"
                            />
                        </label>
                        <label className="space-y-1 text-xs font-medium text-muted-foreground">
                            <span>{tFallback(t, 'taskEdit.tagsLabel', 'Tags')}</span>
                            <input
                                value={tagsInput}
                                onChange={(event) => setTagsInput(event.currentTarget.value)}
                                className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                                placeholder="#project, #admin"
                            />
                        </label>
                    </div>

                    {showValidation && (
                        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            {tFallback(t, 'bulk.waitingPersonRequired', 'Choose who these items are waiting for.')}
                        </p>
                    )}
                </div>

                <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
                    <Button variant="secondary" onClick={onCancel} disabled={isApplying}>
                        {tFallback(t, 'common.cancel', 'Cancel')}
                    </Button>
                    <Button onClick={apply} loading={isApplying} disabled={selectedCount === 0}>
                        {tFallback(t, 'bulk.applyToSelected', 'Apply to selected')}
                    </Button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
