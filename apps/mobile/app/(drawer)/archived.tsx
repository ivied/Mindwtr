import React, { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { View, Text, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import { safeFormatDate, useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors } from '@/hooks/use-theme-colors';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { taskMatchesAreaFilter } from '@/lib/area-filter';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { TaskEditModal } from '@/components/task-edit-modal';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Archive } from 'lucide-react-native';

function ArchivedTaskItem({
    task,
    tc,
    onOpen,
    onRestore,
    onDelete,
    completedLabel,
    isHighlighted
}: {
    task: Task;
    tc: ThemeColors;
    onOpen: () => void;
    onRestore: () => void;
    onDelete: () => void;
    completedLabel: string;
    isHighlighted?: boolean;
}) {
    const swipeableRef = useRef<Swipeable>(null);
    const completionTimestamp = task.completedAt || task.updatedAt;
    const completionDateLabel = completionTimestamp
        ? safeFormatDate(completionTimestamp, 'Pp', completionTimestamp)
        : 'Unknown';

    const renderLeftActions = () => (
        <Pressable
            style={styles.swipeActionRestore}
            onPress={() => {
                swipeableRef.current?.close();
                onRestore();
            }}
        >
            <Text style={styles.swipeActionText}>↩️ Restore</Text>
        </Pressable>
    );

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeActionDelete}
            onPress={() => {
                swipeableRef.current?.close();
                onDelete();
            }}
        >
            <Text style={styles.swipeActionText}>🗑️ Delete</Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderLeftActions={renderLeftActions}
            renderRightActions={renderRightActions}
            overshootLeft={false}
            overshootRight={false}
        >
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open archived task details: ${task.title}`}
                onPress={onOpen}
                style={({ pressed }) => [
                    styles.taskItem,
                    { backgroundColor: tc.taskItemBg },
                    pressed && styles.taskItemPressed,
                    isHighlighted && { borderWidth: 2, borderColor: tc.tint },
                ]}
            >
                <View style={styles.taskContent}>
                    <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
                        {task.title}
                    </Text>
                    {task.description && (
                        <Text style={[styles.taskDescription, { color: tc.secondaryText }]} numberOfLines={1}>
                            {task.description}
                        </Text>
                    )}
                    <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>
                        {completedLabel}: {completionDateLabel}
                    </Text>
                </View>
                <View style={[styles.statusIndicator, { backgroundColor: '#6B7280' }]} />
            </Pressable>
        </Swipeable>
    );
}

export default function ArchivedScreen() {
    const { _allTasks, projects, updateTask, purgeTask, highlightTaskId, setHighlightTask } = useTaskStore();
    const { t } = useLanguage();
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

    const tc = useThemeColors();
    const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
    const projectById = useMemo(
        () => new Map(projects.map((project) => [project.id, project])),
        [projects],
    );

    const archivedTasks = useMemo(
        () => _allTasks.filter((task) => (
            task.status === 'archived'
            && !task.deletedAt
            && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
        )),
        [_allTasks, resolvedAreaFilter, projectById, areaById],
    );
    const selectedTask = useMemo(
        () => selectedTaskId ? _allTasks.find((task) => task.id === selectedTaskId && !task.deletedAt) ?? null : null,
        [_allTasks, selectedTaskId],
    );

    const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (!highlightTaskId) return;
        if (highlightTimerRef.current) {
            clearTimeout(highlightTimerRef.current);
        }
        highlightTimerRef.current = setTimeout(() => {
            setHighlightTask(null);
        }, 3500);
        return () => {
            if (highlightTimerRef.current) {
                clearTimeout(highlightTimerRef.current);
            }
        };
    }, [highlightTaskId, setHighlightTask]);

    useEffect(() => {
        if (selectedTaskId && !selectedTask) {
            setSelectedTaskId(null);
        }
    }, [selectedTask, selectedTaskId]);

    const handleOpenTask = useCallback((taskId: string) => {
        setSelectedTaskId(taskId);
    }, []);

    const handleSaveTask = useCallback((taskId: string, updates: Partial<Task>) => {
        updateTask(taskId, updates);
        setSelectedTaskId(null);
    }, [updateTask]);

    const handleRestore = useCallback((taskId: string) => {
        updateTask(taskId, { status: 'inbox' });
    }, [updateTask]);

    const handleDelete = useCallback((taskId: string) => {
        Alert.alert(
            'Delete Permanently?',
            'This action cannot be undone.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => purgeTask(taskId)
                },
            ]
        );
    }, [purgeTask]);

    const renderArchivedTask = useCallback(({ item }: { item: Task }) => (
        <ArchivedTaskItem
            task={item}
            tc={tc}
            onOpen={() => handleOpenTask(item.id)}
            onRestore={() => handleRestore(item.id)}
            onDelete={() => handleDelete(item.id)}
            completedLabel={t('list.done') || 'Completed'}
            isHighlighted={item.id === highlightTaskId}
        />
    ), [tc, handleDelete, handleOpenTask, handleRestore, highlightTaskId]);

    return (
        <GestureHandlerRootView style={{ flex: 1 }}>
            <View style={[styles.container, { backgroundColor: tc.bg }]}>
                {archivedTasks.length > 0 && (
                    <View style={styles.summaryRow}>
                        <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
                            {archivedTasks.length} {t('common.tasks') || 'tasks'}
                        </Text>
                    </View>
                )}
                <FlatList
                    data={archivedTasks}
                    renderItem={renderArchivedTask}
                    keyExtractor={(item) => item.id}
                    extraData={highlightTaskId}
                    style={styles.taskList}
                    contentContainerStyle={[
                        styles.taskListContent,
                        archivedTasks.length === 0 && styles.emptyContent,
                    ]}
                    initialNumToRender={12}
                    maxToRenderPerBatch={12}
                    windowSize={5}
                    updateCellsBatchingPeriod={50}
                    removeClippedSubviews={archivedTasks.length >= 25}
                    showsVerticalScrollIndicator={false}
                    ListEmptyComponent={
                        <View style={styles.emptyState}>
                            <Archive size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                            <Text style={[styles.emptyTitle, { color: tc.text }]}>
                                {t('archived.empty') || 'No archived tasks'}
                            </Text>
                            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                {t('archived.emptyHint') || 'Tasks you archive will appear here'}
                            </Text>
                        </View>
                    }
                />
                <TaskEditModal
                    visible={Boolean(selectedTask)}
                    task={selectedTask}
                    onClose={() => setSelectedTaskId(null)}
                    onSave={handleSaveTask}
                    defaultTab="view"
                    onProjectNavigate={openProjectScreen}
                    onContextNavigate={openContextsScreen}
                    onTagNavigate={openContextsScreen}
                />
            </View>
        </GestureHandlerRootView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    summaryRow: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 2,
    },
    summaryText: {
        fontSize: 13,
        fontWeight: '500',
    },
    taskList: {
        flex: 1,
    },
    taskListContent: {
        padding: 16,
    },
    emptyContent: {
        flexGrow: 1,
    },
    taskItem: {
        flexDirection: 'row',
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 2,
    },
    taskItemPressed: {
        opacity: 0.85,
    },
    taskContent: {
        flex: 1,
    },
    taskTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
        textDecorationLine: 'line-through',
    },
    taskDescription: {
        fontSize: 14,
        marginBottom: 4,
    },
    archivedDate: {
        fontSize: 12,
        fontStyle: 'italic',
    },
    statusIndicator: {
        width: 4,
        borderRadius: 2,
        marginLeft: 12,
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 48,
        paddingHorizontal: 24,
    },
    emptyIcon: {
        marginBottom: 16,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 8,
    },
    emptyText: {
        fontSize: 14,
        textAlign: 'center',
    },
    swipeActionRestore: {
        backgroundColor: '#3B82F6',
        justifyContent: 'center',
        alignItems: 'center',
        width: 100,
        borderRadius: 12,
        marginBottom: 12,
        marginRight: 8,
    },
    swipeActionDelete: {
        backgroundColor: '#EF4444',
        justifyContent: 'center',
        alignItems: 'center',
        width: 100,
        borderRadius: 12,
        marginBottom: 12,
        marginLeft: 8,
    },
    swipeActionText: {
        color: '#FFFFFF',
        fontWeight: '600',
        fontSize: 14,
    },
});
