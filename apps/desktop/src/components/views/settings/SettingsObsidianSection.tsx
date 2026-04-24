import { useState } from 'react';
import { safeFormatDate } from '@mindwtr/core';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '../../../lib/utils';

type Labels = {
    obsidianVault: string;
    obsidianVaultDesc: string;
    obsidianEnable: string;
    obsidianVaultPath: string;
    obsidianVaultPathHint: string;
    obsidianScanFolders: string;
    obsidianScanFoldersHint: string;
    obsidianInboxFile: string;
    obsidianInboxFileHint: string;
    obsidianTaskNotes: string;
    obsidianTaskNotesDesc: string;
    obsidianTaskNotesIncludeArchived: string;
    obsidianTaskNotesIncludeArchivedHint: string;
    obsidianNewTaskFormat: string;
    obsidianNewTaskFormatHint: string;
    obsidianNewTaskFormatAuto: string;
    obsidianNewTaskFormatInline: string;
    obsidianNewTaskFormatTaskNotes: string;
    obsidianWatching: string;
    obsidianWatcherUnavailable: string;
    obsidianSave: string;
    obsidianRemove: string;
    obsidianRescan: string;
    obsidianRescanning: string;
    obsidianLastScanned: string;
    obsidianNeverScanned: string;
    obsidianMissingMarker: string;
    browse: string;
};

type SettingsObsidianSectionProps = {
    t: Labels;
    isTauri: boolean;
    obsidianVaultPath: string;
    obsidianEnabled: boolean;
    obsidianScanFoldersText: string;
    obsidianInboxFile: string;
    obsidianTaskNotesIncludeArchived: boolean;
    obsidianNewTaskFormat: 'auto' | 'inline' | 'tasknotes';
    obsidianLastScannedAt: string | null;
    obsidianHasVaultMarker: boolean | null;
    obsidianVaultWarning: string | null;
    obsidianIsWatching: boolean;
    obsidianWatcherError: string | null;
    isSavingObsidian: boolean;
    isScanningObsidian: boolean;
    onObsidianVaultPathChange: (value: string) => void;
    onObsidianEnabledChange: (value: boolean) => void;
    onObsidianScanFoldersTextChange: (value: string) => void;
    onObsidianInboxFileChange: (value: string) => void;
    onObsidianTaskNotesIncludeArchivedChange: (value: boolean) => void;
    onObsidianNewTaskFormatChange: (value: 'auto' | 'inline' | 'tasknotes') => void;
    onBrowseObsidianVault: () => Promise<void> | void;
    onSaveObsidian: () => Promise<void> | void;
    onRemoveObsidian: () => Promise<void> | void;
    onRescanObsidian: () => Promise<void> | void;
};

