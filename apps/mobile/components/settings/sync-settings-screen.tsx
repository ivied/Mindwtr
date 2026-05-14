import React, { useCallback, useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
    useTaskStore,
} from '@mindwtr/core';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useToast } from '@/contexts/toast-context';
import { isCloudKitAvailable } from '@/lib/cloudkit-sync';
import {
    listLocalDataSnapshots,
} from '@/lib/data-transfer';
import { getDropboxRedirectUri } from '@/lib/dropbox-oauth';
import {
    isDropboxClientConfigured,
} from '@/lib/dropbox-auth';
import {
    formatClockSkew,
    logSettingsError,
} from '@/lib/settings-utils';
import {
    classifySyncFailure,
} from '@/lib/sync-service-utils';
import {
    isMobileAnalyticsHeartbeatConfigured,
    resetMobileAnalyticsOptOutMarker,
    sendMobileAnalyticsOptOut,
} from '@/lib/analytics-heartbeat';

import { MobileExtraConfig } from './settings.constants';
import { AppleRemindersImportSection } from './apple-reminders-import-section';
import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SyncCloudKitBackendPanel } from './sync-settings-cloudkit-panel';
import { SyncDropboxBackendPanel } from './sync-settings-dropbox-panel';
import { SyncFileBackendPanel } from './sync-settings-file-panel';
import {
    BackgroundSyncInfoCard,
    RecoverySnapshotsCard,
    SyncBackupSection,
    SyncDiagnosticsCard,
    SyncLastStatusCard,
    SyncPreferencesCard,
} from './sync-settings-sections';
import { SyncSelfHostedBackendPanel } from './sync-settings-selfhosted-panel';
import { SyncWebDavBackendPanel } from './sync-settings-webdav-panel';
import { useSyncSettingsBackupActions } from './use-sync-settings-backup-actions';
import { useSyncSettingsTransportActions, type CloudKitAccountStatus } from './use-sync-settings-transport-actions';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

type SettingsScreenMode = 'sync' | 'data';

