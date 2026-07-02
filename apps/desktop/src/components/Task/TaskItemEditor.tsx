import { useState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, HelpCircle, Loader2, Sparkles, Trash2 } from 'lucide-react';
import {
    filterProjectsBySelectedArea,
    resolveAutoTextDirection,
    tFallback,
    type Area,
    type ClarifyResponse,
    type Project,
    type Section,
    type TaskEditorFieldId,
    type TaskEditorSectionId,
    type TimeEstimate,
} from '@mindwtr/core';
import { AreaSelector } from '../ui/AreaSelector';
import { ProjectSelector } from '../ui/ProjectSelector';
import { SectionSelector } from '../ui/SectionSelector';
import { TaskInput, type TaskInputAcceptedSuggestion } from './TaskInput';
import { cn } from '../../lib/utils';
import { taskEditorLabelClassName } from './task-editor-label';

interface TaskItemEditorProps {
    t: (key: string) => string;
    editTitle: string;
    setEditTitle: (value: string) => void;
    editContexts: string;
    setEditContexts: (value: string) => void;
    editTags: string;
    setEditTags: (value: string) => void;
    autoFocusTitle?: boolean;
    resetCopilotDraft: () => void;
    aiEnabled: boolean;
    isAIWorking: boolean;
    handleAIClarify: () => void;
    handleAIBreakdown: () => void;
    copilotSuggestion: { context?: string; timeEstimate?: TimeEstimate; tags?: string[] } | null;
    copilotApplied: boolean;
    applyCopilotSuggestion: () => void;
    copilotContext?: string;
    copilotEstimate?: TimeEstimate;
    copilotTags: string[];
    timeEstimatesEnabled: boolean;
    aiError: string | null;
    aiBreakdownSteps: string[] | null;
    onAddBreakdownSteps: () => void;
    onDismissBreakdown: () => void;
    aiClarifyResponse: ClarifyResponse | null;
    onSelectClarifyOption: (action: string) => void;
    onApplyAISuggestion: () => void;
    onDismissClarify: () => void;
    projects: Project[];
    sections: Section[];
    areas: Area[];
    editProjectId: string;
    setEditProjectId: (value: string) => void;
    editSectionId: string;
    setEditSectionId: (value: string) => void;
    editAreaId: string;
    setEditAreaId: (value: string) => void;
    onCreateProject: (title: string, areaId?: string) => Promise<string | null>;
    onCreateArea?: (name: string) => Promise<string | null>;
    onCreateSection?: (title: string) => Promise<string | null>;
    showProjectField: boolean;
    showAreaField: boolean;
    showSectionField: boolean;
    basicFields: TaskEditorFieldId[];
    schedulingFields: TaskEditorFieldId[];
    organizationFields: TaskEditorFieldId[];
    detailsFields: TaskEditorFieldId[];
    sectionCounts: {
        scheduling: number;
        organization: number;
        details: number;
    };
    sectionOpenDefaults: Record<TaskEditorSectionId, boolean>;
    renderField: (fieldId: TaskEditorFieldId) => ReactNode;
    language: string;
    inputContexts: string[];
    onAcceptTitleSuggestion?: (suggestion: TaskInputAcceptedSuggestion) => boolean | Promise<boolean>;
    isDoneActionActive?: boolean;
    onMarkDone?: () => void;
    onDuplicateTask: () => void;
    onDeleteTask?: () => void;
    onCancel: () => void;
    onSubmit: (e: FormEvent) => void;
}

function appendCommaToken(value: string, token: string): string {
    const normalizedToken = token.trim();
    if (!normalizedToken) return value;
    const tokens = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    if (tokens.some((item) => item.toLowerCase() === normalizedToken.toLowerCase())) {
        return tokens.join(', ');
    }
    return [...tokens, normalizedToken].join(', ');
}

