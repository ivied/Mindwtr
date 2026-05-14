import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tFallback, useTaskStore } from '@mindwtr/core';

import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '../hooks/use-theme-colors';
import { getMobileSyncActivityState, subscribeMobileSyncActivityState } from '../lib/sync-service';

export function SyncActivityIndicator() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const tc = useThemeColors();
    const { t } = useLanguage();
    const pendingRemoteWriteAt = useTaskStore((state) => state.settings?.pendingRemoteWriteAt);
    const lastSyncStatus = useTaskStore((state) => state.settings?.lastSyncStatus);
    const lastSyncError = useTaskStore((state) => state.settings?.lastSyncError);
    const [activityState, setActivityState] = useState(getMobileSyncActivityState());

    useEffect(() => {
        return subscribeMobileSyncActivityState(setActivityState);
    }, []);

    const copy = useMemo(() => {
        if (lastSyncStatus === 'error') {
            return {
                label: tFallback(t, 'settings.lastSyncError', 'Sync failed'),
                accessibilityLabel: tFallback(
                    t,
                    'settings.syncIssueAccessibility',
                    'Sync needs attention. Tap to open settings for sync details.'
                ),
            };
        }
        return {
            label: tFallback(t, 'settings.syncing', 'Syncing'),
            accessibilityLabel: tFallback(
                t,
                'settings.syncingAccessibility',
                'Sync in progress. Tap to open settings for sync details.'
            ),
        };
    }, [lastSyncStatus, t]);

    const hasSyncError = lastSyncStatus === 'error';
    if (activityState !== 'syncing' && !pendingRemoteWriteAt && !hasSyncError) {
        return null;
    }

    return (
        <Pressable
            accessibilityLabel={copy.accessibilityLabel}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.push({ pathname: '/settings', params: { settingsScreen: 'sync' } })}
            style={[
                styles.badge,
                {
                    top: insets.top + 10,
                    backgroundColor: tc.cardBg,
                    borderColor: hasSyncError ? tc.danger : tc.border,
                },
            ]}
        >
            {hasSyncError ? null : <ActivityIndicator color={tc.tint} size="small" />}
            <Text style={[styles.label, { color: tc.text }]}>{copy.label}</Text>
            {hasSyncError && lastSyncError ? (
                <Text numberOfLines={1} style={[styles.detail, { color: tc.secondaryText }]}>
                    {lastSyncError}
                </Text>
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    badge: {
        position: 'absolute',
        right: 12,
        zIndex: 30,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderRadius: 999,
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 3,
    },
    label: {
        fontSize: 13,
        fontWeight: '700',
    },
    detail: {
        maxWidth: 180,
        fontSize: 11,
        fontWeight: '600',
    },
});
