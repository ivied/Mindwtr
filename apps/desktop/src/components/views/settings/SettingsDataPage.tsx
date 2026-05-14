import { AttachmentsCleanupSection } from './sync/AttachmentsCleanupSection';
import { DataTransferSection } from './sync/DataTransferSection';
import { DiagnosticsSection } from './sync/DiagnosticsSection';
import type { SettingsSyncPageProps } from './sync/types';

type SettingsDataPageProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'isTauri'
    | 'analyticsHeartbeatAvailable'
    | 'analyticsHeartbeatEnabled'
    | 'loggingEnabled'
    | 'logPath'
    | 'onAnalyticsHeartbeatChange'
    | 'onToggleLogging'
    | 'onClearLog'
    | 'transferAction'
    | 'onExportBackup'
    | 'onRestoreBackup'
    | 'onImportTodoist'
    | 'onImportDgt'
    | 'onImportOmniFocus'
    | 'attachmentsLastCleanupDisplay'
    | 'pendingRemoteDeleteCount'
    | 'onClearPendingRemoteDeletes'
    | 'onRunAttachmentsCleanup'
    | 'isCleaningAttachments'
>;

export function SettingsDataPage(props: SettingsDataPageProps) {
    return (
        <div className="space-y-8">
            <DataTransferSection
                t={props.t}
                transferAction={props.transferAction}
                onExportBackup={props.onExportBackup}
                onRestoreBackup={props.onRestoreBackup}
                onImportTodoist={props.onImportTodoist}
                onImportDgt={props.onImportDgt}
                onImportOmniFocus={props.onImportOmniFocus}
            />
            <AttachmentsCleanupSection
                t={props.t}
                isTauri={props.isTauri}
                attachmentsLastCleanupDisplay={props.attachmentsLastCleanupDisplay}
                pendingRemoteDeleteCount={props.pendingRemoteDeleteCount}
                onClearPendingRemoteDeletes={props.onClearPendingRemoteDeletes}
                onRunAttachmentsCleanup={props.onRunAttachmentsCleanup}
                isCleaningAttachments={props.isCleaningAttachments}
            />
            {props.isTauri && (
                <DiagnosticsSection
                    t={props.t}
                    analyticsHeartbeatAvailable={props.analyticsHeartbeatAvailable}
                    analyticsHeartbeatEnabled={props.analyticsHeartbeatEnabled}
                    loggingEnabled={props.loggingEnabled}
                    logPath={props.logPath}
                    onAnalyticsHeartbeatChange={props.onAnalyticsHeartbeatChange}
                    onToggleLogging={props.onToggleLogging}
                    onClearLog={props.onClearLog}
                />
            )}
        </div>
    );
}