function ensureTokenPrefix(value: string, prefix: '@' | '#'): string {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed.replace(/^[@#]+/, '')}`;
}

export function TaskItemEditor({
    t,
    editTitle,
    setEditTitle,
    editContexts,
    setEditContexts,
    editTags,
    setEditTags,
    autoFocusTitle = false,
    resetCopilotDraft,
    aiEnabled,
    isAIWorking,
    handleAIClarify,
    handleAIBreakdown,
    copilotSuggestion,
    copilotApplied,
    applyCopilotSuggestion,
    copilotContext,
    copilotEstimate,
    copilotTags,
    timeEstimatesEnabled,
    aiError,
    aiBreakdownSteps,
    onAddBreakdownSteps,
    onDismissBreakdown,
    aiClarifyResponse,
    onSelectClarifyOption,
    onApplyAISuggestion,
    onDismissClarify,
    projects,
    sections,
    areas,
    editProjectId,
    setEditProjectId,
    editSectionId,
    setEditSectionId,
    editAreaId,
    setEditAreaId,
    onCreateProject,
    onCreateArea,
    onCreateSection,
    showProjectField,
    showAreaField,
    showSectionField,
    basicFields,
    schedulingFields,
    organizationFields,
    detailsFields,
    sectionCounts,
    sectionOpenDefaults,
    renderField,
    language,
    inputContexts,
    onAcceptTitleSuggestion,
    isDoneActionActive = false,
    onMarkDone,
    onDuplicateTask,
    onDeleteTask,
    onCancel,
    onSubmit,
}: TaskItemEditorProps) {
    const titleDirection = resolveAutoTextDirection(editTitle, language);
    const aiAssistantLabel = t('taskEdit.aiAssistant');
    const aiAssistantAriaLabel = aiAssistantLabel === 'taskEdit.aiAssistant' ? 'AI assistant' : aiAssistantLabel;
    const aiWorkingLabel = t('ai.working');
    const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;
    const taskEditorLayoutHelpLabel = tFallback(t, 'taskEdit.editorLayoutHelpLabel', 'Editor layout help');
    const taskEditorLayoutHelpText = tFallback(
        t,
        'taskEdit.editorLayoutHelpText',
        'You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.'
    );
    const [editorLayoutHelpOpen, setEditorLayoutHelpOpen] = useState(false);

    const compareLabels = (left: string, right: string) =>
        left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    const sortedProjects = [...projects].sort((a, b) => compareLabels(a.title, b.title));
    const sortedAreas = [...areas].sort((a, b) => compareLabels(a.name, b.name));
    const projectFilterAreaId = editAreaId || undefined;
    const filteredProjects = filterProjectsBySelectedArea(sortedProjects, projectFilterAreaId);
    const [schedulingOpen, setSchedulingOpen] = useState(sectionOpenDefaults.scheduling);
    const [organizationOpen, setOrganizationOpen] = useState(sectionOpenDefaults.organization);
    const [detailsOpen, setDetailsOpen] = useState(sectionOpenDefaults.details);
    const [aiMenuOpen, setAiMenuOpen] = useState(false);
    const aiMenuRef = useRef<HTMLDivElement>(null);
    const handleTitleSuggestionAccept = async (suggestion: TaskInputAcceptedSuggestion) => {
        resetCopilotDraft();
        if (await onAcceptTitleSuggestion?.(suggestion)) {
            return true;
        }
        if (suggestion.kind === 'context') {
            setEditContexts(appendCommaToken(editContexts, ensureTokenPrefix(suggestion.value, '@')));
            return true;
        }
        if (suggestion.kind === 'tag') {
            setEditTags(appendCommaToken(editTags, ensureTokenPrefix(suggestion.value, '#')));
            return true;
        }
        if (suggestion.kind === 'project') {
            setEditProjectId(suggestion.projectId);
            setEditSectionId('');
            setEditAreaId('');
            return true;
        }
        if (suggestion.kind === 'createProject') {
            if (!suggestion.projectId) return false;
            setEditProjectId(suggestion.projectId);
            setEditSectionId('');
            setEditAreaId('');
            return true;
        }
        if (suggestion.kind === 'area') {
            setEditAreaId(suggestion.areaId);
            setEditProjectId('');
            setEditSectionId('');
            return true;
        }
        return false;
    };

    useEffect(() => {
        if (!aiMenuOpen) return;
        const handleClick = (event: MouseEvent) => {
            if (!aiMenuRef.current) return;
            if (aiMenuRef.current.contains(event.target as Node)) return;
            setAiMenuOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [aiMenuOpen]);
    return (
        <form
            onSubmit={onSubmit}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    onCancel();
                    return;
                }
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    const form = event.currentTarget as HTMLFormElement;
                    if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit();
                    } else {
                        onSubmit(event as unknown as FormEvent);
                    }
                }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="flex flex-col gap-3 max-h-[80vh]"
        >
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
                <div className="flex items-start gap-3 pt-0.5">
                    {onMarkDone && (
                        <button
                            type="button"
                            onClick={onMarkDone}
                            aria-label={t('status.done')}
                            aria-pressed={isDoneActionActive}
                            title={t('status.done')}
                            className={cn(
                                'mt-0.5 inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-card motion-reduce:transition-none',
                                isDoneActionActive
                                    ? 'border-emerald-500 bg-emerald-500 text-white shadow-sm'
                                    : 'border-border bg-muted/30 text-muted-foreground hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-500'
                            )}
                        >
                            <Check className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                    <TaskInput
                        autoFocus={autoFocusTitle}
                        value={editTitle}
                        onChange={(value) => {
                            setEditTitle(value);
                            resetCopilotDraft();
                        }}
                        projects={projects}
                        contexts={inputContexts}
                        areas={areas}
                        onCreateProject={onCreateProject}
                        onAcceptSuggestion={handleTitleSuggestionAccept}
                        placeholder={t('taskEdit.titleLabel')}
                        ariaLabel={t('taskEdit.titleLabel')}
                        className="w-full rounded-sm bg-transparent border-b border-primary/60 px-1 pb-1.5 pt-0 text-lg font-semibold leading-7 text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:ring-0 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 focus-visible:ring-offset-card outline-none motion-reduce:transition-none"
                        containerClassName="flex-1 min-w-0"
                        dir={titleDirection}
                    />
                    {aiEnabled && (
                        <div className="flex items-center gap-2">
                            <div className="relative" ref={aiMenuRef}>
                                <button
                                    type="button"
                                    onClick={() => setAiMenuOpen((prev) => !prev)}
                                    disabled={isAIWorking}
                                    aria-label={aiAssistantAriaLabel}
                                    aria-expanded={aiMenuOpen}
                                    aria-busy={isAIWorking}
                                    className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 disabled:cursor-not-allowed"
                                >
                                    {isAIWorking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                </button>
                                {aiMenuOpen && (
                                    <div className="absolute right-0 mt-2 w-44 rounded-md border border-border bg-card shadow-lg overflow-hidden z-10">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setAiMenuOpen(false);
                                                handleAIClarify();
                                            }}
                                            disabled={isAIWorking}
                                            aria-busy={isAIWorking}
                                            className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                                        >
                                            {isAIWorking && <Loader2 className="w-3 h-3 animate-spin" />}
                                            {t('taskEdit.aiClarify')}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setAiMenuOpen(false);
                                                handleAIBreakdown();
                                            }}
                                            disabled={isAIWorking}
                                            aria-busy={isAIWorking}
                                            className="w-full text-left text-xs px-3 py-2 hover:bg-muted/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
                                        >
                                            {isAIWorking && <Loader2 className="w-3 h-3 animate-spin" />}
                                            {t('taskEdit.aiBreakdown')}
                                        </button>
                                    </div>
                                )}
                            </div>
                            {isAIWorking && (
                                <div role="status" aria-live="polite" className="text-xs text-muted-foreground">
                                    {aiWorkingText}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            {aiEnabled && copilotSuggestion && !copilotApplied && (
                <button
                    type="button"
                    onClick={applyCopilotSuggestion}
                    className="text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground hover:bg-muted/60 transition-colors text-left"
                >
                    ✨ {t('copilot.suggested')}{' '}
                    {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                    {timeEstimatesEnabled && copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
                    {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                    <span className="ml-2 text-muted-foreground/70">{t('copilot.applyHint')}</span>
                </button>
            )}
            {aiEnabled && copilotApplied && (
                <div className="text-xs px-2 py-1 rounded bg-muted/30 border border-border text-muted-foreground">
                    ✅ {t('copilot.applied')}{' '}
                    {copilotContext ? `${copilotContext} ` : ''}
                    {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                    {copilotTags.length ? copilotTags.join(' ') : ''}
                </div>
            )}
            {aiEnabled && aiError && (
                <div className="text-xs text-muted-foreground border border-border rounded-md p-2 bg-muted/20 break-words whitespace-pre-wrap">
                    {aiError}
                </div>
            )}
            {aiEnabled && aiBreakdownSteps && (
                <div className="border border-border rounded-md p-2 space-y-2 text-xs">
                    <div className="text-muted-foreground">{t('ai.breakdownTitle')}</div>
                    <div className="space-y-1">
                        {aiBreakdownSteps.map((step, index) => (
                            <div key={`${step}-${index}`} className="text-foreground">
                                {index + 1}. {step}
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={onAddBreakdownSteps}
                            className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                        >
                            {t('ai.addSteps')}
                        </button>
                        <button
                            type="button"
                            onClick={onDismissBreakdown}
                            className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            )}
            {aiEnabled && aiClarifyResponse && (
                <div className="border border-border rounded-md p-2 space-y-2 text-xs">
                    <div className="text-muted-foreground">{aiClarifyResponse.question}</div>
                    <div className="flex flex-wrap gap-2">
                        {aiClarifyResponse.options.map((option) => (
                            <button
                                key={option.label}
                                type="button"
                                onClick={() => onSelectClarifyOption(option.action)}
                                className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                            >
                                {option.label}
                            </button>
                        ))}
                        {aiClarifyResponse.suggestedAction?.title && (
                            <button
                                type="button"
                                onClick={onApplyAISuggestion}
                                className="px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                            >
                                {t('ai.applySuggestion')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onDismissClarify}
                            className="px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                        >
                            {t('common.cancel')}
                        </button>
                    </div>
                </div>
            )}
            <div className="flex flex-wrap gap-4">
                {showAreaField && (
                    <div className="flex flex-col gap-1 flex-1 min-w-0">
                        <label className={taskEditorLabelClassName}>{t('taskEdit.areaLabel')}</label>
                        <AreaSelector
                            areas={sortedAreas}
                            value={editAreaId}
                            onChange={setEditAreaId}
                            onCreateArea={onCreateArea}
                            placeholder={t('taskEdit.noAreaOption')}
                            noAreaLabel={t('taskEdit.noAreaOption')}
                            searchPlaceholder={t('areas.search')}
                            noMatchesLabel={t('common.noMatches')}
                            createAreaLabel={t('areas.create')}
                            className="w-full"
                        />
                    </div>
                )}
                {showProjectField && (
                    <div className="flex flex-col gap-1 flex-1 min-w-0">
                        <label className={taskEditorLabelClassName}>{t('projects.title')}</label>
                        <ProjectSelector
                            projects={filteredProjects}
                            allProjects={sortedProjects}
                            value={editProjectId}
                            onChange={setEditProjectId}
                            onCreateProject={(title) => onCreateProject(title, projectFilterAreaId)}
                            placeholder={t('taskEdit.noProjectOption')}
                            noProjectLabel={t('taskEdit.noProjectOption')}
                            searchPlaceholder={t('projects.search')}
                            noMatchesLabel={t('common.noMatches')}
                            emptyLabel={projectFilterAreaId ? t('projects.noProjectsInArea') : undefined}
                            createProjectLabel={t('projects.create')}
                            className="w-full"
                        />
                    </div>
                )}
                {showSectionField && (
                    <div className="flex flex-col gap-1 flex-1 min-w-0">
                        <label className={taskEditorLabelClassName}>{t('taskEdit.sectionLabel')}</label>
                        <SectionSelector
                            sections={sections}
                            value={editSectionId}
                            onChange={setEditSectionId}
                            onCreateSection={onCreateSection}
                            placeholder={t('taskEdit.noSectionOption')}
                            noSectionLabel={t('taskEdit.noSectionOption')}
                            searchPlaceholder={t('sections.search')}
                            noMatchesLabel={t('common.noMatches')}
                            createSectionLabel={t('projects.addSection')}
                            className="w-full"
                        />
                    </div>
                )}
            </div>
            {basicFields.length > 0 && (
                <div className="space-y-3">
                    {basicFields.map((fieldId) => (
                        <div key={fieldId}>{renderField(fieldId)}</div>
                    ))}
                </div>
            )}
            <div className="space-y-3">
                {schedulingFields.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <button
                            type="button"
                            onClick={() => setSchedulingOpen((prev) => !prev)}
                            className="w-full flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground font-semibold"
                            aria-expanded={schedulingOpen}
                        >
                            <span className="flex items-center gap-2">
                                {t('taskEdit.scheduling')}
                                {sectionCounts.scheduling > 0 && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                        {sectionCounts.scheduling}
                                    </span>
                                )}
                            </span>
                            {schedulingOpen ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
                        </button>
                        {schedulingOpen && (
                            <div className="mt-3 space-y-3">
                                {schedulingFields.map((fieldId) => (
                                    <div key={fieldId}>{renderField(fieldId)}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {organizationFields.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <button
                            type="button"
                            onClick={() => setOrganizationOpen((prev) => !prev)}
                            className="w-full flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground font-semibold"
                            aria-expanded={organizationOpen}
                        >
                            <span className="flex items-center gap-2">
                                {t('taskEdit.organization')}
                                {sectionCounts.organization > 0 && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                        {sectionCounts.organization}
                                    </span>
                                )}
                            </span>
                            {organizationOpen ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
                        </button>
                        {organizationOpen && (
                            <div className="mt-3 space-y-3">
                                {organizationFields.map((fieldId) => (
                                    <div key={fieldId}>{renderField(fieldId)}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
                {detailsFields.length > 0 && (
                    <div className="border-t border-border pt-3">
                        <button
                            type="button"
                            onClick={() => setDetailsOpen((prev) => !prev)}
                            className="w-full flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground font-semibold"
                            aria-expanded={detailsOpen}
                        >
                            <span className="flex items-center gap-2">
                                {t('taskEdit.details')}
                                {sectionCounts.details > 0 && (
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                        {sectionCounts.details}
                                    </span>
                                )}
                            </span>
                            {detailsOpen ? <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
                        </button>
                        {detailsOpen && (
                            <div className="mt-3 space-y-3">
                                {detailsFields.map((fieldId) => (
                                    <div key={fieldId}>{renderField(fieldId)}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
                <div className="relative">
                    <button
                        type="button"
                        aria-label={taskEditorLayoutHelpLabel}
                        aria-expanded={editorLayoutHelpOpen}
                        title={taskEditorLayoutHelpLabel}
                        onClick={() => setEditorLayoutHelpOpen((open) => !open)}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    {editorLayoutHelpOpen && (
                        <div
                            role="note"
                            className="absolute bottom-9 left-0 z-30 w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-lg"
                        >
                            {taskEditorLayoutHelpText}
                        </div>
                    )}
                </div>
                {onDeleteTask && (
                    <button
                        type="button"
                        onClick={onDeleteTask}
                        className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
                    >
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                        {t('common.delete')}
                    </button>
                )}
                <div className="flex flex-wrap gap-2 ml-auto">
                    <button
                        type="button"
                        onClick={onDuplicateTask}
                        className="text-xs px-3 py-1.5 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                    >
                        {t('taskEdit.duplicateTask')}
                    </button>
                    <button
                        type="submit"
                        className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded hover:bg-primary/90"
                    >
                        {t('common.save')}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        className="text-xs bg-muted text-muted-foreground px-3 py-1.5 rounded hover:bg-muted/80"
                    >
                        {t('common.cancel')}
                    </button>
                </div>
            </div>
        </form>
    );
}
