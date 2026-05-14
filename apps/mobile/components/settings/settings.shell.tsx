import React from 'react';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ChevronRight, type LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/hooks/use-theme-colors';
import { useLanguage } from '@/contexts/language-context';

import { styles } from './settings.styles';

type MenuItemIcon = LucideIcon;

export function SubHeader({ title }: { title: string }) {
    const tc = useThemeColors();

    return (
        <View style={styles.subHeader}>
            <Text style={[styles.subHeaderTitle, { color: tc.text }]}>{title}</Text>
        </View>
    );
}

export function MenuItem({
    title,
    description,
    icon: Icon,
    onPress,
    isLast,
    showIndicator,
    indicatorColor,
    indicatorAccessibilityLabel,
}: {
    title: string;
    description?: string;
    icon?: MenuItemIcon;
    onPress: () => void;
    isLast?: boolean;
    showIndicator?: boolean;
    indicatorColor?: string;
    indicatorAccessibilityLabel?: string;
}) {
    const tc = useThemeColors();
    const accessibilityLabel = [
        title,
        description,
        indicatorAccessibilityLabel,
    ].filter(Boolean).join('. ');

    return (
        <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            activeOpacity={0.72}
            style={[
                styles.menuItem,
                Icon || description ? styles.menuItemDetailed : null,
                {
                    borderBottomColor: tc.border,
                    borderBottomWidth: isLast ? 0 : 1,
                },
            ]}
            onPress={onPress}
        >
            <View style={styles.menuLeft}>
                {Icon && (
                    <View style={styles.menuIconSlot} pointerEvents="none">
                        <Icon color={tc.secondaryText} size={20} strokeWidth={2} />
                    </View>
                )}
                <View style={styles.menuTextBlock}>
                    <Text style={[styles.menuLabel, { color: tc.text }]} numberOfLines={1}>
                        {title}
                    </Text>
                    {description && (
                        <Text style={[styles.menuDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                            {description}
                        </Text>
                    )}
                </View>
            </View>
            <View style={styles.menuRight}>
                {showIndicator && (
                    <View
                        accessibilityLabel={indicatorAccessibilityLabel}
                        accessibilityRole="text"
                        style={[styles.updateDot, indicatorColor ? { backgroundColor: indicatorColor } : null]}
                    />
                )}
                <ChevronRight color={tc.secondaryText} size={20} strokeWidth={2.2} />
            </View>
        </TouchableOpacity>
    );
}

export function SettingsTopBar({ title }: { title?: string } = {}) {
    const router = useRouter();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const insets = useSafeAreaInsets();
    const canGoBack = router.canGoBack();
    const backText = t('common.back');

    return (
        <View
            style={[
                styles.topBar,
                {
                    backgroundColor: tc.cardBg,
                    borderBottomColor: tc.border,
                    height: 52 + insets.top,
                    paddingTop: insets.top,
                },
            ]}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={backText}
                disabled={!canGoBack}
                hitSlop={8}
                onPress={() => {
                    if (canGoBack) router.back();
                }}
                style={[styles.topBarBackButton, !canGoBack && styles.topBarBackButtonHidden]}
            >
                <Ionicons color={tc.text} name="chevron-back" size={24} />
            </Pressable>
            <Text style={[styles.topBarTitle, { color: tc.text }]} numberOfLines={1}>
                {title ?? t('settings.title')}
            </Text>
            <View style={styles.topBarBackButton} />
        </View>
    );
}
