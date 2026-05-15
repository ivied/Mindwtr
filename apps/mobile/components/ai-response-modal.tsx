import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '@/hooks/use-theme-colors';

export type AIResponseAction = {
    label: string;
    onPress: () => void;
    variant?: 'primary' | 'secondary';
};

interface AIResponseModalProps {
    visible: boolean;
    title: string;
    message?: string;
    actions: AIResponseAction[];
    onClose: () => void;
}

export function AIResponseModal({ visible, title, message, actions, onClose }: AIResponseModalProps) {
    const tc = useThemeColors();

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onClose}
        >
            <Pressable style={styles.overlay} onPress={onClose}>
                <Pressable style={[styles.card, { backgroundColor: tc.cardBg, borderColor: tc.border }]} onPress={() => {}}>
                    <Text style={[styles.title, { color: tc.text }]}>{title}</Text>
                    {message ? (
                        <ScrollView style={styles.messageContainer}>
                            <Text style={[styles.message, { color: tc.secondaryText }]}>{message}</Text>
                        </ScrollView>
                    ) : null}
                    <View style={styles.actions}>
                        {actions.map((action, index) => {
                            const isPrimary = action.variant === 'primary';
                            return (
                                <TouchableOpacity
                                    key={`${action.label}-${index}`}
                                    style={[
                                        styles.actionButton,
                                        {
                                            borderColor: tc.border,
                                            backgroundColor: isPrimary ? tc.tint : tc.filterBg,
                                        },
                                    ]}
                                    onPress={action.onPress}
                                >
                                    <Text
                                        style={[
                                            styles.actionText,
                                            { color: isPrimary ? '#FFFFFF' : tc.text },
                                        ]}
                                    >
                                        {action.label}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'center',
        padding: 24,
    },
    card: {
        borderRadius: 16,
        borderWidth: 1,
        padding: 20,
        gap: 12,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
    },
    messageContainer: {
        maxHeight: 220,
    },
    message: {
        fontSize: 14,
        lineHeight: 20,
    },
    actions: {
        gap: 10,
        marginTop: 4,
    },
    actionButton: {
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
    },
    actionText: {
        fontSize: 14,
        fontWeight: '600',
        textAlign: 'center',
    },
});
