import { View, Text, FlatList, Pressable, StyleSheet, Alert } from 'react-native';
import { getInlineMarkdownPreview, projectMatchesAreaFilter, shallow, taskMatchesAreaFilter, useTaskStore } from '@mindwtr/core';
import type { Project, Task } from '@mindwtr/core';
import { MarkdownInlineText } from '@/components/markdown-text';
import { useTheme } from '../../contexts/theme-context';
import { useLanguage } from '../../contexts/language-context';

import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useThemeColors, ThemeColors } from '@/hooks/use-theme-colors';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';

type TrashListItem =
  | { type: 'project'; project: Project }
  | { type: 'task'; task: Task };

function TrashSwipeRow({
  children,
  onRestore,
  onDelete,
}: {
  children: ReactNode;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const swipeableRef = useRef<Swipeable>(null);

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
      {children}
    </Swipeable>
  );
}

function TrashTaskItem({
  task,
  tc,
  onRestore,
  onDelete,
  isHighlighted,
  typeLabel,
  deletedLabel,
}: {
  task: Task;
  tc: ThemeColors;
  onRestore: () => void;
  onDelete: () => void;
  isHighlighted?: boolean;
  typeLabel: string;
  deletedLabel: string;
}) {
  return (
    <TrashSwipeRow onRestore={onRestore} onDelete={onDelete}>
      <View
        style={[
          styles.taskItem,
          { backgroundColor: tc.taskItemBg },
          isHighlighted && { borderWidth: 2, borderColor: tc.tint },
        ]}
      >
        <View style={styles.taskContent}>
          <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
            {task.title}
          </Text>
          {task.description && (
            <MarkdownInlineText
              markdown={getInlineMarkdownPreview(task.description)}
              tc={tc}
              style={[styles.taskDescription, { color: tc.secondaryText }]}
              numberOfLines={1}
            />
          )}
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{typeLabel}</Text>
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{deletedLabel}: {task.deletedAt ? new Date(task.deletedAt).toLocaleDateString() : 'Unknown'}</Text>
        </View>
        <View style={[styles.statusIndicator, { backgroundColor: '#6B7280' }]} />
      </View>
    </TrashSwipeRow>
  );
}

function TrashProjectItem({
  project,
  tc,
  onRestore,
  onDelete,
  typeLabel,
  deletedLabel,
}: {
  project: Project;
  tc: ThemeColors;
  onRestore: () => void;
  onDelete: () => void;
  typeLabel: string;
  deletedLabel: string;
}) {
  return (
    <TrashSwipeRow onRestore={onRestore} onDelete={onDelete}>
      <View style={[styles.taskItem, { backgroundColor: tc.taskItemBg }]}>
        <View style={styles.taskContent}>
          <Text style={[styles.taskTitle, { color: tc.secondaryText }]} numberOfLines={2}>
            {project.title}
          </Text>
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{typeLabel}</Text>
          <Text style={[styles.archivedDate, { color: tc.secondaryText }]}>{deletedLabel}: {project.deletedAt ? new Date(project.deletedAt).toLocaleDateString() : 'Unknown'}</Text>
        </View>
        <View style={[styles.statusIndicator, { backgroundColor: project.color || '#6B7280' }]} />
      </View>
    </TrashSwipeRow>
  );
}

