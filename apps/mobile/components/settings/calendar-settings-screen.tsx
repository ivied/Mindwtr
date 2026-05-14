import React, { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { generateUUID, type ExternalCalendarSubscription, useTaskStore } from '@mindwtr/core';

import {
    fetchExternalCalendarEvents,
    getExternalCalendars,
    getSystemCalendarPermissionStatus,
    getSystemCalendars,
    getSystemCalendarSettings,
    requestSystemCalendarPermission,
    saveExternalCalendars,
    saveSystemCalendarSettings,
    type SystemCalendarInfo,
    type SystemCalendarPermissionStatus,
} from '@/lib/external-calendar';
import {
    deleteMindwtrCalendar,
    getCalendarPushEnabled,
    getCalendarPushTargetCalendarId,
    getCalendarPushTargetCalendars,
    getCalendarWritePermissionStatus,
    requestCalendarWritePermission,
    runFullCalendarSync,
    setCalendarPushEnabled,
    setCalendarPushTargetCalendarId,
    startCalendarPushSync,
    stopCalendarPushSync,
    type CalendarPushTargetCalendar,
} from '@/lib/calendar-push-sync';
import { useToast } from '@/contexts/toast-context';
import { maskCalendarUrl } from '@/lib/settings-utils';
import { useThemeColors } from '@/hooks/use-theme-colors';

import { useSettingsLocalization, useSettingsScrollContent } from './settings.hooks';
import { SettingsTopBar } from './settings.shell';
import { styles } from './settings.styles';

type CollapsibleSettingHeaderProps = {
    title: string;
    description: string;
    open: boolean;
    onToggle: () => void;
    textColor: string;
    secondaryTextColor: string;
    rightControl: React.ReactNode;
};

function CollapsibleSettingHeader({
    title,
    description,
    open,
    onToggle,
    textColor,
    secondaryTextColor,
    rightControl,
}: CollapsibleSettingHeaderProps) {
    return (
        <View style={styles.settingRow}>
            <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 12 }}
                onPress={onToggle}
                activeOpacity={0.7}
            >
                <View style={{ flex: 1, marginRight: 12 }}>
                    <Text style={[styles.settingLabel, { color: textColor }]}>{title}</Text>
                    <Text style={[styles.settingDescription, { color: secondaryTextColor }]}>{description}</Text>
                </View>
                <Text style={[styles.chevron, { color: secondaryTextColor }]}>{open ? '▾' : '▸'}</Text>
            </TouchableOpacity>
            {rightControl}
        </View>
    );
}

