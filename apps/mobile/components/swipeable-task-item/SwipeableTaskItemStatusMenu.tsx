import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { getStatusColor, TaskStatus } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { styles } from './swipeable-task-item.styles';

interface SwipeableTaskItemStatusMenuProps {
    onClose: () => void;
    onStatusChange: (status: TaskStatus) => void;
    taskStatus: TaskStatus;
    tc: ThemeColors;
    t: (key: string) => string;
    visible: boolean;
}

const QUICK_STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];

export function SwipeableTaskItemStatusMenu({
    onClose,
    onStatusChange,
    taskStatus,
    tc,
    t,
    visible,
}: SwipeableTaskItemStatusMenuProps) {
    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
            accessibilityViewIsModal
        >
            <Pressable style={styles.modalOverlay} onPress={onClose}>
                <View style={[styles.menuContainer, { backgroundColor: tc.cardBg }]}>
                    <Text style={[styles.menuTitle, { color: tc.text }]} accessibilityRole="header">
                        {t('taskStatus.changeStatus')}
                    </Text>
                    <View style={styles.menuGrid}>
                        {QUICK_STATUS_OPTIONS.map((status) => {
                            const colors = getStatusColor(status);
                            return (
                                <Pressable
                                    key={status}
                                    style={[
                                        styles.menuItem,
                                        taskStatus === status && { backgroundColor: colors.bg },
                                        { borderColor: colors.text },
                                    ]}
                                    onPress={() => {
                                        onStatusChange(status);
                                        onClose();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t(`status.${status}`)}
                                    accessibilityState={{ selected: taskStatus === status }}
                                >
                                    <View style={[styles.menuDot, { backgroundColor: colors.text }]} />
                                    <Text style={[styles.menuText, { color: tc.text }]}>{t(`status.${status}`)}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </View>
            </Pressable>
        </Modal>
    );
}
