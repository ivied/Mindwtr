import type { NotificationSettings } from '@mindwtr/core';

type MobileSettings = NotificationSettings;

export function areTaskRemindersEnabled(settings: MobileSettings): boolean {
  return settings.notificationsEnabled !== false;
}

export function areStartDateRemindersEnabled(settings: MobileSettings): boolean {
  return areTaskRemindersEnabled(settings) && settings.startDateNotificationsEnabled !== false;
}

export function areDueDateRemindersEnabled(settings: MobileSettings): boolean {
  return areTaskRemindersEnabled(settings) && settings.dueDateNotificationsEnabled !== false;
}

export function isWeeklyReviewReminderEnabled(settings: MobileSettings): boolean {
  return settings.weeklyReviewEnabled === true;
}

export function hasActiveMobileNotificationFeature(settings: MobileSettings): boolean {
  return areTaskRemindersEnabled(settings) || isWeeklyReviewReminderEnabled(settings);
}