export default function TrashScreen() {
  const {
    _allTasks,
    _allProjects,
    projects,
    restoreTask,
    restoreProject,
    purgeTask,
    purgeProject,
    purgeDeletedTasks,
    purgeDeletedProjects,
    highlightTaskId,
    setHighlightTask,
  } = useTaskStore((state) => ({
    _allTasks: state._allTasks,
    _allProjects: state._allProjects,
    projects: state.projects,
    restoreTask: state.restoreTask,
    restoreProject: state.restoreProject,
    purgeTask: state.purgeTask,
    purgeProject: state.purgeProject,
    purgeDeletedTasks: state.purgeDeletedTasks,
    purgeDeletedProjects: state.purgeDeletedProjects,
    highlightTaskId: state.highlightTaskId,
    setHighlightTask: state.setHighlightTask,
  }), shallow);
  const { t } = useLanguage();
  useTheme();
  const tc = useThemeColors();
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const trashedTasks = useMemo(() => _allTasks.filter((task) => (
    task.deletedAt
    && !task.purgedAt
    && taskMatchesAreaFilter(task, resolvedAreaFilter, projectById, areaById)
  )), [_allTasks, areaById, projectById, resolvedAreaFilter]);

  const trashedProjects = useMemo(() => _allProjects
    .filter((project) => (
      project.deletedAt
      && !project.purgedAt
      && projectMatchesAreaFilter(project, resolvedAreaFilter, areaById)
    ))
    .sort((left, right) => {
      const leftDeletedAt = left.deletedAt ?? '';
      const rightDeletedAt = right.deletedAt ?? '';
      if (leftDeletedAt !== rightDeletedAt) return rightDeletedAt.localeCompare(leftDeletedAt);
      return left.title.localeCompare(right.title);
    }), [_allProjects, areaById, resolvedAreaFilter]);

  const trashItems = useMemo<TrashListItem[]>(() => [
    ...trashedProjects.map((project) => ({ type: 'project' as const, project })),
    ...trashedTasks.map((task) => ({ type: 'task' as const, task })),
  ], [trashedProjects, trashedTasks]);

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

  const handleRestoreTask = (taskId: string) => {
    restoreTask(taskId);
  };

  const handleRestoreProject = (projectId: string) => {
    restoreProject(projectId);
  };

  const handleDeleteTask = (taskId: string) => {
    Alert.alert(
      t('trash.deleteConfirm') || 'Delete Permanently?',
      t('trash.deleteConfirmBody') || 'This action cannot be undone.',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('trash.deletePermanently') || 'Delete',
          style: 'destructive',
          onPress: () => purgeTask(taskId),
        },
      ]
    );
  };

  const handleDeleteProject = (projectId: string) => {
    Alert.alert(
      t('trash.deleteConfirm') || 'Delete Permanently?',
      t('trash.deleteConfirmBody') || 'This action cannot be undone.',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('trash.deletePermanently') || 'Delete',
          style: 'destructive',
          onPress: () => purgeProject(projectId),
        },
      ]
    );
  };

  const handleClearAll = () => {
    if (trashItems.length === 0) return;
    Alert.alert(
      t('trash.clearAllConfirm') || 'Clear trash?',
      t('trash.clearAllConfirmBodyWithProjects') || 'This will permanently delete all trashed tasks and projects.',
      [
        { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        {
          text: t('trash.clearAll') || 'Clear Trash',
          style: 'destructive',
          onPress: () => {
            void purgeDeletedTasks();
            void purgeDeletedProjects();
          },
        },
      ]
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
        {trashItems.length > 0 && (
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryText, { color: tc.secondaryText }]}>
              {trashedTasks.length} {t('common.tasks') || 'tasks'} · {trashedProjects.length} {t('projects.title') || 'projects'}
            </Text>
            <Pressable
              onPress={handleClearAll}
              style={[styles.clearButton, { borderColor: tc.border, backgroundColor: tc.cardBg }]}
            >
              <Text style={[styles.clearButtonText, { color: tc.secondaryText }]}>
                {t('trash.clearAll') || 'Clear Trash'}
              </Text>
            </Pressable>
          </View>
        )}
        <FlatList
          data={trashItems}
          renderItem={({ item }) => (
            item.type === 'project'
              ? (
                <TrashProjectItem
                  project={item.project}
                  tc={tc}
                  onRestore={() => handleRestoreProject(item.project.id)}
                  onDelete={() => handleDeleteProject(item.project.id)}
                  typeLabel={t('trash.projectType') || 'Project'}
                  deletedLabel={t('trash.deletedAt') || 'Deleted'}
                />
              )
              : (
                <TrashTaskItem
                  task={item.task}
                  tc={tc}
                  onRestore={() => handleRestoreTask(item.task.id)}
                  onDelete={() => handleDeleteTask(item.task.id)}
                  isHighlighted={item.task.id === highlightTaskId}
                  typeLabel={t('trash.taskType') || 'Task'}
                  deletedLabel={t('trash.deletedAt') || 'Deleted'}
                />
              )
          )}
          keyExtractor={(item) => item.type === 'project' ? 'project-' + item.project.id : 'task-' + item.task.id}
          style={styles.taskList}
          contentContainerStyle={[
            styles.taskListContent,
            trashItems.length === 0 && styles.emptyContent,
          ]}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={5}
          updateCellsBatchingPeriod={50}
          removeClippedSubviews={false}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>🗑️</Text>
              <Text style={[styles.emptyTitle, { color: tc.text }]}>
                {t('trash.empty') || 'Trash is empty'}
              </Text>
              <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('trash.emptyHintWithProjects') || 'Deleted tasks and projects will appear here'}</Text>
            </View>
          }
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  summaryText: {
    fontSize: 13,
    fontWeight: '500',
  },
  clearButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  clearButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  taskList: {
    flex: 1,
  },
  taskListContent: {
    padding: 16,
  },
  emptyContent: {
    flexGrow: 1,
    justifyContent: 'center',
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
    paddingVertical: 40,
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
  },
  swipeActionRestore: {
    backgroundColor: '#22c55e',
    justifyContent: 'center',
    alignItems: 'center',
    width: 120,
    borderRadius: 12,
    marginBottom: 12,
  },
  swipeActionDelete: {
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
    width: 120,
    borderRadius: 12,
    marginBottom: 12,
  },
  swipeActionText: {
    color: 'white',
    fontWeight: '600',
  },
});
