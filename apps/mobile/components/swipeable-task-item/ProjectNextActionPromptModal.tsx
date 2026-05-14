import React from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { tFallback } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { styles } from './swipeable-task-item.styles';

type ProjectNextActionPromptModalProps = {
    candidates: Task[];
    newTitle: string;
    projectTitle: string;
    tc: ThemeColors;
    t: (key: string) => string;
    visible: boolean;
    onAddTask: () => void;
    onCancel: () => void;
    onChooseTask: (taskId: string) => void;
    onNewTitleChange: (value: string) => void;
};

export function ProjectNextActionPromptModal({
    candidates,
    newTitle,
    projectTitle,
    tc,
    t,
    visible,
    onAddTask,
    onCancel,
    onChooseTask,
    onNewTitleChange,
}: ProjectNextActionPromptModalProps) {
    const canAddTask = newTitle.trim().length > 0;
    const description = tFallback(
        t,
        'projects.nextActionPromptDesc',
        'Choose or add the next action for {{project}}.',
    ).replace('{{project}}', projectTitle);

    return (
        <Modal
            visible={visible}
            transparent
            animationType="fade"
            onRequestClose={onCancel}
            accessibilityViewIsModal
        >
            <Pressable style={styles.modalOverlay} onPress={onCancel}>
                <Pressable
                    style={[styles.nextActionContainer, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                    onPress={() => {}}
                    accessibilityLabel={tFallback(t, 'projects.nextActionPromptTitle', "What's the next action?")}
                >
                    <Text style={[styles.menuTitle, { color: tc.text }]} accessibilityRole="header">
                        {tFallback(t, 'projects.nextActionPromptTitle', "What's the next action?")}
                    </Text>
                    <Text style={[styles.nextActionDescription, { color: tc.secondaryText }]}>
                        {description}
                    </Text>

                    {candidates.length > 0 ? (
                        <View style={styles.nextActionSection}>
                            <Text style={[styles.nextActionSectionLabel, { color: tc.secondaryText }]}>
                                {tFallback(t, 'projects.nextActionPromptChooseExisting', 'Choose an existing task')}
                            </Text>
                            <ScrollView style={styles.nextActionCandidateList} keyboardShouldPersistTaps="handled">
                                {candidates.map((candidate) => (
                                    <Pressable
                                        key={candidate.id}
                                        style={[styles.nextActionCandidate, { borderColor: tc.border, backgroundColor: tc.inputBg }]}
                                        onPress={() => onChooseTask(candidate.id)}
                                        accessibilityRole="button"
                                        accessibilityLabel={candidate.title}
                                    >
                                        <Text style={[styles.nextActionCandidateTitle, { color: tc.text }]}>
                                            {candidate.title}
                                        </Text>
                                        <Text style={[styles.nextActionCandidateMeta, { color: tc.secondaryText }]}>
                                            {t(`status.${candidate.status}`)}
                                        </Text>
                                    </Pressable>
                                ))}
                            </ScrollView>
                        </View>
                    ) : null}

                    <View style={styles.nextActionSection}>
                        <Text style={[styles.nextActionSectionLabel, { color: tc.secondaryText }]}>
                            {tFallback(t, 'projects.nextActionPromptAddNew', 'Add a new next action')}
                        </Text>
                        <TextInput
                            value={newTitle}
                            onChangeText={onNewTitleChange}
                            placeholder={tFallback(t, 'projects.nextActionPromptPlaceholder', 'New next action...')}
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={tFallback(t, 'projects.nextActionPromptAddNew', 'Add a new next action')}
                            style={[
                                styles.nextActionInput,
                                { color: tc.text, backgroundColor: tc.inputBg, borderColor: tc.border },
                            ]}
                            returnKeyType="done"
                            onSubmitEditing={() => {
                                if (canAddTask) onAddTask();
                            }}
                        />
                    </View>

                    <View style={styles.nextActionActions}>
                        <Pressable
                            style={[styles.nextActionSecondaryButton, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                            onPress={onCancel}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'common.skip', 'Skip')}
                        >
                            <Text style={[styles.nextActionSecondaryText, { color: tc.text }]}>
                                {tFallback(t, 'common.skip', 'Skip')}
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[
                                styles.nextActionPrimaryButton,
                                { backgroundColor: canAddTask ? tc.tint : tc.filterBg },
                            ]}
                            onPress={onAddTask}
                            disabled={!canAddTask}
                            accessibilityRole="button"
                            accessibilityLabel={tFallback(t, 'projects.nextActionPromptAddButton', 'Add next action')}
                            accessibilityState={{ disabled: !canAddTask }}
                        >
                            <Text style={[styles.nextActionPrimaryText, { color: canAddTask ? tc.onTint : tc.secondaryText }]}>
                                {tFallback(t, 'projects.nextActionPromptAddButton', 'Add next action')}
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </Modal>
    );
}
