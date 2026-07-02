import { type ClipboardEvent, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { Loader2, Maximize2, Mic, Square } from 'lucide-react';
import { tFallback, type MarkdownSelection, type MarkdownToolbarActionId, type MarkdownToolbarResult } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { ExpandedMarkdownEditor } from '../../ExpandedMarkdownEditor';
import { MarkdownFormatToolbar } from '../../MarkdownFormatToolbar';
import { MarkdownReferenceAutocompleteMenu, useMarkdownReferenceAutocomplete } from '../../MarkdownReferenceAutocomplete';
import { RichMarkdown } from '../../RichMarkdown';
import { AutosizeTextarea } from '../../ui/AutosizeTextarea';
import { taskEditorLabelClassName } from '../task-editor-label';

type DescriptionAudioState = 'idle' | 'recording' | 'transcribing';

type DescriptionFieldProps = {
    t: (key: string) => string;
    taskTitle?: string;
    taskId: string;
    showDescriptionPreview: boolean;
    editDescription: string;
    isRtl: boolean;
    resolvedDirection: 'ltr' | 'rtl';
    descriptionExpanded: boolean;
    descriptionUndoDepth: number;
    descriptionTextareaRef: RefObject<HTMLTextAreaElement | null>;
    descriptionSelection: MarkdownSelection;
    descriptionAutocomplete: ReturnType<typeof useMarkdownReferenceAutocomplete>;
    descriptionAudioState: DescriptionAudioState;
    descriptionAudioError: string | null;
    onTogglePreview: () => void;
    onEditFromPreview: (source?: HTMLElement) => void;
    onExpand: () => void;
    onCloseExpanded: () => void;
    onDescriptionInput: (value: string, selection: MarkdownSelection, source: HTMLTextAreaElement) => void;
    onDescriptionChange: (
        value: string,
        options?: {
            nextSelection?: MarkdownSelection;
            recordUndo?: boolean;
            baseSelection?: MarkdownSelection;
        },
    ) => void;
    onSelectionChange: (selection: MarkdownSelection) => void;
    onUndo: () => MarkdownSelection | undefined;
    onApplyAction: (actionId: MarkdownToolbarActionId, selection: MarkdownSelection) => MarkdownToolbarResult;
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    onDescriptionAudioInput: () => void;
};

export function DescriptionField({
    t,
    taskTitle,
    taskId,
    showDescriptionPreview,
    editDescription,
    isRtl,
    resolvedDirection,
    descriptionExpanded,
    descriptionUndoDepth,
    descriptionTextareaRef,
    descriptionSelection,
    descriptionAutocomplete,
    descriptionAudioState,
    descriptionAudioError,
    onTogglePreview,
    onEditFromPreview,
    onExpand,
    onCloseExpanded,
    onDescriptionInput,
    onDescriptionChange,
    onSelectionChange,
    onUndo,
    onApplyAction,
    onKeyDown,
    onPaste,
    onDescriptionAudioInput,
}: DescriptionFieldProps) {
    const handlePreviewClick = (event: MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (target?.closest('a, button, input, textarea, select, label')) return;
        onEditFromPreview(event.currentTarget);
    };
    const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onEditFromPreview(event.currentTarget);
    };
    const descriptionAudioLabel = descriptionAudioState === 'recording'
        ? tFallback(t, 'taskEdit.descriptionAudioStop', 'Stop dictation')
        : tFallback(t, 'taskEdit.descriptionAudio', 'Dictate description');

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <label className={taskEditorLabelClassName}>{t('taskEdit.descriptionLabel')}</label>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onDescriptionAudioInput}
                        disabled={descriptionAudioState === 'transcribing'}
                        className={cn(
                            'rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60',
                            descriptionAudioState === 'recording' && 'text-red-500 hover:text-red-500'
                        )}
                        aria-label={descriptionAudioLabel}
                        title={descriptionAudioLabel}
                    >
                        {descriptionAudioState === 'transcribing' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : descriptionAudioState === 'recording' ? (
                            <Square className="h-4 w-4 fill-current" />
                        ) : (
                            <Mic className="h-4 w-4" />
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={onTogglePreview}
                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors text-muted-foreground"
                    >
                        {showDescriptionPreview ? t('markdown.edit') : t('markdown.preview')}
                    </button>
                    <button
                        type="button"
                        onClick={onExpand}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={t('markdown.expand')}
                    >
                        <Maximize2 className="h-4 w-4" />
                    </button>
                </div>
            </div>
            {showDescriptionPreview ? (
                <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${t('markdown.edit')} ${t('taskEdit.descriptionLabel')}`}
                    onClick={handlePreviewClick}
                    onKeyDown={handlePreviewKeyDown}
                    className={cn(
                        'w-full cursor-text text-left text-sm leading-6 bg-muted/30 border border-border rounded px-3 py-2 transition-[border-color,box-shadow] hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40',
                        isRtl && 'text-right'
                    )}
                    dir={resolvedDirection}
                >
                    <RichMarkdown markdown={editDescription || ''} />
                </div>
            ) : (
                <div className="relative flex flex-col gap-2">
                    <MarkdownFormatToolbar
                        textareaRef={descriptionTextareaRef}
                        t={t}
                        canUndo={descriptionUndoDepth > 0}
                        onUndo={onUndo}
                        onApplyAction={onApplyAction}
                    />
                    <AutosizeTextarea
                        ref={descriptionTextareaRef}
                        aria-label={t('task.aria.description')}
                        value={editDescription}
                        onChange={(event) => {
                            onDescriptionInput(event.target.value, {
                                start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                            }, event.currentTarget);
                        }}
                        onSelect={(event) => {
                            onSelectionChange({
                                start: event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                                end: event.currentTarget.selectionEnd ?? event.currentTarget.value.length,
                            });
                        }}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        minHeight={112}
                        maxHeight={480}
                        className={cn(
                            'w-full text-sm leading-6 bg-muted/50 border border-border rounded px-3 py-2 resize-none transition-[border-color,box-shadow] focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40',
                            isRtl && 'text-right'
                        )}
                        placeholder={t('taskEdit.descriptionPlaceholder')}
                        spellCheck={true}
                        dir={resolvedDirection}
                    />
                    <MarkdownReferenceAutocompleteMenu
                        isOpen={descriptionAutocomplete.isOpen}
                        suggestions={descriptionAutocomplete.suggestions}
                        selectedIndex={descriptionAutocomplete.selectedIndex}
                        setSelectedIndex={descriptionAutocomplete.setSelectedIndex}
                        applySuggestion={descriptionAutocomplete.applySuggestion}
                        menuRef={descriptionAutocomplete.menuRef}
                        position={descriptionAutocomplete.position}
                        t={t}
                    />
                </div>
            )}
            {descriptionAudioError ? (
                <p className="text-xs text-red-500">{descriptionAudioError}</p>
            ) : null}
            <ExpandedMarkdownEditor
                isOpen={descriptionExpanded}
                onClose={onCloseExpanded}
                value={editDescription}
                onChange={onDescriptionChange}
                title={t('taskEdit.descriptionLabel')}
                headerTitle={taskTitle?.trim() || t('taskEdit.descriptionLabel')}
                placeholder={t('taskEdit.descriptionPlaceholder')}
                t={t}
                initialMode="edit"
                direction={resolvedDirection}
                selection={descriptionSelection}
                canUndo={descriptionUndoDepth > 0}
                onUndo={onUndo}
                onApplyAction={onApplyAction}
                onSelectionChange={onSelectionChange}
                onEditorKeyDown={onKeyDown}
                onEditorPaste={onPaste}
                currentTaskId={taskId}
            />
        </div>
    );
}
