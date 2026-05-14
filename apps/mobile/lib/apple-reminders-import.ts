import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import type { StoreActionResult, Task } from '@mindwtr/core';

export const APPLE_REMINDERS_IMPORT_SETTINGS_KEY = 'mindwtr-apple-reminders-import-v1';

export type AppleRemindersPermissionStatus = 'unavailable' | 'undetermined' | 'granted' | 'denied';

export type AppleRemindersImportSettings = {
  selectedListId?: string;
  selectedListTitle?: string;
  importedReminderIds: string[];
};

export type AppleReminderList = {
  id: string;
  title: string;
  color?: string;
};

export type AppleRemindersImportResult = {
  importedCount: number;
  skippedDuplicateCount: number;
  skippedCompletedCount: number;
  skippedEmptyTitleCount: number;
  failedCount: number;
};

export type AddInboxTask = (title: string, props?: Partial<Task>) => Promise<StoreActionResult>;

const DEFAULT_IMPORT_SETTINGS: AppleRemindersImportSettings = {
  importedReminderIds: [],
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizePermissionStatus = (status: unknown): AppleRemindersPermissionStatus => {
  if (status === 'granted' || status === 'denied' || status === 'undetermined') return status;
  return 'denied';
};

const normalizeDateKey = (value: unknown): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  return normalizeString(value);
};

const getReminderImportKey = (reminder: Calendar.Reminder, listId: string, title: string): string => {
  const reminderId = normalizeString(reminder.id);
  if (reminderId) return reminderId;

  return [
    'fallback',
    listId,
    title,
    normalizeString(reminder.notes) ?? '',
    normalizeDateKey(reminder.creationDate) ?? '',
    normalizeDateKey(reminder.startDate) ?? '',
    normalizeDateKey(reminder.dueDate) ?? '',
  ].join(':');
};

export function normalizeAppleRemindersImportSettings(value: unknown): AppleRemindersImportSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_IMPORT_SETTINGS };
  const raw = value as Partial<AppleRemindersImportSettings>;
  const selectedListId = normalizeString(raw.selectedListId);
  const selectedListTitle = normalizeString(raw.selectedListTitle);
  const importedReminderIds = Array.isArray(raw.importedReminderIds)
    ? Array.from(new Set(raw.importedReminderIds.map(normalizeString).filter((id): id is string => Boolean(id))))
    : [];

  return {
    ...(selectedListId ? { selectedListId } : {}),
    ...(selectedListTitle ? { selectedListTitle } : {}),
    importedReminderIds,
  };
}

export async function loadAppleRemindersImportSettings(): Promise<AppleRemindersImportSettings> {
  const raw = await AsyncStorage.getItem(APPLE_REMINDERS_IMPORT_SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_IMPORT_SETTINGS };
  try {
    return normalizeAppleRemindersImportSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_IMPORT_SETTINGS };
  }
}

export async function saveAppleRemindersImportSettings(settings: AppleRemindersImportSettings): Promise<void> {
  const normalized = normalizeAppleRemindersImportSettings(settings);
  await AsyncStorage.setItem(APPLE_REMINDERS_IMPORT_SETTINGS_KEY, JSON.stringify(normalized));
}

export async function getAppleRemindersPermissionStatus(): Promise<AppleRemindersPermissionStatus> {
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    const result = await Calendar.getRemindersPermissionsAsync();
    return normalizePermissionStatus(result.status);
  } catch {
    return 'denied';
  }
}

export async function requestAppleRemindersPermission(): Promise<AppleRemindersPermissionStatus> {
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    const result = await Calendar.requestRemindersPermissionsAsync();
    return normalizePermissionStatus(result.status);
  } catch {
    return 'denied';
  }
}

export async function getAppleReminderLists(): Promise<AppleReminderList[]> {
  if (Platform.OS !== 'ios') return [];
  const permission = await getAppleRemindersPermissionStatus();
  if (permission !== 'granted') return [];

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
  const lists: AppleReminderList[] = [];
  for (const calendar of calendars) {
    const id = normalizeString(calendar.id);
    if (!id) continue;
    const legacyName = normalizeString((calendar as Calendar.Calendar & { name?: string }).name);
    const color = normalizeString(calendar.color);
    lists.push({
      id,
      title: normalizeString(calendar.title) ?? legacyName ?? 'Reminders',
      ...(color ? { color } : {}),
    });
  }
  return lists.sort((a, b) => a.title.localeCompare(b.title));
}

export async function importAppleRemindersIntoInbox({
  addTask,
  listId,
  listTitle,
}: {
  addTask: AddInboxTask;
  listId: string;
  listTitle?: string;
}): Promise<AppleRemindersImportResult> {
  if (Platform.OS !== 'ios') {
    throw new Error('Apple Reminders import is only available on iOS.');
  }

  const permission = await getAppleRemindersPermissionStatus();
  if (permission !== 'granted') {
    throw new Error('Apple Reminders permission is required.');
  }

  const normalizedListId = normalizeString(listId);
  if (!normalizedListId) {
    throw new Error('Choose an Apple Reminders list first.');
  }

  const settings = await loadAppleRemindersImportSettings();
  const importedIds = new Set(settings.importedReminderIds);
  const reminders = await Calendar.getRemindersAsync([normalizedListId], null, null, null);
  const result: AppleRemindersImportResult = {
    importedCount: 0,
    skippedDuplicateCount: 0,
    skippedCompletedCount: 0,
    skippedEmptyTitleCount: 0,
    failedCount: 0,
  };

  for (const reminder of reminders) {
    if (reminder.completed === true) {
      result.skippedCompletedCount += 1;
      continue;
    }

    const title = normalizeString(reminder.title);
    if (!title) {
      result.skippedEmptyTitleCount += 1;
      continue;
    }

    const reminderKey = getReminderImportKey(reminder, normalizedListId, title);
    if (importedIds.has(reminderKey)) {
      result.skippedDuplicateCount += 1;
      continue;
    }

    const description = normalizeString(reminder.notes);
    const taskResult = await addTask(title, {
      status: 'inbox',
      ...(description ? { description } : {}),
    });

    if (taskResult.success === false) {
      result.failedCount += 1;
      continue;
    }

    result.importedCount += 1;
    importedIds.add(reminderKey);
  }

  await saveAppleRemindersImportSettings({
    selectedListId: normalizedListId,
    ...(normalizeString(listTitle) ? { selectedListTitle: normalizeString(listTitle) } : {}),
    importedReminderIds: Array.from(importedIds),
  });

  return result;
}
