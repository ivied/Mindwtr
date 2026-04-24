import type { AppData } from '@mindwtr/core';

type MobileSettings = AppData['settings'];

export function areTaskRemindersEnabled(settings: MobileSettings): boolean {
  return settings.notificationsEnabled !== false;
}

export function isWeeklyReviewReminderEnabled(settings: MobileSettings): boolean {
  return settings.weeklyReviewEnabled === true;
}

export function hasActiveMobileNotificationFeature(settings: MobileSettings): boolean {
  return areTaskRemindersEnabled(settings) || isWeeklyReviewReminderEnabled(settings);
}
