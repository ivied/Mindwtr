import { useCallback } from 'react';
import { Alert } from 'react-native';
import Constants from 'expo-constants';
import type {
    Area,
    BackupValidation,
    DgtImportParseResult,
    OmniFocusImportParseResult,
    ParsedOmniFocusImportData,
    ParsedDgtImportData,
    Project,
    ParsedTodoistProject,
    Section,
    Task,
    TodoistImportParseResult,
} from '@mindwtr/core';

import {
    exportCurrentDataBackup,
    importDgtData,
    importOmniFocusData,
    importTodoistData,
    inspectBackupDocument,
    inspectDgtDocument,
    inspectOmniFocusDocument,
    inspectTodoistDocument,
    pickBackupDocument,
    pickDgtDocument,
    pickOmniFocusDocument,
    pickTodoistDocument,
    restoreDataFromBackup,
    restoreLocalDataSnapshot,
} from '@/lib/data-transfer';
import { clearLog, ensureLogFilePath, logInfo } from '@/lib/app-log';
import { logSettingsError } from '@/lib/settings-utils';

type BackupAction = null | 'export' | 'restore' | 'import' | 'snapshot';

type UseSyncSettingsBackupActionsParams = {
    areas: Area[];
    tr: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
    projects: Project[];
    refreshRecoverySnapshots: () => Promise<void>;
    sections: Section[];
    settings: Record<string, any>;
    setBackupAction: React.Dispatch<React.SetStateAction<BackupAction>>;
    showSettingsErrorToast: (title: string, message: string, durationMs?: number) => void;
    showSettingsWarning: (title: string, message: string, durationMs?: number) => void;
    showToast: (options: {
        title: string;
        message: string;
        tone: 'warning' | 'error' | 'success' | 'info';
        durationMs?: number;
    }) => void;
    t: (key: string) => string;
    tasks: Task[];
    updateSettings: (updates: Record<string, any>) => Promise<unknown>;
};