export function SettingsObsidianSection({
    t,
    isTauri,
    obsidianVaultPath,
    obsidianEnabled,
    obsidianScanFoldersText,
    obsidianInboxFile,
    obsidianTaskNotesIncludeArchived,
    obsidianNewTaskFormat,
    obsidianLastScannedAt,
    obsidianHasVaultMarker,
    obsidianVaultWarning,
    obsidianIsWatching,
    obsidianWatcherError,
    isSavingObsidian,
    isScanningObsidian,
    onObsidianVaultPathChange,
    onObsidianEnabledChange,
    onObsidianScanFoldersTextChange,
    onObsidianInboxFileChange,
    onObsidianTaskNotesIncludeArchivedChange,
    onObsidianNewTaskFormatChange,
    onBrowseObsidianVault,
    onSaveObsidian,
    onRemoveObsidian,
    onRescanObsidian,
}: SettingsObsidianSectionProps) {
    const [open, setOpen] = useState(false);

    return (
        <div className="bg-card border border-border rounded-lg">
            <div className="p-4 flex items-start justify-between gap-4">
                <button
                    type="button"
                    onClick={() => setOpen((prev) => !prev)}
                    aria-expanded={open}
                    className="flex-1 text-left flex items-center justify-between gap-4"
                >
                    <div className="min-w-0">
                        <div className="text-sm font-medium">{t.obsidianVault}</div>
                        <p className="text-xs text-muted-foreground mt-1">{t.obsidianVaultDesc}</p>
                    </div>
                    {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>
                <button
                    type="button"
                    role="switch"
                    aria-checked={obsidianEnabled}
                    onClick={() => onObsidianEnabledChange(!obsidianEnabled)}
                    className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                        obsidianEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border",
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                            obsidianEnabled ? "translate-x-4" : "translate-x-1",
                        )}
                    />
                </button>
            </div>
            {open && (
                <div className="border-t border-border p-4 space-y-4">
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">{t.obsidianVaultPath}</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={obsidianVaultPath}
                                onChange={(event) => onObsidianVaultPathChange(event.target.value)}
                                placeholder="/path/to/your/Obsidian/vault"
                                className="flex-1 bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                            <button
                                type="button"
                                onClick={onBrowseObsidianVault}
                                disabled={!isTauri}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t.browse}
                            </button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t.obsidianVaultPathHint}</p>
                        {obsidianVaultWarning && (
                            <p className="text-xs text-amber-600">
                                {obsidianHasVaultMarker === false ? t.obsidianMissingMarker : obsidianVaultWarning}
                            </p>
                        )}
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">{t.obsidianScanFolders}</label>
                        <textarea
                            value={obsidianScanFoldersText}
                            onChange={(event) => onObsidianScanFoldersTextChange(event.target.value)}
                            rows={3}
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            placeholder={'/\nProjects\nDaily'}
                        />
                        <p className="text-xs text-muted-foreground">{t.obsidianScanFoldersHint}</p>
                    </div>

                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">{t.obsidianInboxFile}</label>
                        <input
                            type="text"
                            value={obsidianInboxFile}
                            onChange={(event) => onObsidianInboxFileChange(event.target.value)}
                            placeholder="Mindwtr/Inbox.md"
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <p className="text-xs text-muted-foreground">{t.obsidianInboxFileHint}</p>
                    </div>

                    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
                        <div className="space-y-1">
                            <div className="text-sm font-medium">{t.obsidianTaskNotes}</div>
                            <p className="text-xs text-muted-foreground">{t.obsidianTaskNotesDesc}</p>
                        </div>

                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-sm font-medium">{t.obsidianTaskNotesIncludeArchived}</p>
                                <p className="text-xs text-muted-foreground">{t.obsidianTaskNotesIncludeArchivedHint}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={obsidianTaskNotesIncludeArchived}
                                onClick={() => onObsidianTaskNotesIncludeArchivedChange(!obsidianTaskNotesIncludeArchived)}
                                className={cn(
                                    'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                                    obsidianTaskNotesIncludeArchived ? 'bg-primary border-primary' : 'bg-muted/50 border-border',
                                )}
                            >
                                <span
                                    className={cn(
                                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                        obsidianTaskNotesIncludeArchived ? 'translate-x-4' : 'translate-x-1',
                                    )}
                                />
                            </button>
                        </div>

                        <div className="flex flex-col gap-2">
                            <label className="text-sm font-medium">{t.obsidianNewTaskFormat}</label>
                            <select
                                value={obsidianNewTaskFormat}
                                onChange={(event) => onObsidianNewTaskFormatChange(event.target.value as 'auto' | 'inline' | 'tasknotes')}
                                className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            >
                                <option value="auto">{t.obsidianNewTaskFormatAuto}</option>
                                <option value="inline">{t.obsidianNewTaskFormatInline}</option>
                                <option value="tasknotes">{t.obsidianNewTaskFormatTaskNotes}</option>
                            </select>
                            <p className="text-xs text-muted-foreground">{t.obsidianNewTaskFormatHint}</p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                                {t.obsidianLastScanned}:{' '}
                                <span className="font-medium text-foreground">
                                    {obsidianLastScannedAt ? safeFormatDate(obsidianLastScannedAt, 'PPpp', obsidianLastScannedAt) : t.obsidianNeverScanned}
                                </span>
                            </p>
                            {obsidianWatcherError ? (
                                <p className="text-xs text-amber-600">
                                    {t.obsidianWatcherUnavailable} {obsidianWatcherError}
                                </p>
                            ) : obsidianIsWatching ? (
                                <p className="text-xs text-muted-foreground">{t.obsidianWatching}</p>
                            ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={onRemoveObsidian}
                                disabled={isSavingObsidian || !obsidianVaultPath.trim()}
                                className="px-4 py-2 bg-muted text-muted-foreground rounded-md text-sm font-medium hover:bg-muted/80 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t.obsidianRemove}
                            </button>
                            <button
                                type="button"
                                onClick={onRescanObsidian}
                                disabled={isScanningObsidian || !obsidianEnabled || !obsidianVaultPath.trim()}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isScanningObsidian ? t.obsidianRescanning : t.obsidianRescan}
                            </button>
                            <button
                                type="button"
                                onClick={onSaveObsidian}
                                disabled={isSavingObsidian}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                            >
                                {t.obsidianSave}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
