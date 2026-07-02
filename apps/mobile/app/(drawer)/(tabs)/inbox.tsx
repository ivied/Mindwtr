import { useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Brain, ListChecks } from 'lucide-react-native';

import { isTaskInActiveProject, shallow, useTaskStore } from '@mindwtr/core';
import { TaskList, type ReferenceGroupBy } from '../../../components/task-list';
import { InboxProcessingModal } from '../../../components/inbox-processing-modal';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

import { useLanguage } from '../../../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CompactText } from '@/components/compact-text';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { taskMatchesAreaFilter } from '@mindwtr/core';
import { useQuickCapture } from '../../../contexts/quick-capture-context';

export default function InboxScreen() {
  const { tasks, projects, settings } = useTaskStore((state) => ({
    tasks: state.tasks,
    projects: state.projects,
    settings: state.settings,
  }), shallow);
  const { t } = useLanguage();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const { openQuickCapture } = useQuickCapture();
  const router = useRouter();
  const [showProcessing, setShowProcessing] = useState(false);
  const [groupBy, setGroupBy] = useState<ReferenceGroupBy>('none');
  const { areaById, resolvedAreaFilter } = useMobileAreaFilter();
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const inboxTasks = useMemo(() => {
    return tasks.filter(t => {
      if (t.deletedAt) return false;
      if (t.status !== 'inbox') return false;
      if (!isTaskInActiveProject(t, projectById)) return false;
      if (!taskMatchesAreaFilter(t, resolvedAreaFilter, projectById, areaById)) return false;
      return true;
    });
  }, [tasks, resolvedAreaFilter, projectById, areaById]);

  const defaultCaptureMethod = settings.gtd?.defaultCaptureMethod ?? 'text';
  const emptyHint = defaultCaptureMethod === 'audio'
    ? t('inbox.emptyAddHintVoice')
    : t('inbox.emptyAddHint');
  const emptyActionLabel = defaultCaptureMethod === 'audio'
    ? t('quickAdd.audioCaptureLabel')
    : t('nav.addTask');

  const hasInboxTasks = inboxTasks.length > 0;
  const processCount = inboxTasks.length > 99 ? '99+' : `${inboxTasks.length}`;

  // Mind Sweep (secondary, labeled) rides on the sort/filter row's empty right
  // side when there are tasks to process; when the inbox is empty it is promoted
  // to the full-width primary slot below.
  const mindSweepPill = (
    <TouchableOpacity
      style={[styles.mindSweepPill, { borderColor: tc.tint, backgroundColor: tc.filterBg }]}
      onPress={() => router.push('/mind-sweep-modal')}
      accessibilityRole="button"
      accessibilityLabel={t('mindSweep.launchButton')}
    >
      <Brain size={18} color={tc.tint} strokeWidth={2.2} />
      <CompactText
        style={[styles.mindSweepLabel, { color: tc.tint }]}
        numberOfLines={2}
      >
        {t('mindSweep.launchButton')}
      </CompactText>
    </TouchableOpacity>
  );

  // Full-width primary action below the controls: Process Inbox when there is
  // something to clarify, otherwise the promoted Mind Sweep entry point.
  const primaryActionRow = (
    <View style={styles.actionRow}>
      {hasInboxTasks ? (
        <TouchableOpacity
          style={[styles.processButton, { backgroundColor: filledButton.backgroundColor }]}
          onPress={() => setShowProcessing(true)}
          accessibilityRole="button"
          accessibilityLabel={`${t('inbox.processButton')} (${inboxTasks.length})`}
        >
          <ListChecks size={18} color={filledButton.textColor ?? tc.onTint} strokeWidth={2.2} />
          <CompactText
            style={[styles.actionLabel, { color: filledButton.textColor ?? tc.onTint }]}
            numberOfLines={2}
          >
            {t('inbox.processButton')} ({processCount})
          </CompactText>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={[styles.processButton, { backgroundColor: filledButton.backgroundColor }]}
          onPress={() => router.push('/mind-sweep-modal')}
          accessibilityRole="button"
          accessibilityLabel={t('mindSweep.launchButton')}
        >
          <Brain size={18} color={filledButton.textColor ?? tc.onTint} strokeWidth={2.2} />
          <CompactText
            style={[styles.actionLabel, { color: filledButton.textColor ?? tc.onTint }]}
            numberOfLines={2}
          >
            {t('mindSweep.launchButton')}
          </CompactText>
        </TouchableOpacity>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <TaskList
        statusFilter="inbox"
        title={t('inbox.title')}
        showHeader={false}
        enableBulkActions
        enableInboxBulkOrganize
        allowAdd
        showQuickAddHelp={false}
        emptyText={t('inbox.empty')}
        emptyHint={emptyHint}
        emptyActionLabel={emptyActionLabel}
        onEmptyAction={() => openQuickCapture({ autoRecord: defaultCaptureMethod === 'audio' })}
        headerAccessory={hasInboxTasks ? mindSweepPill : undefined}
        groupBy={groupBy}
        onChangeGroupBy={setGroupBy}
        primaryActionRow={primaryActionRow}
        defaultEditTab="task"
      />
      <ErrorBoundary>
        <InboxProcessingModal
          visible={showProcessing}
          onClose={() => setShowProcessing(false)}
        />
      </ErrorBoundary>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  processButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  actionLabel: {
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  mindSweepPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
  },
  mindSweepLabel: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});