function SyncSettingsView({ mode }: { mode: SettingsScreenMode }) {
    const tc = useThemeColors();
    const { showToast } = useToast();
    const { tr, t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const {
        tasks,
        projects,
        sections,
        areas,
        settings,
        addTask,
        updateSettings,
    } = useTaskStore();
    const extraConfig = Constants.expoConfig?.extra as MobileExtraConfig | undefined;
    const isFossBuild = extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
    const analyticsHeartbeatUrl = typeof extraConfig?.analyticsHeartbeatUrl === 'string'
        ? extraConfig.analyticsHeartbeatUrl.trim()
        : '';
    const appVersion = Constants.expoConfig?.version ?? '0.0.0';
    const dropboxAppKey = typeof extraConfig?.dropboxAppKey === 'string' ? extraConfig.dropboxAppKey.trim() : '';
    const dropboxConfigured = !isFossBuild && isDropboxClientConfigured(dropboxAppKey);
    const isExpoGo = Constants.appOwnership === 'expo';
    const supportsNativeICloudSync = Platform.OS === 'ios' && isCloudKitAvailable();
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryExpanded, setSyncHistoryExpanded] = useState(false);
    const [backupAction, setBackupAction] = useState<null | 'export' | 'restore' | 'import' | 'snapshot'>(null);
    const [recoverySnapshots, setRecoverySnapshots] = useState<string[]>([]);
    const [recoverySnapshotsOpen, setRecoverySnapshotsOpen] = useState(false);
    const [isLoadingRecoverySnapshots, setIsLoadingRecoverySnapshots] = useState(false);
    const { refreshSyncBadgeConfig } = useMobileSyncBadge();

    const syncPreferences = settings.syncPreferences ?? {};
    const syncAppearanceEnabled = syncPreferences.appearance === true;
    const syncLanguageEnabled = syncPreferences.language === true;
    const syncGtdEnabled = syncPreferences.gtd === true;
    const syncSavedFiltersEnabled = syncPreferences.savedFilters === true;
    const syncExternalCalendarsEnabled = syncPreferences.externalCalendars === true;
    const syncAiEnabled = syncPreferences.ai === true;
    const syncHistory = settings.lastSyncHistory ?? [];
    const syncHistoryEntries = syncHistory.slice(0, 5);
    const lastSyncStats = settings.lastSyncStats ?? null;
    const showLastSyncStats = Boolean(lastSyncStats) && (settings.lastSyncStatus === 'success' || settings.lastSyncStatus === 'conflict');
    const syncConflictCount = (lastSyncStats?.tasks.conflicts || 0) + (lastSyncStats?.projects.conflicts || 0);
    const maxClockSkewMs = Math.max(lastSyncStats?.tasks.maxClockSkewMs || 0, lastSyncStats?.projects.maxClockSkewMs || 0);
    const timestampAdjustments = (lastSyncStats?.tasks.timestampAdjustments || 0) + (lastSyncStats?.projects.timestampAdjustments || 0);
    const conflictIds = [
        ...(lastSyncStats?.tasks.conflictIds ?? []),
        ...(lastSyncStats?.projects.conflictIds ?? []),
    ].slice(0, 6);
    const loggingEnabled = settings.diagnostics?.loggingEnabled === true;
    const analyticsHeartbeatAvailable = isMobileAnalyticsHeartbeatConfigured({
        analyticsHeartbeatUrl,
        isExpoGo,
        isFossBuild,
    });
    const analyticsHeartbeatEnabled = analyticsHeartbeatAvailable && settings.analytics?.heartbeatEnabled !== false;
    const pendingRemoteDeleteCount = settings.attachments?.pendingRemoteDeletes?.length ?? 0;
    const isBackupBusy = backupAction !== null;
    const backendOptions: ('off' | 'file' | 'webdav' | 'cloud')[] = ['off', 'file', 'webdav', 'cloud'];
    const showSettingsWarning = useCallback((title: string, message: string, durationMs = 4200) => {
        showToast({
            title,
            message,
            tone: 'warning',
            durationMs,
        });
    }, [showToast]);
    const showSettingsErrorToast = useCallback((title: string, message: string, durationMs = 4200) => {
        showToast({
            title,
            message,
            tone: 'error',
            durationMs,
        });
    }, [showToast]);
    const getSyncFailureToastMessage = useCallback((error: unknown) => {
        switch (classifySyncFailure(error)) {
            case 'offline':
                return t('settings.syncFailureOffline');
            case 'auth':
                return t('settings.syncFailureAuth');
            case 'permission':
                return t('settings.syncFailurePermission');
            case 'rateLimited':
                return t('settings.syncFailureRateLimited');
            case 'misconfigured':
                return t('settings.syncFailureMisconfigured');
            case 'conflict':
                return t('settings.syncFailureConflict');
            default:
                return t('settings.syncFailureGeneric');
        }
    }, [t]);

    const resetSyncStatusForBackendSwitch = useCallback(() => {
        updateSettings({
            lastSyncStatus: 'idle',
            lastSyncError: undefined,
        }).catch(logSettingsError);
    }, [updateSettings]);

    const updateSyncPreferences = (partial: Partial<NonNullable<typeof settings.syncPreferences>>) => {
        updateSettings({ syncPreferences: { ...syncPreferences, ...partial } }).catch(logSettingsError);
    };

    const handleClearPendingRemoteDeletes = useCallback(() => {
        if (pendingRemoteDeleteCount === 0) return;
        Alert.alert(
            tr('settings.syncMobile.clearPendingAttachmentDeletes'),
            tr('settings.syncMobile.onlyClearTheseIfYouNoLongerWantMindwtrTo'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: tr('filters.clear'),
                    style: 'destructive',
                    onPress: () => {
                        updateSettings({
                            attachments: {
                                ...(settings.attachments ?? {}),
                                pendingRemoteDeletes: undefined,
                            },
                        }).catch(logSettingsError);
                    },
                },
            ],
        );
    }, [tr, pendingRemoteDeleteCount, settings.attachments, t, updateSettings]);

    const toggleAnalyticsHeartbeat = useCallback((enabled: boolean) => {
        if (!analyticsHeartbeatAvailable) return;
        const saveSetting = () => {
            updateSettings({
                analytics: {
                    ...(settings.analytics ?? {}),
                    heartbeatEnabled: enabled,
                },
            })
                .then(async () => {
                    if (enabled) {
                        await resetMobileAnalyticsOptOutMarker();
                        return;
                    }
                    await sendMobileAnalyticsOptOut({
                        analyticsHeartbeatUrl,
                        appVersion,
                        isExpoGo,
                        isFossBuild,
                    });
                })
                .catch(logSettingsError);
        };

        if (enabled) {
            saveSetting();
            return;
        }

        Alert.alert(
            t('settings.analyticsHeartbeatDisableTitle'),
            t('settings.analyticsHeartbeatDisableDesc'),
            [
                { text: t('settings.analyticsHeartbeatKeepEnabled'), style: 'cancel' },
                {
                    text: t('settings.analyticsHeartbeatDisableConfirm'),
                    style: 'destructive',
                    onPress: saveSetting,
                },
            ],
        );
    }, [
        analyticsHeartbeatAvailable,
        analyticsHeartbeatUrl,
        appVersion,
        isExpoGo,
        isFossBuild,
        settings.analytics,
        t,
        updateSettings,
    ]);

    const refreshRecoverySnapshots = useCallback(async () => {
        setIsLoadingRecoverySnapshots(true);
        try {
            setRecoverySnapshots(await listLocalDataSnapshots());
        } catch (error) {
            logSettingsError(error);
        } finally {
            setIsLoadingRecoverySnapshots(false);
        }
    }, []);

    useEffect(() => {
        void refreshRecoverySnapshots();
    }, [refreshRecoverySnapshots]);

    const renderSyncHistory = () => {
        if (syncHistoryEntries.length === 0) return null;
        return (
            <View style={{ marginTop: 6 }}>
                <TouchableOpacity onPress={() => setSyncHistoryExpanded((value) => !value)} activeOpacity={0.7}>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText, fontWeight: '600' }]}>
                        {t('settings.syncHistory')} ({syncHistoryEntries.length}) {syncHistoryExpanded ? '▾' : '▸'}
                    </Text>
                </TouchableOpacity>
                {syncHistoryExpanded && syncHistoryEntries.map((entry) => {
                    const statusLabel = entry.status === 'success'
                        ? t('settings.lastSyncSuccess')
                        : entry.status === 'conflict'
                            ? t('settings.lastSyncConflict')
                            : t('settings.lastSyncError');
                    const details = [
                        entry.backend ? `${t('settings.syncHistoryBackend')}: ${entry.backend}` : null,
                        entry.type ? `${t('settings.syncHistoryType')}: ${entry.type}` : null,
                        entry.conflicts ? `${t('settings.lastSyncConflicts')}: ${entry.conflicts}` : null,
                        entry.maxClockSkewMs > 0 ? `${t('settings.lastSyncSkew')}: ${formatClockSkew(entry.maxClockSkewMs)}` : null,
                        entry.timestampAdjustments > 0 ? `${t('settings.lastSyncAdjusted')}: ${entry.timestampAdjustments}` : null,
                        entry.details ? `${t('settings.syncHistoryDetails')}: ${entry.details}` : null,
                    ].filter(Boolean);
                    return (
                        <Text key={`${entry.at}-${entry.status}`} style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {new Date(entry.at).toLocaleString()} • {statusLabel}
                            {details.length ? ` • ${details.join(' • ')}` : ''}
                            {entry.status === 'error' && entry.error ? ` • ${entry.error}` : ''}
                        </Text>
                    );
                })}
            </View>
        );
    };

    const getCloudKitStatusDetails = useCallback((status: CloudKitAccountStatus) => {
        switch (status) {
            case 'available':
                return {
                    label: tr('settings.syncMobile.signedInToIcloud'),
                    helpText: tr('settings.syncMobile.syncsYourTasksProjectsAndAreasAcrossAppleDevicesUsing'),
                    syncEnabled: true,
                };
            case 'noAccount':
                return {
                    label: tr('settings.syncMobile.icloudSignInRequired'),
                    helpText: tr('settings.syncMobile.thisDeviceIsNotSignedIntoIcloudOpenIosSettings'),
                    syncEnabled: false,
                };
            case 'restricted':
                return {
                    label: tr('settings.syncMobile.icloudRestricted'),
                    helpText: tr('settings.syncMobile.cloudkitIsRestrictedOnThisDeviceCheckScreenTimeMdm'),
                    syncEnabled: false,
                };
            case 'temporarilyUnavailable':
                return {
                    label: tr('settings.syncMobile.icloudTemporarilyUnavailable'),
                    helpText: tr('settings.syncMobile.icloudIsTemporarilyUnavailableWaitAMomentThenTapSync'),
                    syncEnabled: false,
                };
            case 'unknown':
            default:
                return {
                    label: tr('settings.syncMobile.icloudStatusUnavailable'),
                    helpText: tr('settings.syncMobile.syncsYourTasksProjectsAndAreasAcrossAppleDevicesUsing2'),
                    syncEnabled: true,
                };
        }
    }, [tr]);

    const {
        formatRecoverySnapshotLabel,
        handleBackup,
        handleClearLog,
        handleImportDgt,
        handleImportOmniFocus,
        handleImportTodoist,
        handleRestoreBackup,
        handleRestoreRecoverySnapshot,
        handleShareLog,
        toggleDebugLogging,
    } = useSyncSettingsBackupActions({
        areas,
        tr,
        projects,
        refreshRecoverySnapshots,
        sections,
        settings,
        setBackupAction,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        t,
        tasks,
        updateSettings,
    });
    const {
        cloudKitAccountStatus,
        cloudAllowInsecureHttp,
        cloudProvider,
        cloudToken,
        cloudUrl,
        dropboxBusy,
        dropboxConnected,
        handleConnectDropbox,
        handleDisconnectDropbox,
        handleSaveSelfHostedSettings,
        handleSelectCloudProvider,
        handleSelectSyncBackend,
        handleSaveWebDavSettings,
        handleSetSyncPath,
        handleSync,
        handleTestConnection,
        handleTestDropboxConnection,
        isSyncing,
        isTestingConnection,
        syncBackend,
        syncPath,
        webdavPassword,
        webdavAllowInsecureHttp,
        webdavUrl,
        webdavUsername,
    } = useSyncSettingsTransportActions({
        dropboxAppKey,
        dropboxConfigured,
        getCloudKitStatusDetails,
        getSyncFailureToastMessage,
        isExpoGo,
        isFossBuild,
        lastSyncStats,
        lastSyncStatus: settings.lastSyncStatus,
        tr,
        resetSyncStatusForBackendSwitch,
        showSettingsErrorToast,
        showSettingsWarning,
        showToast,
        supportsNativeICloudSync,
        t,
    });
    const isScheduledBackgroundSyncBackend = syncBackend === 'webdav' || syncBackend === 'cloud' || syncBackend === 'cloudkit';
    const cloudKitStatusDetails = getCloudKitStatusDetails(cloudKitAccountStatus);
    const isCloudSyncSelected = syncBackend === 'cloud' || syncBackend === 'cloudkit';
    const dataLabel = t('settings.data');

    useEffect(() => {
        void refreshSyncBadgeConfig();
    }, [
        cloudProvider,
        cloudToken,
        cloudUrl,
        refreshSyncBadgeConfig,
        settings.lastSyncAt,
        settings.lastSyncStatus,
        settings.pendingRemoteWriteAt,
        syncBackend,
        syncPath,
        webdavUrl,
    ]);

    const lastSyncCard = (
        <SyncLastStatusCard
            conflictCount={syncConflictCount}
            conflictIds={conflictIds}
            historyContent={renderSyncHistory()}
            lastSyncAt={settings.lastSyncAt}
            lastSyncError={settings.lastSyncError}
            lastSyncStatus={settings.lastSyncStatus}
            maxClockSkewLabel={maxClockSkewMs > 0 ? formatClockSkew(maxClockSkewMs) : undefined}
            showLastSyncStats={showLastSyncStats}
            t={t}
            tc={tc}
            timestampAdjustments={timestampAdjustments}
        />
    );

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={mode === 'sync' ? t('settings.sync') : dataLabel} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                {mode === 'sync' ? (
                    <>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 12 }]}>
                            <View style={styles.settingRowColumn}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.syncBackend')}</Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {syncBackend === 'off'
                                            ? t('settings.syncBackendOff')
                                            : syncBackend === 'webdav'
                                                    ? t('settings.syncBackendWebdav')
                                                    : isCloudSyncSelected
                                                        ? cloudProvider === 'cloudkit'
                                                            ? 'iCloud (CloudKit)'
                                                            : t('settings.syncBackendCloud')
                                                        : t('settings.syncBackendFile')}
                                    </Text>
                                </View>
                                <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                                    {backendOptions.map((backend) => (
                                        <TouchableOpacity
                                            key={backend}
                                            style={[
                                                styles.backendOption,
                                                {
                                                    borderColor: tc.border,
                                                    backgroundColor: (backend === 'cloud' ? isCloudSyncSelected : syncBackend === backend)
                                                        ? tc.filterBg
                                                        : 'transparent',
                                                },
                                            ]}
                                            onPress={() => {
                                                handleSelectSyncBackend(backend);
                                            }}
                                        >
                                            <Text
                                                style={[
                                                    styles.backendOptionText,
                                                    {
                                                        color: (backend === 'cloud' ? isCloudSyncSelected : syncBackend === backend)
                                                            ? tc.tint
                                                            : tc.secondaryText,
                                                    },
                                                ]}
                                            >
                                                {backend === 'off'
                                                    ? t('settings.syncBackendOff')
                                                    : backend === 'file'
                                                            ? t('settings.syncBackendFile')
                                                            : backend === 'webdav'
                                                                ? t('settings.syncBackendWebdav')
                                                                : t('settings.syncBackendCloud')}
                                            </Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            </View>
                        </View>

                        {syncBackend === 'off' && (
                            <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                <Text style={[styles.helpTitle, { color: tc.text }]}>{t('settings.syncOff')}</Text>
                                <Text style={[styles.helpText, { color: tc.secondaryText }]}>{t('settings.syncOffDesc')}</Text>
                            </View>
                        )}

                        {syncBackend === 'file' && (
                            <SyncFileBackendPanel
                                isSyncing={isSyncing}
                                lastSyncCard={lastSyncCard}
                                tr={tr}
                                onSelectFolder={() => void handleSetSyncPath()}
                                onSync={() => void handleSync({ backend: 'file' })}
                                syncPath={syncPath}
                                t={t}
                                tc={tc}
                            />
                        )}

                        {syncBackend === 'webdav' && (
                            <SyncWebDavBackendPanel
                                initialAllowInsecureHttp={webdavAllowInsecureHttp}
                                initialPassword={webdavPassword}
                                initialUrl={webdavUrl}
                                initialUsername={webdavUsername}
                                isSyncing={isSyncing}
                                isTestingConnection={isTestingConnection}
                                lastSyncCard={lastSyncCard}
                                onSave={(settings) => void handleSaveWebDavSettings(settings)}
                                onSync={(settings) => void handleSync({ backend: 'webdav', webdav: settings })}
                                onTestConnection={(settings) => void handleTestConnection('webdav', { webdav: settings })}
                                t={t}
                                tc={tc}
                            />
                        )}

                        {isCloudSyncSelected && (
                            <>
                                <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 16 }]}>{t('settings.syncBackendCloud')}</Text>
                                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                                    <View style={styles.settingRowColumn}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.cloudProvider')}</Text>
                                        <View style={[styles.backendToggle, { marginTop: 8, width: '100%' }]}>
                                            <TouchableOpacity
                                                style={[
                                                    styles.backendOption,
                                                    { borderColor: tc.border, backgroundColor: cloudProvider === 'selfhosted' ? tc.filterBg : 'transparent' },
                                                ]}
                                                onPress={() => {
                                                    handleSelectCloudProvider('selfhosted');
                                                }}
                                            >
                                                <Text style={[styles.backendOptionText, { color: cloudProvider === 'selfhosted' ? tc.tint : tc.secondaryText }]}>
                                                    {t('settings.cloudProviderSelfHosted')}
                                                </Text>
                                            </TouchableOpacity>
                                            {!isFossBuild && (
                                                <TouchableOpacity
                                                    style={[
                                                        styles.backendOption,
                                                        { borderColor: tc.border, backgroundColor: cloudProvider === 'dropbox' ? tc.filterBg : 'transparent' },
                                                    ]}
                                                    onPress={() => {
                                                        handleSelectCloudProvider('dropbox');
                                                    }}
                                                >
                                                    <Text style={[styles.backendOptionText, { color: cloudProvider === 'dropbox' ? tc.tint : tc.secondaryText }]}>
                                                        Dropbox
                                                    </Text>
                                                </TouchableOpacity>
                                            )}
                                            {supportsNativeICloudSync && (
                                                <TouchableOpacity
                                                    style={[
                                                        styles.backendOption,
                                                        { borderColor: tc.border, backgroundColor: cloudProvider === 'cloudkit' ? tc.filterBg : 'transparent' },
                                                    ]}
                                                    onPress={() => {
                                                        handleSelectCloudProvider('cloudkit');
                                                    }}
                                                >
                                                    <Text style={[styles.backendOptionText, { color: cloudProvider === 'cloudkit' ? tc.tint : tc.secondaryText }]}>
                                                        iCloud
                                                    </Text>
                                                </TouchableOpacity>
                                            )}
                                        </View>
                                    </View>
                                </View>

                                {cloudProvider === 'cloudkit' && supportsNativeICloudSync ? (
                                    <SyncCloudKitBackendPanel
                                        helpText={cloudKitStatusDetails.helpText}
                                        isSyncEnabled={cloudKitStatusDetails.syncEnabled}
                                        isSyncing={isSyncing}
                                        lastSyncCard={lastSyncCard}
                                        tr={tr}
                                        onSync={() => void handleSync({ backend: 'cloudkit', cloudProvider: 'cloudkit' })}
                                        statusLabel={cloudKitStatusDetails.label}
                                        t={t}
                                        tc={tc}
                                    />
                                ) : cloudProvider === 'selfhosted' || isFossBuild ? (
                                    <SyncSelfHostedBackendPanel
                                        initialAllowInsecureHttp={cloudAllowInsecureHttp}
                                        initialToken={cloudToken}
                                        initialUrl={cloudUrl}
                                        isSyncing={isSyncing}
                                        isTestingConnection={isTestingConnection}
                                        lastSyncCard={lastSyncCard}
                                        onSave={(settings) => void handleSaveSelfHostedSettings(settings)}
                                        onSync={(settings) => void handleSync({ backend: 'cloud', cloud: settings, cloudProvider: 'selfhosted' })}
                                        onTestConnection={(settings) => void handleTestConnection('cloud', { cloud: settings, cloudProvider: 'selfhosted' })}
                                        t={t}
                                        tc={tc}
                                    />
                                ) : (
                                    <SyncDropboxBackendPanel
                                        dropboxBusy={dropboxBusy}
                                        dropboxConfigured={dropboxConfigured}
                                        dropboxConnected={dropboxConnected}
                                        isExpoGo={isExpoGo}
                                        isSyncing={isSyncing}
                                        isTestingConnection={isTestingConnection}
                                        lastSyncCard={lastSyncCard}
                                        tr={tr}
                                        onConnectToggle={() => void (dropboxConnected ? handleDisconnectDropbox() : handleConnectDropbox())}
                                        onSync={() => void handleSync({ backend: 'cloud', cloudProvider: 'dropbox' })}
                                        onTestConnection={() => void handleTestDropboxConnection()}
                                        redirectUri={getDropboxRedirectUri()}
                                        t={t}
                                        tc={tc}
                                    />
                                )}
                            </>
                        )}

                        <SyncPreferencesCard
                            syncAiEnabled={syncAiEnabled}
                            syncAppearanceEnabled={syncAppearanceEnabled}
                            syncExternalCalendarsEnabled={syncExternalCalendarsEnabled}
                            syncGtdEnabled={syncGtdEnabled}
                            syncLanguageEnabled={syncLanguageEnabled}
                            syncSavedFiltersEnabled={syncSavedFiltersEnabled}
                            syncOptionsOpen={syncOptionsOpen}
                            t={t}
                            tc={tc}
                            toggleSyncOptionsOpen={() => setSyncOptionsOpen((prev) => !prev)}
                            updateSyncPreferences={updateSyncPreferences}
                        />

                        <BackgroundSyncInfoCard
                            isRemoteBackend={isScheduledBackgroundSyncBackend}
                            tr={tr}
                            tc={tc}
                        />

                        <RecoverySnapshotsCard
                            backupAction={backupAction}
                            formatRecoverySnapshotLabel={formatRecoverySnapshotLabel}
                            handleRestoreRecoverySnapshot={(snapshot) => void handleRestoreRecoverySnapshot(snapshot)}
                            isBackupBusy={isBackupBusy}
                            isLoadingRecoverySnapshots={isLoadingRecoverySnapshots}
                            isSyncing={isSyncing}
                            tr={tr}
                            recoverySnapshots={recoverySnapshots}
                            recoverySnapshotsOpen={recoverySnapshotsOpen}
                            setRecoverySnapshotsOpen={setRecoverySnapshotsOpen}
                            t={t}
                            tc={tc}
                        />
                    </>
                ) : (
                    <>
                        <SyncBackupSection
                            backupAction={backupAction}
                            handleBackup={() => void handleBackup()}
                            handleImportDgt={() => void handleImportDgt()}
                            handleImportOmniFocus={() => void handleImportOmniFocus()}
                            handleImportTodoist={() => void handleImportTodoist()}
                            handleRestoreBackup={() => void handleRestoreBackup()}
                            isBackupBusy={isBackupBusy}
                            isSyncing={isSyncing}
                            tr={tr}
                            t={t}
                            tc={tc}
                        />

                        <AppleRemindersImportSection
                            addTask={addTask}
                            disabled={isBackupBusy || isSyncing}
                            showToast={showToast}
                            tr={tr}
                            tc={tc}
                        />

                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 16 }]}>
                            <View style={styles.settingRow}>
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {tr('settings.syncMobile.pendingRemoteDeletes')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {pendingRemoteDeleteCount}
                                    </Text>
                                </View>
                                <TouchableOpacity
                                    disabled={pendingRemoteDeleteCount === 0}
                                    onPress={handleClearPendingRemoteDeletes}
                                    style={{ opacity: pendingRemoteDeleteCount === 0 ? 0.45 : 1 }}
                                >
                                    <Text style={[styles.linkText, { color: pendingRemoteDeleteCount === 0 ? tc.secondaryText : tc.tint }]}>
                                        {tr('filters.clear')}
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        </View>

                        <SyncDiagnosticsCard
                            analyticsHeartbeatAvailable={analyticsHeartbeatAvailable}
                            analyticsHeartbeatEnabled={analyticsHeartbeatEnabled}
                            handleClearLog={() => void handleClearLog()}
                            handleShareLog={() => void handleShareLog()}
                            loggingEnabled={loggingEnabled}
                            toggleAnalyticsHeartbeat={toggleAnalyticsHeartbeat}
                            t={t}
                            tc={tc}
                            toggleDebugLogging={toggleDebugLogging}
                        />
                    </>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

export function SyncSettingsScreen() {
    return <SyncSettingsView mode="sync" />;
}

export function DataSettingsScreen() {
    return <SyncSettingsView mode="data" />;
}
