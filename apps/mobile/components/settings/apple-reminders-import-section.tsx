import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import type { StoreActionResult, Task } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { logSettingsError } from '@/lib/settings-utils';
import {
  type AppleReminderList,
  getAppleReminderLists,
  importAppleRemindersIntoInbox,
  loadAppleRemindersImportSettings,
  requestAppleRemindersPermission,
  saveAppleRemindersImportSettings,
} from '@/lib/apple-reminders-import';

import { styles } from './settings.styles';

type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;

type ToastOptions = {
  title: string;
  message: string;
  tone: 'warning' | 'error' | 'success' | 'info';
  durationMs?: number;
};

type Props = {
  addTask: (title: string, initialProps?: Partial<Task>) => Promise<StoreActionResult>;
  disabled: boolean;
  showToast: (options: ToastOptions) => void;
  tr: SettingsTranslator;
  tc: ThemeColors;
};

export function AppleRemindersImportSection({
  addTask,
  disabled,
  showToast,
  tr,
  tc,
}: Props) {
  const [selectedListId, setSelectedListId] = useState<string | undefined>();
  const [selectedListTitle, setSelectedListTitle] = useState<string | undefined>();
  const [lists, setLists] = useState<AppleReminderList[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingLists, setLoadingLists] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    loadAppleRemindersImportSettings()
      .then((settings) => {
        setSelectedListId(settings.selectedListId);
        setSelectedListTitle(settings.selectedListTitle);
      })
      .catch(logSettingsError);
  }, []);

  const showWarning = useCallback((message: string) => {
    showToast({
      title: tr('settings.appleRemindersImport.appleReminders'),
      message,
      tone: 'warning',
      durationMs: 4200,
    });
  }, [showToast, tr]);

  const openListPicker = useCallback(async () => {
    if (disabled || loadingLists || importing) return;
    setLoadingLists(true);
    try {
      const permission = await requestAppleRemindersPermission();
      if (permission !== 'granted') {
        showWarning(tr('settings.appleRemindersImport.permissionRequired'));
        return;
      }

      const nextLists = await getAppleReminderLists();
      setLists(nextLists);
      if (nextLists.length === 0) {
        showWarning(tr('settings.appleRemindersImport.noListsFound'));
        return;
      }
      setPickerOpen(true);
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.backupMobile.importFailed'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      setLoadingLists(false);
    }
  }, [disabled, importing, loadingLists, showToast, showWarning, tr]);

  const selectList = useCallback(async (list: AppleReminderList) => {
    try {
      const current = await loadAppleRemindersImportSettings();
      await saveAppleRemindersImportSettings({
        ...current,
        selectedListId: list.id,
        selectedListTitle: list.title,
      });
      setSelectedListId(list.id);
      setSelectedListTitle(list.title);
      setPickerOpen(false);
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.syncMobile.error'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    }
  }, [showToast, tr]);

  const importReminders = useCallback(async () => {
    if (disabled || importing) return;
    if (!selectedListId) {
      await openListPicker();
      return;
    }

    setImporting(true);
    try {
      const result = await importAppleRemindersIntoInbox({
        addTask,
        listId: selectedListId,
        listTitle: selectedListTitle,
      });
      const skippedCount = result.skippedDuplicateCount + result.skippedCompletedCount + result.skippedEmptyTitleCount;
      const details = [
        tr('settings.appleRemindersImport.importedCount', { taskCount: result.importedCount }),
        skippedCount > 0
          ? tr('settings.appleRemindersImport.skippedCount', { taskCount: skippedCount })
          : null,
        result.failedCount > 0
          ? tr('settings.appleRemindersImport.failedCount', { taskCount: result.failedCount })
          : null,
      ].filter(Boolean).join('\n');

      showToast({
        title: result.importedCount > 0
          ? tr('settings.backupMobile.importComplete')
          : tr('settings.appleRemindersImport.nothingNew'),
        message: details,
        tone: result.failedCount > 0 ? 'warning' : 'success',
        durationMs: 5200,
      });
    } catch (error) {
      logSettingsError(error);
      showToast({
        title: tr('settings.backupMobile.importFailed'),
        message: String(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      setImporting(false);
    }
  }, [addTask, disabled, importing, openListPicker, selectedListId, selectedListTitle, showToast, tr]);

  if (Platform.OS !== 'ios') return null;

  const busy = disabled || loadingLists || importing;

  return (
    <>
      <Text style={[styles.sectionTitle, { color: tc.text, marginTop: 24 }]}>
        {tr('settings.appleRemindersImport.appleReminders')}
      </Text>
      <View style={[styles.settingCard, { backgroundColor: tc.cardBg }]}>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={openListPicker}
          style={styles.settingRow}
          testID="apple-reminders-list-row"
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.text }]}>
              {tr('settings.appleRemindersImport.captureList')}
            </Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {selectedListTitle ?? tr('settings.appleRemindersImport.chooseCaptureList')}
            </Text>
          </View>
          {loadingLists ? (
            <ActivityIndicator size="small" color={tc.tint} />
          ) : (
            <Text style={[styles.chevron, { color: tc.secondaryText }]}>›</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          accessibilityRole="button"
          disabled={busy}
          onPress={() => void importReminders()}
          style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
          testID="apple-reminders-import-row"
        >
          <View style={styles.settingInfo}>
            <Text style={[styles.settingLabel, { color: tc.tint }]}>
              {tr('settings.appleRemindersImport.importIncomplete')}
            </Text>
            <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
              {tr('settings.appleRemindersImport.importIncompleteDescription')}
            </Text>
          </View>
          {importing && <ActivityIndicator size="small" color={tc.tint} />}
        </TouchableOpacity>
      </View>
      <Modal
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
        transparent
        visible={pickerOpen}
      >
        <Pressable style={styles.pickerOverlay} onPress={() => setPickerOpen(false)}>
          <Pressable style={[styles.pickerCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
            <Text style={[styles.pickerTitle, { color: tc.text }]}>
              {tr('settings.appleRemindersImport.chooseCaptureList')}
            </Text>
            <ScrollView style={styles.pickerList} contentContainerStyle={styles.pickerListContent}>
              {lists.map((list) => (
                <TouchableOpacity
                  key={list.id}
                  accessibilityRole="button"
                  onPress={() => void selectList(list)}
                  style={[
                    styles.pickerOption,
                    {
                      backgroundColor: list.id === selectedListId ? tc.filterBg : 'transparent',
                      borderColor: list.id === selectedListId ? tc.tint : tc.border,
                    },
                  ]}
                  testID={`apple-reminders-list-option-${list.id}`}
                >
                  <Text style={[styles.pickerOptionText, { color: tc.text }]}>{list.title}</Text>
                  {list.id === selectedListId && (
                    <Text style={[styles.pickerOptionText, { color: tc.tint }]}>
                      {tr('settings.appleRemindersImport.selected')}
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
