import type { ExternalCalendarSubscription } from '@mindwtr/core';
import type { SystemCalendarPermissionStatus } from '../../../lib/system-calendar';

import { SettingsCalendarPage } from './SettingsCalendarPage';
import { SettingsObsidianSection } from './SettingsObsidianSection';

type Labels = {
    calendar: string;
    calendarDesc: string;
    calendarName: string;
    calendarUrl: string;
    calendarAdd: string;
    calendarChooseLocalFile: string;
    calendarRemove: string;
    externalCalendars: string;
    calendarSystemTitle: string;
    calendarSystemDesc: string;
    calendarSystemStatus: string;
    calendarSystemPermissionGranted: string;
    calendarSystemPermissionUndetermined: string;
    calendarSystemPermissionDenied: string;
    calendarSystemPermissionUnsupported: string;
    calendarSystemRequestAccess: string;
    calendarSystemDeniedHint: string;
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

type SettingsIntegrationsPageProps = {
    t: Labels;
    isTauri: boolean;
    newCalendarName: string;
    newCalendarUrl: string;
    calendarError: string | null;
    externalCalendars: ExternalCalendarSubscription[];
    showSystemCalendarSection: boolean;
    systemCalendarPermission: SystemCalendarPermissionStatus;
    onCalendarNameChange: (value: string) => void;
    onCalendarUrlChange: (value: string) => void;
    onAddCalendar: () => void;
    onChooseLocalCalendarFile: () => Promise<void> | void;
    onToggleCalendar: (id: string, enabled: boolean) => void;
    onRemoveCalendar: (id: string) => void;
    onRequestSystemCalendarPermission: () => void;
    maskCalendarUrl: (url: string) => string;
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

export function SettingsIntegrationsPage({
    t,
    isTauri,
    newCalendarName,
    newCalendarUrl,
    calendarError,
    externalCalendars,
    showSystemCalendarSection,
    systemCalendarPermission,
    onCalendarNameChange,
    onCalendarUrlChange,
    onAddCalendar,
    onChooseLocalCalendarFile,
    onToggleCalendar,
    onRemoveCalendar,
    onRequestSystemCalendarPermission,
    maskCalendarUrl,
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
}: SettingsIntegrationsPageProps) {
    return (
        <div className="space-y-6">
            <SettingsCalendarPage
                t={t}
                newCalendarName={newCalendarName}
                newCalendarUrl={newCalendarUrl}
                calendarError={calendarError}
                externalCalendars={externalCalendars}
                showSystemCalendarSection={showSystemCalendarSection}
                systemCalendarPermission={systemCalendarPermission}
                onCalendarNameChange={onCalendarNameChange}
                onCalendarUrlChange={onCalendarUrlChange}
                onAddCalendar={onAddCalendar}
                onChooseLocalCalendarFile={isTauri ? onChooseLocalCalendarFile : undefined}
                onToggleCalendar={onToggleCalendar}
                onRemoveCalendar={onRemoveCalendar}
                onRequestSystemCalendarPermission={onRequestSystemCalendarPermission}
                maskCalendarUrl={maskCalendarUrl}
            />

            <SettingsObsidianSection
                t={t}
                isTauri={isTauri}
                obsidianVaultPath={obsidianVaultPath}
                obsidianEnabled={obsidianEnabled}
                obsidianScanFoldersText={obsidianScanFoldersText}
                obsidianInboxFile={obsidianInboxFile}
                obsidianTaskNotesIncludeArchived={obsidianTaskNotesIncludeArchived}
                obsidianNewTaskFormat={obsidianNewTaskFormat}
                obsidianLastScannedAt={obsidianLastScannedAt}
                obsidianHasVaultMarker={obsidianHasVaultMarker}
                obsidianVaultWarning={obsidianVaultWarning}
                obsidianIsWatching={obsidianIsWatching}
                obsidianWatcherError={obsidianWatcherError}
                isSavingObsidian={isSavingObsidian}
                isScanningObsidian={isScanningObsidian}
                onObsidianVaultPathChange={onObsidianVaultPathChange}
                onObsidianEnabledChange={onObsidianEnabledChange}
                onObsidianScanFoldersTextChange={onObsidianScanFoldersTextChange}
                onObsidianInboxFileChange={onObsidianInboxFileChange}
                onObsidianTaskNotesIncludeArchivedChange={onObsidianTaskNotesIncludeArchivedChange}
                onObsidianNewTaskFormatChange={onObsidianNewTaskFormatChange}
                onBrowseObsidianVault={onBrowseObsidianVault}
                onSaveObsidian={onSaveObsidian}
                onRemoveObsidian={onRemoveObsidian}
                onRescanObsidian={onRescanObsidian}
            />
        </div>
    );
}