export function CalendarSettingsScreen() {
    const tc = useThemeColors();
    const { showToast } = useToast();
    const { isChineseLanguage, tr, t } = useSettingsLocalization();
    const { settings, updateSettings } = useTaskStore();
    const scrollContentStyle = useSettingsScrollContent();
    const [externalCalendars, setExternalCalendars] = useState<ExternalCalendarSubscription[]>([]);
    const [newCalendarName, setNewCalendarName] = useState('');
    const [newCalendarUrl, setNewCalendarUrl] = useState('');
    const [systemCalendarEnabled, setSystemCalendarEnabled] = useState(false);
    const [systemCalendarSelectAll, setSystemCalendarSelectAll] = useState(true);
    const [systemCalendarSelectedIds, setSystemCalendarSelectedIds] = useState<string[]>([]);
    const [systemCalendarPermission, setSystemCalendarPermission] = useState<SystemCalendarPermissionStatus>('undetermined');
    const [systemCalendars, setSystemCalendars] = useState<SystemCalendarInfo[]>([]);
    const [isSystemCalendarLoading, setIsSystemCalendarLoading] = useState(false);
    const [systemCalendarOpen, setSystemCalendarOpen] = useState(false);

    // Push-to-calendar state
    const [calendarPushEnabled, setCalendarPushEnabledState] = useState(false);
    const [calendarPushPermission, setCalendarPushPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
    const [calendarPushTargetCalendarId, setCalendarPushTargetCalendarIdState] = useState<string | null>(null);
    const [calendarPushTargets, setCalendarPushTargets] = useState<CalendarPushTargetCalendar[]>([]);
    const [isCalendarPushTargetLoading, setIsCalendarPushTargetLoading] = useState(false);
    const [calendarPushOpen, setCalendarPushOpen] = useState(false);

    const loadCalendarPushTargetState = useCallback(async () => {
        setIsCalendarPushTargetLoading(true);
        try {
            const [targetId, targets] = await Promise.all([
                getCalendarPushTargetCalendarId(),
                getCalendarPushTargetCalendars(),
            ]);
            setCalendarPushTargetCalendarIdState(targetId);
            setCalendarPushTargets(targets);
        } catch (error) {
            console.error(error);
            showToast({
                title: tr('settings.syncMobile.error'),
                message: tr('settings.calendarMobile.failedToLoadWritableCalendars'),
                tone: 'warning',
                durationMs: 4200,
            });
        } finally {
            setIsCalendarPushTargetLoading(false);
        }
    }, [tr, showToast]);

    useEffect(() => {
        void (async () => {
            const [enabled, permission] = await Promise.all([
                getCalendarPushEnabled(),
                getCalendarWritePermissionStatus(),
            ]);
            setCalendarPushEnabledState(enabled);
            setCalendarPushPermission(permission);
            if (permission === 'granted') {
                await loadCalendarPushTargetState();
            } else {
                setCalendarPushTargetCalendarIdState(await getCalendarPushTargetCalendarId());
            }
        })();
    }, [loadCalendarPushTargetState]);

    const handleToggleCalendarPush = async (enabled: boolean) => {
        if (enabled) {
            const granted = calendarPushPermission === 'granted'
                ? true
                : await requestCalendarWritePermission();
            if (!granted) {
                setCalendarPushPermission('denied');
                showToast({
                    title: tr('settings.calendarMobile.permissionRequired'),
                    message: tr('settings.calendarMobile.calendarAccessIsRequiredToPushTasksToYourCalendar'),
                    tone: 'warning',
                    durationMs: 4200,
                });
                return;
            }
            setCalendarPushPermission('granted');
            await loadCalendarPushTargetState();
            await setCalendarPushEnabled(true);
            setCalendarPushEnabledState(true);
            setCalendarPushOpen(true);
            startCalendarPushSync();
            void runFullCalendarSync();
        } else {
            await setCalendarPushEnabled(false);
            setCalendarPushEnabledState(false);
            stopCalendarPushSync();
            showToast({
                title: tr('settings.calendarMobile.calendarSyncDisabled'),
                message: tr('settings.calendarMobile.tasksWillNoLongerBePushedToYourCalendarExisting'),
                tone: 'info',
                durationMs: 4200,
            });
        }
    };

    const handleSelectCalendarPushTarget = async (calendarId: string | null) => {
        if (calendarId === calendarPushTargetCalendarId) return;
        await setCalendarPushTargetCalendarId(calendarId);
        setCalendarPushTargetCalendarIdState(calendarId);
        if (calendarPushEnabled) {
            void runFullCalendarSync();
        }
        showToast({
            title: tr('settings.calendarMobile.calendarTargetUpdated'),
            message: tr('settings.calendarMobile.dueDateTasksWillBeWrittenToTheSelectedCalendar'),
            tone: 'success',
            durationMs: 3200,
        });
    };

    const handleDeleteMindwtrCalendar = async () => {
        // Disable push sync first so the calendar is not recreated on the next
        // startup or task change.
        await setCalendarPushEnabled(false);
        setCalendarPushEnabledState(false);
        stopCalendarPushSync();
        await deleteMindwtrCalendar();
        showToast({
            title: tr('settings.calendarMobile.calendarDeleted'),
            message: tr('settings.calendarMobile.theMindwtrCalendarAndAllItsEventsHaveBeenRemoved'),
            tone: 'success',
            durationMs: 3500,
        });
    };

    const loadSystemCalendarState = useCallback(async (requestAccess = false) => {
        setIsSystemCalendarLoading(true);
        try {
            const stored = await getSystemCalendarSettings();
            setSystemCalendarEnabled(stored.enabled);
            setSystemCalendarSelectAll(stored.selectAll);
            setSystemCalendarSelectedIds(stored.selectedCalendarIds);

            const permission = requestAccess
                ? await requestSystemCalendarPermission()
                : await getSystemCalendarPermissionStatus();
            setSystemCalendarPermission(permission);

            if (permission !== 'granted') {
                setSystemCalendars([]);
                return;
            }

            const calendars = await getSystemCalendars();
            setSystemCalendars(calendars);
            if (stored.selectAll) return;

            const validIds = new Set(calendars.map((calendar) => calendar.id));
            const filteredSelection = stored.selectedCalendarIds.filter((id) => validIds.has(id));
            if (
                filteredSelection.length === stored.selectedCalendarIds.length &&
                filteredSelection.every((id, index) => id === stored.selectedCalendarIds[index])
            ) {
                return;
            }

            setSystemCalendarSelectedIds(filteredSelection);
            await saveSystemCalendarSettings({
                enabled: stored.enabled,
                selectAll: false,
                selectedCalendarIds: filteredSelection,
            });
        } catch (error) {
            console.error(error);
            showToast({
                title: tr('settings.syncMobile.error'),
                message: tr('settings.calendarMobile.failedToLoadDeviceCalendarSettings'),
                tone: 'warning',
                durationMs: 4200,
            });
        } finally {
            setIsSystemCalendarLoading(false);
        }
    }, [tr, showToast]);

    useEffect(() => {
        void loadSystemCalendarState();
    }, [loadSystemCalendarState]);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const stored = await getExternalCalendars();
                if (cancelled) return;
                if (Array.isArray(settings.externalCalendars)) {
                    setExternalCalendars(settings.externalCalendars);
                    if (settings.externalCalendars.length || stored.length) {
                        await saveExternalCalendars(settings.externalCalendars);
                    }
                    return;
                }
                setExternalCalendars(stored);
            } catch (error) {
                console.error(error);
                showToast({
                    title: tr('settings.syncMobile.error'),
                    message: tr('settings.calendarMobile.failedToLoadSavedCalendars'),
                    tone: 'warning',
                    durationMs: 4200,
                });
            }
        };
        void load();
        return () => {
            cancelled = true;
        };
    }, [tr, settings.externalCalendars, showToast]);

    const persistSystemCalendarState = async (next: {
        enabled?: boolean;
        selectAll?: boolean;
        selectedCalendarIds?: string[];
    }) => {
        const payload = {
            enabled: next.enabled ?? systemCalendarEnabled,
            selectAll: next.selectAll ?? systemCalendarSelectAll,
            selectedCalendarIds: next.selectedCalendarIds ?? systemCalendarSelectedIds,
        };
        setSystemCalendarEnabled(payload.enabled);
        setSystemCalendarSelectAll(payload.selectAll);
        setSystemCalendarSelectedIds(payload.selectedCalendarIds);
        await saveSystemCalendarSettings(payload);
    };

    const handleToggleSystemCalendarEnabled = async (enabled: boolean) => {
        await persistSystemCalendarState({ enabled });
        if (enabled) setSystemCalendarOpen(true);
        if (enabled && systemCalendarPermission !== 'granted') {
            await loadSystemCalendarState(true);
        }
    };

    const handleToggleSystemCalendarSelection = async (calendarId: string, enabled: boolean) => {
        const allIds = systemCalendars.map((calendar) => calendar.id);
        if (allIds.length === 0) return;

        const currentSelection = systemCalendarSelectAll
            ? allIds
            : Array.from(new Set(systemCalendarSelectedIds.filter((id) => allIds.includes(id))));
        const nextSelection = enabled
            ? Array.from(new Set([...currentSelection, calendarId]))
            : currentSelection.filter((id) => id !== calendarId);
        const selectAll = nextSelection.length === allIds.length;

        await persistSystemCalendarState({
            selectAll,
            selectedCalendarIds: selectAll ? [] : nextSelection,
        });
    };

    const handleAddCalendar = async () => {
        const url = newCalendarUrl.trim();
        if (!url) return;

        const name = (newCalendarName.trim() || tr('nav.calendar')).trim();
        const next: ExternalCalendarSubscription[] = [...externalCalendars, { id: generateUUID(), name, url, enabled: true }];

        setExternalCalendars(next);
        setNewCalendarName('');
        setNewCalendarUrl('');
        await saveExternalCalendars(next);
        await updateSettings({ externalCalendars: next });
    };

    const handleToggleCalendar = async (id: string, enabled: boolean) => {
        const next = externalCalendars.map((c) => (c.id === id ? { ...c, enabled } : c));
        setExternalCalendars(next);
        await saveExternalCalendars(next);
        await updateSettings({ externalCalendars: next });
    };

    const handleRemoveCalendar = async (id: string) => {
        const next = externalCalendars.filter((c) => c.id !== id);
        setExternalCalendars(next);
        await saveExternalCalendars(next);
        await updateSettings({ externalCalendars: next });
    };

    const handleTestFetch = async () => {
        try {
            const now = new Date();
            const rangeStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            const rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
            const { events } = await fetchExternalCalendarEvents(rangeStart, rangeEnd);
            showToast({
                title: tr('common.success'),
                message: isChineseLanguage ? `已加载 ${events.length} 个日程` : `Loaded ${events.length} events`,
                tone: 'success',
            });
        } catch (error) {
            console.error(error);
            showToast({
                title: tr('settings.syncMobile.error'),
                message: tr('settings.calendarMobile.failedToLoadEvents'),
                tone: 'warning',
            });
        }
    };

    const selectedSystemCalendarSet = new Set(systemCalendarSelectedIds);
    const selectedCalendarPushTarget = calendarPushTargetCalendarId
        ? calendarPushTargets.find((calendar) => calendar.id === calendarPushTargetCalendarId)
        : null;
    const selectedSharedAccountCalendarForPush = Boolean(
        selectedCalendarPushTarget
        && !selectedCalendarPushTarget.isMindwtrDedicated
        && !selectedCalendarPushTarget.isLocalOnly
    );
    const selectedLocalCalendarForPush = calendarPushTargetCalendarId === null || Boolean(selectedCalendarPushTarget?.isLocalOnly);
    const hasDedicatedAccountCalendarForPush = calendarPushTargets.some((calendar) =>
        calendar.isMindwtrDedicated && !calendar.isLocalOnly
    );
    const getCalendarPushTargetDescription = (calendar: CalendarPushTargetCalendar): string => {
        const kind = calendar.isMindwtrDedicated
            ? calendar.isLocalOnly
                ? tr('settings.calendarMobile.dedicatedLocalCalendar')
                : tr('settings.calendarMobile.dedicatedAccountCalendar')
            : calendar.isLocalOnly
                ? tr('settings.calendarMobile.sharedLocalCalendar')
                : tr('settings.calendarMobile.sharedAccountCalendar');
        return calendar.sourceName ? `${kind} · ${calendar.sourceName}` : kind;
    };
    const defaultLocalTargetOption = {
        id: null as string | null,
        name: tr('settings.calendarMobile.mindwtrCalendar'),
        description: tr('settings.calendarMobile.dedicatedLocalCalendar'),
        color: '#3B82F6',
    };
    const calendarPushTargetOptions: Array<{
        id: string | null;
        name: string;
        description: string;
        color?: string;
    }> = [
        ...(!hasDedicatedAccountCalendarForPush || calendarPushTargetCalendarId === null
            ? [defaultLocalTargetOption]
            : []),
        ...calendarPushTargets
            .filter((calendar) => {
                if (calendar.isMindwtrManaged && calendar.id !== calendarPushTargetCalendarId) return false;
                if (
                    hasDedicatedAccountCalendarForPush
                    && calendar.isMindwtrDedicated
                    && calendar.isLocalOnly
                    && calendar.id !== calendarPushTargetCalendarId
                ) {
                    return false;
                }
                return true;
            })
            .map((calendar) => ({
                id: calendar.id as string | null,
                name: calendar.name,
                description: getCalendarPushTargetDescription(calendar),
                color: calendar.color,
            })),
    ];

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar title={t('settings.calendar')} />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                {/* Push tasks to calendar */}
                <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginBottom: 16 }]}>
                    <CollapsibleSettingHeader
                        title={tr('settings.calendarMobile.pushTasksToCalendar')}
                        description={tr('settings.calendarMobile.scheduledTasksAndTasksWithDueDatesAreAddedTo')}
                        open={calendarPushOpen}
                        onToggle={() => setCalendarPushOpen((open) => !open)}
                        textColor={tc.text}
                        secondaryTextColor={tc.secondaryText}
                        rightControl={(
                            <Switch
                                value={calendarPushEnabled}
                                onValueChange={(v) => void handleToggleCalendarPush(v)}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        )}
                    />

                    {calendarPushOpen && calendarPushEnabled && calendarPushPermission === 'denied' && (
                        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {tr('settings.calendarMobile.calendarAccessWasDeniedPleaseGrantAccessInSettings')}
                            </Text>
                        </View>
                    )}

                    {calendarPushOpen && calendarPushEnabled && calendarPushPermission === 'granted' && (
                        <View style={{ borderTopWidth: 1, borderTopColor: tc.border }}>
                            <View style={styles.settingRowColumn}>
                                <Text style={[styles.settingLabel, { color: tc.text }]}>
                                    {tr('settings.calendarMobile.syncTarget')}
                                </Text>
                            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                {tr('settings.calendarMobile.chooseAnAccountCalendarIfYourCalendarAppHidesLocal')}
                            </Text>
                            {selectedLocalCalendarForPush && (
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                    {tr('settings.calendarMobile.localCalendarTargetsStayOnThisDeviceUseAGoogle')}
                                </Text>
                            )}
                            {selectedSharedAccountCalendarForPush && (
                                <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 8 }]}>
                                    {tr('settings.calendarMobile.forASeparateColorInGoogleCalendarSelectADedicated')}
                                </Text>
                            )}
                        </View>

                            {isCalendarPushTargetLoading ? (
                                <View style={{ paddingBottom: 16 }}>
                                    <ActivityIndicator color={tc.tint} />
                                </View>
                            ) : (
                                calendarPushTargetOptions.map((target, idx) => {
                                    const selected = target.id === calendarPushTargetCalendarId;
                                    return (
                                        <TouchableOpacity
                                            key={target.id ?? 'mindwtr-managed'}
                                            style={[
                                                styles.settingRow,
                                                { borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: tc.border },
                                            ]}
                                            onPress={() => void handleSelectCalendarPushTarget(target.id)}
                                        >
                                            <View style={styles.settingInfo}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                                    {target.color && (
                                                        <View
                                                            style={{
                                                                width: 10,
                                                                height: 10,
                                                                borderRadius: 5,
                                                                backgroundColor: target.color,
                                                            }}
                                                        />
                                                    )}
                                                    <Text style={[styles.settingLabel, { color: tc.text, flex: 1 }]} numberOfLines={1}>
                                                        {target.name}
                                                    </Text>
                                                </View>
                                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                    {target.description}
                                                </Text>
                                            </View>
                                            {selected && <Ionicons color={tc.tint} name="checkmark" size={20} />}
                                        </TouchableOpacity>
                                    );
                                })
                            )}

                            <TouchableOpacity
                                onPress={() => void loadCalendarPushTargetState()}
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: tc.text }]}>
                                        {tr('settings.calendarMobile.refreshCalendars')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {tr('settings.calendarMobile.reloadTheListAfterAddingACalendarInGoogleCalendar')}
                                    </Text>
                                </View>
                                <Ionicons color={tc.tint} name="refresh-outline" size={20} />
                            </TouchableOpacity>

                            <TouchableOpacity
                                onPress={() => void handleDeleteMindwtrCalendar()}
                                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                            >
                                <View style={styles.settingInfo}>
                                    <Text style={[styles.settingLabel, { color: '#EF4444' }]}>
                                        {tr('settings.calendarMobile.deleteMindwtrCalendar')}
                                    </Text>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {tr('settings.calendarMobile.removeTheDedicatedCalendarAndItsPushedEventsFromThis')}
                                    </Text>
                                </View>
                                <Ionicons color="#EF4444" name="trash-outline" size={20} />
                            </TouchableOpacity>
                        </View>
                    )}
                </View>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <CollapsibleSettingHeader
                        title={t('settings.deviceCalendars')}
                        description={t('settings.deviceCalendarsDesc')}
                        open={systemCalendarOpen}
                        onToggle={() => setSystemCalendarOpen((open) => !open)}
                        textColor={tc.text}
                        secondaryTextColor={tc.secondaryText}
                        rightControl={(
                            <Switch
                                value={systemCalendarEnabled}
                                onValueChange={handleToggleSystemCalendarEnabled}
                                trackColor={{ false: '#767577', true: '#3B82F6' }}
                            />
                        )}
                    />

                    {systemCalendarOpen && systemCalendarEnabled && (
                        <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: tc.border }}>
                            {systemCalendarPermission !== 'granted' ? (
                                <View>
                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                                        {systemCalendarPermission === 'denied'
                                            ? t('settings.calendarAccessDenied')
                                            : t('settings.calendarAccessRequired')}
                                    </Text>
                                    <TouchableOpacity
                                        style={[
                                            styles.backendOption,
                                            { borderColor: tc.border, backgroundColor: tc.filterBg, marginTop: 12, alignSelf: 'flex-start' },
                                        ]}
                                        onPress={() => void loadSystemCalendarState(true)}
                                    >
                                        <Text style={[styles.backendOptionText, { color: tc.text }]}>{t('settings.grantCalendarAccess')}</Text>
                                    </TouchableOpacity>
                                </View>
                            ) : isSystemCalendarLoading ? (
                                <View style={{ paddingVertical: 8 }}>
                                    <ActivityIndicator color={tc.tint} />
                                </View>
                            ) : systemCalendars.length === 0 ? (
                                <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.noDeviceCalendars')}</Text>
                            ) : (
                                <View>
                                    {systemCalendars.map((calendar, idx) => {
                                        const selected = systemCalendarSelectAll || selectedSystemCalendarSet.has(calendar.id);
                                        return (
                                            <View
                                                key={calendar.id}
                                                style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                            >
                                                <View style={styles.settingInfo}>
                                                    <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                                        {calendar.name}
                                                    </Text>
                                                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                                        {t('settings.deviceCalendar')}
                                                    </Text>
                                                </View>
                                                <Switch
                                                    value={selected}
                                                    onValueChange={(value) => void handleToggleSystemCalendarSelection(calendar.id, value)}
                                                    trackColor={{ false: '#767577', true: '#3B82F6' }}
                                                />
                                            </View>
                                        );
                                    })}
                                </View>
                            )}
                        </View>
                    )}
                </View>

                <Text style={[styles.sectionTitle, { color: tc.secondaryText, marginTop: 16 }]}>
                    {tr('settings.calendarMobile.icsSubscriptions')}
                </Text>
                <Text style={[styles.description, { color: tc.secondaryText }]}>{t('settings.calendarDesc')}</Text>

                <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                    <View style={styles.inputGroup}>
                        <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.externalCalendarName')}</Text>
                        <TextInput
                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                            placeholder={tr('settings.calendarMobile.optional')}
                            placeholderTextColor={tc.secondaryText}
                            value={newCalendarName}
                            onChangeText={setNewCalendarName}
                        />

                        <Text style={[styles.settingLabel, { color: tc.text, marginTop: 12 }]}>{t('settings.externalCalendarUrl')}</Text>
                        <TextInput
                            style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                            placeholder={t('settings.externalCalendarUrlPlaceholder')}
                            placeholderTextColor={tc.secondaryText}
                            autoCapitalize="none"
                            autoCorrect={false}
                            value={newCalendarUrl}
                            onChangeText={setNewCalendarUrl}
                        />

                        <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
                            <TouchableOpacity
                                style={[
                                    styles.backendOption,
                                    { borderColor: tc.border, backgroundColor: newCalendarUrl.trim() ? tc.tint : tc.filterBg },
                                ]}
                                onPress={() => void handleAddCalendar()}
                                disabled={!newCalendarUrl.trim()}
                            >
                                <Text style={[styles.backendOptionText, { color: newCalendarUrl.trim() ? '#FFFFFF' : tc.secondaryText }]}>
                                    {t('settings.externalCalendarAdd')}
                                </Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={[styles.backendOption, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => void handleTestFetch()}
                            >
                                <Text style={[styles.backendOptionText, { color: tc.text }]}>{tr('settings.calendarMobile.test')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>

                {externalCalendars.length > 0 && (
                    <View style={{ marginTop: 16 }}>
                        <Text style={[styles.sectionTitle, { color: tc.secondaryText }]}>{t('settings.externalCalendars')}</Text>
                        <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
                            {externalCalendars.map((calendar, idx) => (
                                <View
                                    key={calendar.id}
                                    style={[styles.settingRow, idx > 0 && { borderTopWidth: 1, borderTopColor: tc.border }]}
                                >
                                    <View style={styles.settingInfo}>
                                        <Text style={[styles.settingLabel, { color: tc.text }]} numberOfLines={1}>
                                            {calendar.name}
                                        </Text>
                                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                                            {maskCalendarUrl(calendar.url)}
                                        </Text>
                                    </View>
                                    <View style={{ alignItems: 'flex-end', gap: 10 }}>
                                        <Switch
                                            value={calendar.enabled}
                                            onValueChange={(value) => void handleToggleCalendar(calendar.id, value)}
                                            trackColor={{ false: '#767577', true: '#3B82F6' }}
                                        />
                                        <TouchableOpacity onPress={() => void handleRemoveCalendar(calendar.id)}>
                                            <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: '600' }}>
                                                {t('settings.externalCalendarRemove')}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            ))}
                        </View>
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}
