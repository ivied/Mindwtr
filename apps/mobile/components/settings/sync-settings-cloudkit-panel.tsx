import type { ReactNode } from 'react';
import React from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';

import type { ThemeColors } from '@/hooks/use-theme-colors';

import { styles } from './settings.styles';

type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
type Translate = (key: string) => string;

type SyncCloudKitBackendPanelProps = {
    helpText: string;
    isSyncEnabled: boolean;
    isSyncing: boolean;
    lastSyncCard: ReactNode;
    tr: SettingsTranslator;
    onSync: () => void;
    statusLabel: string;
    t: Translate;
    tc: ThemeColors;
};

export function SyncCloudKitBackendPanel({
    helpText,
    isSyncEnabled,
    isSyncing,
    lastSyncCard,
    tr,
    onSync,
    statusLabel,
    t,
    tc,
}: SyncCloudKitBackendPanelProps) {
    return (
        <>
            <View style={[styles.helpBox, { backgroundColor: tc.cardBg, borderColor: tc.border, marginTop: 12 }]}>
                <Text style={[styles.helpTitle, { color: tc.text }]}>iCloud Sync</Text>
                <Text style={[styles.helpText, { color: tc.secondaryText }]}>
                    {helpText}
                </Text>
                <Text style={[styles.helpText, { color: tc.secondaryText, marginTop: 8 }]}>
                    {tr('settings.syncMobile.accountStatus')}: {statusLabel}
                </Text>
            </View>

            <View style={[styles.settingCard, { backgroundColor: tc.cardBg, marginTop: 12 }]}>
                <TouchableOpacity
                    style={styles.settingRow}
                    onPress={onSync}
                    disabled={isSyncing || !isSyncEnabled}
                >
                    <View style={styles.settingInfo}>
                        <Text style={[styles.settingLabel, { color: isSyncEnabled ? tc.tint : tc.secondaryText }]}>
                            {t('settings.syncNow')}
                        </Text>
                        <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                            {tr('settings.syncMobile.readAndMergeTheLatestCloudkitDataNow')}
                        </Text>
                    </View>
                    {isSyncing && <ActivityIndicator size="small" color={tc.tint} />}
                </TouchableOpacity>
            </View>
            {lastSyncCard}
        </>
    );
}