export function useSyncSettingsBackupActions({
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
}: UseSyncSettingsBackupActionsParams) {
    const formatRecoverySnapshotLabel = useCallback((fileName: string): string => {
        const match = fileName.match(/^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.snapshot\.json$/i);
        if (!match) return fileName;
        const [, datePart, hour, minute, second] = match;
        const localDate = new Date(`${datePart}T${hour}:${minute}:${second}Z`);
        return `${localDate.toLocaleDateString()} ${localDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }, []);

    const buildBackupSummary = useCallback((validation: Awaited<ReturnType<typeof inspectBackupDocument>>) => {
        const details = [
            validation.metadata?.backupAt
                ? tr('settings.backupMobile.backupDateLabel', { backupDate: new Date(validation.metadata.backupAt).toLocaleString() })
                : validation.metadata?.fileName
                    ? tr('settings.backupMobile.fileLabel', { fileName: validation.metadata.fileName })
                    : null,
            tr('settings.backupMobile.backupPreviewCounts', { taskCount: validation.metadata?.taskCount ?? 0, projectCount: validation.metadata?.projectCount ?? 0 }),
            tr('settings.backupMobile.thisWillReplaceAllCurrentLocalDataARecoverySnapshot'),
            ...(validation.warnings.length > 0 ? ['', ...validation.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [tr]);

    const buildTodoistSummary = useCallback((preview: NonNullable<TodoistImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTodoistTasksFromProjects', { taskCount: preview.taskCount, projectCount: preview.projectCount }),
            preview.sectionCount > 0
                ? tr('settings.backupMobile.sectionsWillBePreserved', { sectionCount: preview.sectionCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.subtasksWillBecomeChecklistItems', { subtaskCount: preview.checklistItemCount })
                : null,
            tr('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem'),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [tr]);

    const buildDgtSummary = useCallback((preview: NonNullable<DgtImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
            preview.areaCount > 0
                ? tr('settings.backupMobile.dgtAreasWillBeCreated', { areaCount: preview.areaCount })
                : null,
            preview.projectCount > 0
                ? tr('settings.backupMobile.projectsWillBeCreated', { projectCount: preview.projectCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount })
                : null,
            preview.standaloneTaskCount > 0
                ? tr('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount })
                : null,
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [tr]);

    const buildOmniFocusSummary = useCallback((preview: NonNullable<OmniFocusImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTaskCountFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
            preview.projectCount > 0
                ? tr('settings.backupMobile.projectsWillBeCreatedWhenNeeded', { projectCount: preview.projectCount })
                : null,
            preview.areaCount > 0
                ? tr('settings.backupMobile.omnifocusAreasWillBeCreated', { areaCount: preview.areaCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.nestedTasksWillBecomeChecklistItems', { taskCount: preview.checklistItemCount })
                : null,
            preview.standaloneTaskCount > 0
                ? tr('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount })
                : null,
            tr('settings.backupMobile.importedTasksKeepOmnifocusNotesDatesTagsRecurrenceAndChecklist'),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [tr]);

    const handleBackup = useCallback(async () => {
        setBackupAction('export');
        try {
            await exportCurrentDataBackup({ tasks, projects, sections, areas, settings });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.syncMobile.error'), tr('settings.backupMobile.failedToExportBackup'));
        } finally {
            setBackupAction(null);
        }
    }, [areas, tr, projects, sections, setBackupAction, settings, showSettingsErrorToast, tasks]);

    const confirmRestoreBackup = useCallback(async (validation: BackupValidation) => {
        if (!validation.data) return;
        setBackupAction('restore');
        try {
            const { snapshotName } = await restoreDataFromBackup(validation.data);
            await refreshRecoverySnapshots();
            showToast({
                title: tr('settings.backupMobile.restoreComplete'),
                message: tr('settings.backupMobile.backupRestoredWithSnapshot', { snapshotName }),
                tone: 'success',
                durationMs: 5000,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.restoreFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const handleRestoreBackup = useCallback(async () => {
        setBackupAction('restore');
        try {
            const document = await pickBackupDocument();
            if (!document) return;
            const validation = await inspectBackupDocument(document, {
                appVersion: Constants.expoConfig?.version ?? '0.0.0',
            });
            if (!validation.valid || !validation.data) {
                showSettingsWarning(
                    tr('settings.backupMobile.invalidBackup'),
                    validation.errors[0] || tr('settings.backupMobile.thisFileIsNotAValidMindwtrBackup')
                );
                return;
            }
            const summary = buildBackupSummary(validation);
            Alert.alert(
                tr('settings.backupMobile.restoreBackup'),
                summary,
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('markdown.referenceRestore'),
                        style: 'destructive',
                        onPress: () => void confirmRestoreBackup(validation),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.restoreFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildBackupSummary, confirmRestoreBackup, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const confirmTodoistImport = useCallback(async (parsedProjects: ParsedTodoistProject[]) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importTodoistData(parsedProjects);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTodoistTasksIntoProjects', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }),
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.subtasksBecameChecklistItems', { subtaskCount: result.importedChecklistItemCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 5600,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmDgtImport = useCallback(async (parsedData: ParsedDgtImportData) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importDgtData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTaskProjectAreaCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount, areaCount: result.importedAreaCount }),
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: result.importedChecklistItemCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmOmniFocusImport = useCallback(async (parsedData: ParsedOmniFocusImportData) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importOmniFocusData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTaskProjectCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }),
                result.importedAreaCount > 0
                    ? tr('settings.backupMobile.omnifocusAreasCreated', { areaCount: result.importedAreaCount })
                    : null,
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.nestedTasksBecameChecklistItems', { taskCount: result.importedChecklistItemCount })
                    : null,
                result.importedStandaloneTaskCount > 0
                    ? tr('settings.backupMobile.tasksStayedOutsideProjects', { taskCount: result.importedStandaloneTaskCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const handleImportTodoist = useCallback(async () => {
        setBackupAction('import');
        try {
            const document = await pickTodoistDocument();
            if (!document) return;
            const parseResult = await inspectTodoistDocument(document);
            if (!parseResult.valid || !parseResult.preview) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    parseResult.errors[0] || tr('settings.backupMobile.theSelectedFileIsNotASupportedTodoistExport')
                );
                return;
            }
            Alert.alert(
                tr('settings.backupMobile.importTodoistData'),
                buildTodoistSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmTodoistImport(parseResult.parsedProjects),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildTodoistSummary, confirmTodoistImport, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportDgt = useCallback(async () => {
        setBackupAction('import');
        try {
            const document = await pickDgtDocument();
            if (!document) return;
            const parseResult = await inspectDgtDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    parseResult.errors[0] || tr('settings.backupMobile.theSelectedFileIsNotASupportedDgtGtdExport')
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                tr('settings.backupMobile.importDgtGtdData'),
                buildDgtSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmDgtImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildDgtSummary, confirmDgtImport, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportOmniFocus = useCallback(async () => {
        setBackupAction('import');
        try {
            const document = await pickOmniFocusDocument();
            if (!document) return;
            const parseResult = await inspectOmniFocusDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    parseResult.errors[0] || tr('settings.backupMobile.theSelectedFileIsNotASupportedOmnifocusExport')
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                tr('settings.backupMobile.importOmnifocusData'),
                buildOmniFocusSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmOmniFocusImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildOmniFocusSummary, confirmOmniFocusImport, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleRestoreRecoverySnapshot = useCallback(async (snapshotName: string) => {
        Alert.alert(
            tr('settings.backupMobile.restoreRecoverySnapshot'),
            tr('settings.backupMobile.restoreSnapshotReplaceLocalData', { snapshotName: formatRecoverySnapshotLabel(snapshotName) }),
            [
                { text: tr('common.cancel'), style: 'cancel' },
                {
                    text: tr('markdown.referenceRestore'),
                    style: 'destructive',
                    onPress: async () => {
                        setBackupAction('snapshot');
                        try {
                            await restoreLocalDataSnapshot(snapshotName);
                            await refreshRecoverySnapshots();
                            showToast({
                                title: tr('settings.backupMobile.restoreComplete'),
                                message: tr('settings.backupMobile.recoverySnapshotRestored'),
                                tone: 'success',
                            });
                        } catch (error) {
                            logSettingsError(error);
                            showSettingsErrorToast(tr('settings.backupMobile.restoreFailed'), String(error), 5200);
                        } finally {
                            setBackupAction(null);
                        }
                    },
                },
            ]
        );
    }, [formatRecoverySnapshotLabel, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const toggleDebugLogging = useCallback((value: boolean) => {
        updateSettings({
            diagnostics: {
                ...(settings.diagnostics ?? {}),
                loggingEnabled: value,
            },
        })
            .then(async () => {
                if (!value) return;
                const ensuredPath = await ensureLogFilePath();
                if (!ensuredPath) return;
                await logInfo('Debug logging enabled', { scope: 'diagnostics', force: true });
            })
            .catch(logSettingsError);
    }, [settings.diagnostics, updateSettings]);

    const handleShareLog = useCallback(async () => {
        const path = await ensureLogFilePath();
        if (!path) {
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.logMissing'),
                tone: 'warning',
            });
            return;
        }
        const Sharing = await import('expo-sharing');
        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.shareUnavailable'),
                tone: 'warning',
            });
            return;
        }
        await Sharing.shareAsync(path, { mimeType: 'text/plain' });
    }, [showToast, t]);

    const handleClearLog = useCallback(async () => {
        await clearLog();
        showToast({
            title: t('settings.debugLogging'),
            message: t('settings.logCleared'),
            tone: 'success',
        });
    }, [showToast, t]);

    return {
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
    };
}
