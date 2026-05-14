import React, { useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    Bell,
    CalendarDays,
    Database,
    Info,
    Layers,
    ListChecks,
    Monitor,
    RefreshCw,
    Settings2,
    Sparkles,
} from 'lucide-react-native';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileSyncBadge } from '@/hooks/use-mobile-sync-badge';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { AboutSettingsScreen } from '@/components/settings/about-settings-screen';
import { AISettingsScreen } from '@/components/settings/ai-settings-screen';
import { CalendarSettingsScreen } from '@/components/settings/calendar-settings-screen';
import { DataSettingsScreen, SyncSettingsScreen } from '@/components/settings/sync-settings-screen';
import { GeneralSettingsScreen } from '@/components/settings/general-settings-screen';
import { GtdSettingsScreen } from '@/components/settings/gtd-settings-screen';
import { ManageSettingsScreen } from '@/components/settings/manage-settings-screen';
import { NotificationsSettingsScreen } from '@/components/settings/notifications-settings-screen';
import { MenuItem, SettingsTopBar } from '@/components/settings/settings.shell';
import { styles } from '@/components/settings/settings.styles';
import {
    SETTINGS_SCREEN_SET,
    type SettingsScreen,
    UPDATE_BADGE_AVAILABLE_KEY,
} from '@/components/settings/settings.constants';
import { useSettingsLocalization, useSettingsScrollContent } from '@/components/settings/settings.hooks';

export default function SettingsPage() {
    const router = useRouter();
    const tc = useThemeColors();
    const { t } = useSettingsLocalization();
    const scrollContentStyle = useSettingsScrollContent();
    const { settingsScreen } = useLocalSearchParams<{ settingsScreen?: string | string[] }>();
    const { syncBadgeAccessibilityLabel, syncBadgeColor } = useMobileSyncBadge();
    const [hasUpdateBadge, setHasUpdateBadge] = useState(false);

    useEffect(() => {
        AsyncStorage.getItem(UPDATE_BADGE_AVAILABLE_KEY)
            .then((value) => setHasUpdateBadge(value === 'true'))
            .catch(() => setHasUpdateBadge(false));
    }, []);

    const currentScreen = useMemo<SettingsScreen>(() => {
        const rawScreen = Array.isArray(settingsScreen) ? settingsScreen[0] : settingsScreen;
        if (!rawScreen) return 'main';
        return SETTINGS_SCREEN_SET[rawScreen as SettingsScreen] ? (rawScreen as SettingsScreen) : 'main';
    }, [settingsScreen]);
    const dataLabel = t('settings.data');
    const menuDescriptions = useMemo(
        () => ({
            general: t('settings.menuDesc.general'),
            gtd: t('settings.menuDesc.gtd'),
            manage: t('settings.menuDesc.manage'),
            notifications: t('settings.menuDesc.notifications'),
            sync: t('settings.menuDesc.sync'),
            data: t('settings.menuDesc.data'),
            advanced: t('settings.menuDesc.advanced'),
            about: t('settings.menuDesc.about'),
            ai: t('settings.menuDesc.ai'),
            calendar: t('settings.menuDesc.calendar'),
        }),
        [t],
    );

    const pushSettingsScreen = (nextScreen: SettingsScreen) => {
        if (nextScreen === 'main') {
            router.push('/settings');
            return;
        }
        router.push({ pathname: '/settings', params: { settingsScreen: nextScreen } });
    };

    if (currentScreen === 'notifications') {
        return <NotificationsSettingsScreen />;
    }

    if (currentScreen === 'general') {
        return <GeneralSettingsScreen />;
    }

    if (currentScreen === 'ai') {
        return <AISettingsScreen />;
    }

    if (currentScreen === 'manage') {
        return <ManageSettingsScreen />;
    }

    if (
        currentScreen === 'gtd'
        || currentScreen === 'gtd-archive'
        || currentScreen === 'gtd-capture'
        || currentScreen === 'gtd-inbox'
        || currentScreen === 'gtd-pomodoro'
        || currentScreen === 'gtd-review'
        || currentScreen === 'gtd-time-estimates'
        || currentScreen === 'gtd-task-editor'
    ) {
        return <GtdSettingsScreen onNavigate={pushSettingsScreen} screen={currentScreen} />;
    }

    if (currentScreen === 'calendar') {
        return <CalendarSettingsScreen />;
    }

    if (currentScreen === 'sync') {
        return <SyncSettingsScreen />;
    }

    if (currentScreen === 'data') {
        return <DataSettingsScreen />;
    }

    if (currentScreen === 'about') {
        return <AboutSettingsScreen onUpdateBadgeChange={setHasUpdateBadge} />;
    }

    if (currentScreen === 'advanced') {
        return (
            <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
                <SettingsTopBar title={t('settings.advanced')} />
                <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem
                            title={t('settings.ai')}
                            description={menuDescriptions.ai}
                            icon={Sparkles}
                            onPress={() => pushSettingsScreen('ai')}
                        />
                        <MenuItem
                            title={t('settings.calendar')}
                            description={menuDescriptions.calendar}
                            icon={CalendarDays}
                            isLast
                            onPress={() => pushSettingsScreen('calendar')}
                        />
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: tc.bg }]} edges={['bottom']}>
            <SettingsTopBar />
            <ScrollView style={styles.scrollView} contentContainerStyle={scrollContentStyle}>
                <View style={styles.menuGroupStack}>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem
                            title={t('settings.general')}
                            description={menuDescriptions.general}
                            icon={Monitor}
                            onPress={() => pushSettingsScreen('general')}
                        />
                        <MenuItem
                            title={t('settings.gtd')}
                            description={menuDescriptions.gtd}
                            icon={ListChecks}
                            onPress={() => pushSettingsScreen('gtd')}
                        />
                        <MenuItem
                            title={t('settings.manage')}
                            description={menuDescriptions.manage}
                            icon={Layers}
                            onPress={() => pushSettingsScreen('manage')}
                        />
                        <MenuItem
                            title={t('settings.notifications')}
                            description={menuDescriptions.notifications}
                            icon={Bell}
                            isLast
                            onPress={() => pushSettingsScreen('notifications')}
                        />
                    </View>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem
                            title={t('settings.sync')}
                            description={menuDescriptions.sync}
                            icon={RefreshCw}
                            onPress={() => pushSettingsScreen('sync')}
                            showIndicator={Boolean(syncBadgeColor)}
                            indicatorColor={syncBadgeColor}
                            indicatorAccessibilityLabel={syncBadgeAccessibilityLabel}
                        />
                        <MenuItem
                            title={dataLabel}
                            description={menuDescriptions.data}
                            icon={Database}
                            isLast
                            onPress={() => pushSettingsScreen('data')}
                        />
                    </View>
                    <View style={[styles.menuCard, { backgroundColor: tc.cardBg }]}>
                        <MenuItem
                            title={t('settings.advanced')}
                            description={menuDescriptions.advanced}
                            icon={Settings2}
                            onPress={() => pushSettingsScreen('advanced')}
                        />
                        <MenuItem
                            title={t('settings.about')}
                            description={menuDescriptions.about}
                            icon={Info}
                            isLast
                            onPress={() => pushSettingsScreen('about')}
                            showIndicator={hasUpdateBadge}
                            indicatorAccessibilityLabel={hasUpdateBadge ? t('settings.updateAvailable') : undefined}
                        />
                    </View>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}
