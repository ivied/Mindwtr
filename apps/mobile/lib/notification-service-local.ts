import {
  getDueReminderRepeatTimes,
  getNextScheduledAt,
  getSystemDefaultLanguage,
  getTranslations,
  hasTimeComponent,
  loadStoredLanguage,
  parseTimeOfDay,
  safeParseDate,
  type Language,
  useTaskStore,
} from '@mindwtr/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { logInfo, logWarn } from './app-log';
import {
  areDueDateRemindersEnabled,
  areStartDateRemindersEnabled,
  areTaskRemindersEnabled,
  hasActiveMobileNotificationFeature,
  isWeeklyReviewReminderEnabled,
} from './mobile-notification-settings';
import { ensureReminderNotificationChannel } from '@/modules/notification-open-intents';
import { getDuplicateAlarmRetryFireAt } from './notification-service-local-utils';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  context?: string;
  kind?: string;
};

type NotificationOpenHandler = (payload: NotificationOpenPayload) => void;

type NotificationPermissionResult = {
  granted: boolean;
  canAskAgain: boolean;
};

type AlarmId = number;

type AlarmScheduleResult = {
  id?: number | string;
};

type AlarmNotificationsApi = {
  parseDate: (date: Date) => string;
  scheduleAlarm: (details: Record<string, unknown>) => Promise<AlarmScheduleResult>;
  sendNotification?: (details: Record<string, unknown>) => void;
  deleteAlarm: (id: AlarmId) => void;
  deleteRepeatingAlarm: (id: AlarmId) => void;
  removeFiredNotification: (id: AlarmId) => void;
  removeAllFiredNotifications: () => void;
  requestPermissions?: (permissions: { alert: boolean; badge: boolean; sound: boolean }) => Promise<unknown>;
};

type LocalAlarmMapEntry = {
  id: AlarmId;
  signature?: string;
};

type PomodoroAlarmEntry = {
  id: AlarmId;
  fireAtMs?: number;
};

type LocalAlarmMap = Record<string, LocalAlarmMapEntry>;

type LocalAlarmConfig = {
  title: string;
  message: string;
  fireAt: Date;
  repeatInterval?: 'daily' | 'weekly';
  hasSnoozeAction?: boolean;
  hasCompleteAction?: boolean;
  data?: Record<string, string>;
};

type NativeEmitterSubscription = {
  remove: () => void;
};

const LOCAL_ALARM_MAP_KEY = 'mindwtr:local:alarms:v1';
const LOCAL_POMODORO_ALARM_KEY = 'mindwtr:local:pomodoro-alarm:v1';
const LOCAL_NOTIFICATION_CHANNEL = 'mindwtr_reminders_v2';
const LOCAL_NOTIFICATION_CHANNEL_NAME = 'Mindwtr reminders';
const LOCAL_NOTIFICATION_COLOR = '#3b82f6';
const LOCAL_SMALL_ICON = 'ic_launcher';
const LOCAL_DIGEST_MORNING_KEY = 'digest:morning';
const LOCAL_DIGEST_EVENING_KEY = 'digest:evening';
const LOCAL_WEEKLY_REVIEW_KEY = 'digest:weekly-review';
const LOCAL_TASK_KEY_PREFIX = 'task:';
const LOCAL_PROJECT_KEY_PREFIX = 'project:';
const MAX_DUPLICATE_ALARM_RETRIES = 59;
const MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_IOS = 60;
const MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_ANDROID = 200;
const ALARM_SCHEDULE_BATCH_SIZE = 10;
const ONE_SHOT_TOP_UP_DELAY_MS = 5_000;
const MAX_SETTIMEOUT_DELAY_MS = 24 * 60 * 60 * 1000;
const NOTIFICATION_EVENT_RESCHEDULE_DEBOUNCE_MS = 250;
const TASK_REMINDER_SNOOZE_MINUTES = 10;

let started = false;
let alarmApi: AlarmNotificationsApi | null = null;
let notificationOpenHandler: NotificationOpenHandler | null = null;
let storeSubscription: (() => void) | null = null;
let openSubscription: NativeEmitterSubscription | null = null;
let dismissSubscription: NativeEmitterSubscription | null = null;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let oneShotTopUpTimer: ReturnType<typeof setTimeout> | null = null;
let notificationEventRescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let rescheduleQueue: Promise<void> = Promise.resolve();
let alarmMap = new Map<string, LocalAlarmMapEntry>();
let loadedAlarmMap = false;
let alarmMapLoadPromise: Promise<void> | null = null;
const configByKey = new Map<string, string>();

type AlarmScheduleRequest = {
  key: string;
  config: LocalAlarmConfig;
};

type OneShotReminderRequest = AlarmScheduleRequest & {
  fireAtMs: number;
};

const logNotificationError = (message: string, error?: unknown) => {
  const extra = error ? { error: error instanceof Error ? error.message : String(error) } : undefined;
  void logWarn(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

const logNotificationInfo = (message: string, extra?: Record<string, unknown>) => {
  void logInfo(`[Local Notifications] ${message}`, { scope: 'notifications', extra });
};

async function loadPomodoroAlarmEntry(): Promise<PomodoroAlarmEntry | null> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_POMODORO_ALARM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PomodoroAlarmEntry>;
    const id = Number(parsed?.id);
    if (!Number.isFinite(id)) return null;
    const fireAtMs = Number(parsed?.fireAtMs);
    return {
      id: Math.floor(id),
      ...(Number.isFinite(fireAtMs) ? { fireAtMs } : {}),
    };
  } catch (error) {
    logNotificationError('Failed to load pomodoro alarm', error);
    return null;
  }
}

async function savePomodoroAlarmEntry(entry: PomodoroAlarmEntry): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_POMODORO_ALARM_KEY, JSON.stringify(entry));
  } catch (error) {
    logNotificationError('Failed to persist pomodoro alarm', error);
  }
}

async function clearPomodoroAlarmEntry(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LOCAL_POMODORO_ALARM_KEY);
  } catch (error) {
    logNotificationError('Failed to clear pomodoro alarm', error);
  }
}

function getTaskKey(taskId: string): string {
  return `${LOCAL_TASK_KEY_PREFIX}${taskId}`;
}

function getTaskRepeatKey(taskId: string, index: number): string {
  return `${getTaskKey(taskId)}:r${index}`;
}

function getProjectKey(projectId: string): string {
  return `${LOCAL_PROJECT_KEY_PREFIX}${projectId}`;
}

function resetRuntimeState(): void {
  configByKey.clear();
  rescheduleQueue = Promise.resolve();
  notificationOpenHandler = null;
  alarmMapLoadPromise = null;
  clearOneShotTopUpTimer();
  clearNotificationEventRescheduleTimer();
}

function clearRescheduleTimer(): void {
  if (!rescheduleTimer) return;
  clearTimeout(rescheduleTimer);
  rescheduleTimer = null;
}

function clearOneShotTopUpTimer(): void {
  if (!oneShotTopUpTimer) return;
  clearTimeout(oneShotTopUpTimer);
  oneShotTopUpTimer = null;
}

function clearNotificationEventRescheduleTimer(): void {
  if (!notificationEventRescheduleTimer) return;
  clearTimeout(notificationEventRescheduleTimer);
  notificationEventRescheduleTimer = null;
}

function getMaxPendingOneShotReminderAlarms(): number {
  return Platform.OS === 'ios'
    ? MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_IOS
    : MAX_PENDING_ONE_SHOT_REMINDER_ALARMS_ANDROID;
}

async function getAndroidNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (Number(Platform.Version) < 33) {
    return { granted: true, canAskAgain: true };
  }

  try {
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return { granted, canAskAgain: !granted };
  } catch (error) {
    logNotificationError('Failed to read Android notification permission', error);
    return { granted: false, canAskAgain: false };
  }
}

async function ensureLocalReminderNotificationChannel(): Promise<void> {
  try {
    await ensureReminderNotificationChannel(LOCAL_NOTIFICATION_CHANNEL, LOCAL_NOTIFICATION_CHANNEL_NAME);
    logNotificationInfo('Android reminder notification channel ensured', {
      channel: LOCAL_NOTIFICATION_CHANNEL,
    });
  } catch (error) {
    logNotificationError('Failed to ensure local notification channel', error);
  }
}

async function loadAlarmApi(): Promise<AlarmNotificationsApi | null> {
  if (alarmApi) return alarmApi;
  try {
    const mod = await import('react-native-alarm-notification');
    const api = mod?.default as AlarmNotificationsApi | undefined;
    if (!api || typeof api.scheduleAlarm !== 'function') {
      logNotificationError('react-native-alarm-notification API unavailable');
      return null;
    }
    alarmApi = api;
    return api;
  } catch (error) {
    logNotificationError('Failed to load react-native-alarm-notification', error);
    return null;
  }
}

async function clearScheduledAlarms(api: AlarmNotificationsApi | null): Promise<void> {
  await loadAlarmMapIfNeeded();
  await cancelLocalPomodoroCompletionNotification(api, { removeFired: true });
  const scheduledAlarmCount = alarmMap.size;

  if (api) {
    for (const entry of alarmMap.values()) {
      try {
        api.deleteAlarm(entry.id);
        api.deleteRepeatingAlarm(entry.id);
        api.removeFiredNotification(entry.id);
      } catch (error) {
        logNotificationError('Failed to cancel local alarm', error);
      }
    }

    try {
      api.removeAllFiredNotifications();
    } catch {
      // no-op
    }
  }

  alarmMap.clear();
  await saveAlarmMap();
  loadedAlarmMap = false;
  logNotificationInfo('Scheduled alarms cleared', { scheduledAlarmCount });
}

function serializeAlarmMap(map: Map<string, LocalAlarmMapEntry>): LocalAlarmMap {
  const result: LocalAlarmMap = {};
  for (const [key, value] of map.entries()) {
    result[key] = value;
  }
  return result;
}

async function loadAlarmMapIfNeeded(): Promise<void> {
  if (loadedAlarmMap) return;
  if (alarmMapLoadPromise) {
    await alarmMapLoadPromise;
    return;
  }
  alarmMapLoadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(LOCAL_ALARM_MAP_KEY);
      if (!raw) {
        alarmMap = new Map<string, LocalAlarmMapEntry>();
        loadedAlarmMap = true;
        return;
      }
      const parsed = JSON.parse(raw) as LocalAlarmMap;
      const nextMap = new Map<string, LocalAlarmMapEntry>();
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const id = Number((value as LocalAlarmMapEntry).id);
        if (!Number.isFinite(id)) continue;
        const signature = typeof (value as LocalAlarmMapEntry).signature === 'string'
          ? (value as LocalAlarmMapEntry).signature
          : undefined;
        nextMap.set(key, { id: Math.floor(id), signature });
        if (signature) {
          configByKey.set(key, signature);
        }
      }
      alarmMap = nextMap;
      loadedAlarmMap = true;
    } catch (error) {
      alarmMap = new Map<string, LocalAlarmMapEntry>();
      loadedAlarmMap = false;
      logNotificationError('Failed to load alarm map', error);
    }
  })().finally(() => {
    alarmMapLoadPromise = null;
  });
  await alarmMapLoadPromise;
}

async function saveAlarmMap(): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_ALARM_MAP_KEY, JSON.stringify(serializeAlarmMap(alarmMap)));
  } catch (error) {
    logNotificationError('Failed to persist alarm map', error);
  }
}

function toAlarmFireDate(api: AlarmNotificationsApi, date: Date): string {
  const next = new Date(date);
  next.setMilliseconds(0);
  return api.parseDate(next);
}

function isDuplicateAlarmError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('duplicate alarm set at date');
}

function nextDailyTime(hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function nextWeeklyTime(dayOfWeekSundayFirst: number, hour: number, minute: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  const current = next.getDay(); // 0 = Sunday
  let delta = dayOfWeekSundayFirst - current;
  if (delta < 0) {
    delta += 7;
  }
  if (delta === 0 && next.getTime() <= now.getTime()) {
    delta = 7;
  }

  next.setDate(next.getDate() + delta);
  return next;
}

function parseEventPayload(value: unknown): Record<string, string> | null {
  const raw = typeof value === 'string' ? value : null;
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === 'data') {
        const nested = parseEventPayload(item);
        if (nested) {
          for (const [nestedKey, nestedValue] of Object.entries(nested)) {
            result[nestedKey] ??= nestedValue;
          }
        }
      } else if (typeof item === 'string') {
        result[key] = item;
      } else if (item !== undefined && item !== null) {
        result[key] = String(item);
      }
    }
    return result;
  } catch {
    return null;
  }
}

function isSameScheduleTime(left: Date | null, right: Date | null): boolean {
  return Boolean(left && right && left.getTime() === right.getTime());
}

function attachNativeEventListeners(): void {
  const nativeModule = (NativeModules as Record<string, unknown>).RNAlarmNotification;
  if (!nativeModule) return;

  const emitter = new NativeEventEmitter(nativeModule as any);

  openSubscription?.remove();
  openSubscription = emitter.addListener('OnNotificationOpened', (payload: unknown) => {
    const data = parseEventPayload(payload);
    if (!data) return;
    if (alarmApi && (data.taskId || data.projectId)) {
      enqueueNotificationEventReschedule(alarmApi);
    }
    if (!notificationOpenHandler) return;
    try {
      notificationOpenHandler({
        notificationId: data.alarmKey || data.id,
        actionIdentifier: data.actionIdentifier || 'open',
        taskId: data.taskId,
        projectId: data.projectId,
        context: data.context,
        kind: data.kind,
      });
    } catch (error) {
      logNotificationError('Failed to handle notification open event', error);
    }
  });

  dismissSubscription?.remove();
  dismissSubscription = emitter.addListener('OnNotificationDismissed', (payload: unknown) => {
    const data = parseEventPayload(payload);
    if (alarmApi && data && (data.taskId || data.projectId)) {
      enqueueNotificationEventReschedule(alarmApi);
    }
  });
}

function buildAlarmConfigSignature(config: LocalAlarmConfig): string {
  const repeatSchedule = (() => {
    if (!config.repeatInterval) return config.fireAt.toISOString();
    const hours = String(config.fireAt.getHours()).padStart(2, '0');
    const minutes = String(config.fireAt.getMinutes()).padStart(2, '0');
    if (config.repeatInterval === 'weekly') {
      return `${config.repeatInterval}:${config.fireAt.getDay()}:${hours}:${minutes}`;
    }
    return `${config.repeatInterval}:${hours}:${minutes}`;
  })();
  return JSON.stringify({
    title: config.title,
    message: config.message,
    fireAt: repeatSchedule,
    repeatInterval: config.repeatInterval ?? 'once',
    hasSnoozeAction: config.hasSnoozeAction === true,
    ...(config.hasCompleteAction === true ? { hasCompleteAction: true } : {}),
    data: config.data ?? {},
  });
}

function normalizeNotificationMessage(title: string, message?: string): string {
  const trimmedMessage = String(message || '').trim();
  if (trimmedMessage) return trimmedMessage;

  return String(title || '').trim();
}

async function cancelAlarmByKey(api: AlarmNotificationsApi, key: string): Promise<boolean> {
  const entry = alarmMap.get(key);
  if (!entry) return false;
  try {
    api.deleteAlarm(entry.id);
  } catch (error) {
    logNotificationError(`Failed to delete alarm (${key})`, error);
  }
  try {
    api.deleteRepeatingAlarm(entry.id);
  } catch {
    // Safe to ignore when alarm is one-shot.
  }
  try {
    api.removeFiredNotification(entry.id);
  } catch {
    // Safe to ignore if notification has not fired.
  }
  alarmMap.delete(key);
  configByKey.delete(key);
  logNotificationInfo('Alarm canceled', { alarmKey: key, alarmId: entry.id });
  return true;
}

async function scheduleAlarmForKey(api: AlarmNotificationsApi, key: string, config: LocalAlarmConfig): Promise<void> {
  const signature = buildAlarmConfigSignature(config);
  const existingAlarm = alarmMap.get(key);
  const existingSignature = configByKey.get(key) ?? existingAlarm?.signature;
  if (existingAlarm && existingSignature === signature) {
    configByKey.set(key, signature);
    return;
  }

  await cancelAlarmByKey(api, key);

  const baseFireAt = new Date(config.fireAt);
  baseFireAt.setMilliseconds(0);

  const detailsBase: Record<string, unknown> = {
    title: config.title,
    message: normalizeNotificationMessage(config.title, config.message),
    channel: LOCAL_NOTIFICATION_CHANNEL,
    auto_cancel: true,
    small_icon: LOCAL_SMALL_ICON,
    color: LOCAL_NOTIFICATION_COLOR,
    has_button: config.hasSnoozeAction === true || config.hasCompleteAction === true,
    has_complete_action: config.hasCompleteAction === true,
    loop_sound: false,
    play_sound: true,
    schedule_type: config.repeatInterval ? 'repeat' : 'once',
    repeat_interval: config.repeatInterval ?? 'hourly',
    interval_value: 1,
    use_big_text: true,
    vibrate: false,
    data: {
      ...(config.data ?? {}),
      alarmKey: key,
      ...(config.hasCompleteAction === true ? { notificationActionComplete: 'true' } : {}),
    },
    ...(config.hasSnoozeAction === true ? { snooze_interval: TASK_REMINDER_SNOOZE_MINUTES } : {}),
  };

  let scheduledId: number | null = null;
  let lastError: unknown = null;

  for (let retry = 0; retry <= MAX_DUPLICATE_ALARM_RETRIES; retry += 1) {
    // The Android alarm library treats same-minute alarms as duplicates.
    const fireAt = getDuplicateAlarmRetryFireAt(baseFireAt, retry);
    try {
      const result = await api.scheduleAlarm({
        ...detailsBase,
        fire_date: toAlarmFireDate(api, fireAt),
      });
      const id = Number(result?.id);
      if (!Number.isFinite(id)) {
        logNotificationError(`Scheduled alarm returned invalid id for ${key}`);
        return;
      }
      scheduledId = Math.floor(id);
      logNotificationInfo('Alarm scheduled', {
        alarmKey: key,
        alarmId: scheduledId,
        fireAt: fireAt.toISOString(),
        retryCount: retry,
        scheduleType: config.repeatInterval ? 'repeat' : 'once',
      });
      break;
    } catch (error) {
      lastError = error;
      if (isDuplicateAlarmError(error) && retry < MAX_DUPLICATE_ALARM_RETRIES) {
        continue;
      }
      logNotificationError(`Failed to schedule alarm (${key})`, error);
      throw error;
    }
  }

  if (scheduledId === null) {
    logNotificationError(`Failed to schedule alarm for ${key} after duplicate retries`, lastError);
    return;
  }

  alarmMap.set(key, { id: scheduledId, signature });
  configByKey.set(key, signature);
}

async function scheduleAlarmRequests(api: AlarmNotificationsApi, requests: AlarmScheduleRequest[]): Promise<void> {
  for (let index = 0; index < requests.length; index += ALARM_SCHEDULE_BATCH_SIZE) {
    const batch = requests.slice(index, index + ALARM_SCHEDULE_BATCH_SIZE);
    await Promise.all(batch.map((request) => scheduleAlarmForKey(api, request.key, request.config)));
  }
}

async function cancelInactiveKeys(api: AlarmNotificationsApi, activeKeys: Set<string>): Promise<void> {
  for (const key of Array.from(alarmMap.keys())) {
    if (activeKeys.has(key)) continue;
    await cancelAlarmByKey(api, key);
  }
}

function scheduleOneShotTopUp(api: AlarmNotificationsApi, reminders: OneShotReminderRequest[], nowMs: number): void {
  clearOneShotTopUpTimer();
  if (reminders.length === 0) return;

  const nextFireAtMs = reminders[0]?.fireAtMs;
  if (!Number.isFinite(nextFireAtMs)) return;

  const rawDelayMs = Math.max(ONE_SHOT_TOP_UP_DELAY_MS, nextFireAtMs - nowMs + ONE_SHOT_TOP_UP_DELAY_MS);
  const delayMs = Math.min(MAX_SETTIMEOUT_DELAY_MS, rawDelayMs);
  oneShotTopUpTimer = setTimeout(() => {
    oneShotTopUpTimer = null;
    enqueueReschedule(api);
  }, delayMs);
}

async function runRescheduleCycle(api: AlarmNotificationsApi): Promise<void> {
  await loadAlarmMapIfNeeded();

  const { settings, tasks, projects } = useTaskStore.getState();
  const activeKeys = new Set<string>();
  const taskRemindersEnabled = areTaskRemindersEnabled(settings);
  const includeStartTime = areStartDateRemindersEnabled(settings);
  const includeDueDate = areDueDateRemindersEnabled(settings);
  const weeklyReviewEnabled = isWeeklyReviewReminderEnabled(settings);
  const activeFeature = hasActiveMobileNotificationFeature(settings);

  logNotificationInfo('Reschedule cycle started', {
    taskCount: tasks.length,
    projectCount: projects.length,
    existingAlarmCount: alarmMap.size,
    activeFeature,
    taskRemindersEnabled,
    includeStartTime,
    includeDueDate,
    includeReviewAt: taskRemindersEnabled && settings.reviewAtNotificationsEnabled !== false,
    weeklyReviewEnabled,
  });

  if (!activeFeature) {
    clearOneShotTopUpTimer();
    for (const key of Array.from(alarmMap.keys())) {
      await cancelAlarmByKey(api, key);
    }
    await saveAlarmMap();
    logNotificationInfo('Reschedule cycle complete', {
      activeFeature,
      scheduledAlarmCount: alarmMap.size,
      oneShotReminderCount: 0,
      scheduledOneShotReminderCount: 0,
    });
    return;
  }

  const language: Language = await loadStoredLanguage(AsyncStorage, getSystemDefaultLanguage()).catch(() => getSystemDefaultLanguage());
  const tr = await getTranslations(language);

  if (taskRemindersEnabled && settings.dailyDigestMorningEnabled === true) {
    const { hour, minute } = parseTimeOfDay(settings.dailyDigestMorningTime, { hour: 9, minute: 0 });
    const key = LOCAL_DIGEST_MORNING_KEY;
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: tr['digest.morningTitle'],
      message: tr['digest.morningBody'],
      fireAt: nextDailyTime(hour, minute),
      repeatInterval: 'daily',
      data: { kind: 'daily-digest' },
    });
  }

  if (taskRemindersEnabled && settings.dailyDigestEveningEnabled === true) {
    const { hour, minute } = parseTimeOfDay(settings.dailyDigestEveningTime, { hour: 20, minute: 0 });
    const key = LOCAL_DIGEST_EVENING_KEY;
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: tr['digest.eveningTitle'],
      message: tr['digest.eveningBody'],
      fireAt: nextDailyTime(hour, minute),
      repeatInterval: 'daily',
      data: { kind: 'daily-digest' },
    });
  }

  if (weeklyReviewEnabled) {
    const { hour, minute } = parseTimeOfDay(settings.weeklyReviewTime, { hour: 18, minute: 0 });
    const day = Number.isFinite(settings.weeklyReviewDay)
      ? Math.max(0, Math.min(6, Math.floor(settings.weeklyReviewDay as number)))
      : 0;
    const key = LOCAL_WEEKLY_REVIEW_KEY;
    activeKeys.add(key);
    await scheduleAlarmForKey(api, key, {
      title: tr['digest.weeklyReviewTitle'],
      message: tr['digest.weeklyReviewBody'],
      fireAt: nextWeeklyTime(day, hour, minute),
      repeatInterval: 'weekly',
      data: { kind: 'weekly-review' },
    });
  }

  const now = new Date();
  const nowMs = now.getTime();
  const includeReviewAt = taskRemindersEnabled && settings.reviewAtNotificationsEnabled !== false;
  const oneShotReminders: OneShotReminderRequest[] = [];
  let dateOnlyDueDateCount = 0;
  let futureDueDateReminderCount = 0;
  let pastDueDateReminderCount = 0;
  let dateOnlyStartTimeCount = 0;
  let futureStartTimeReminderCount = 0;
  let pastStartTimeReminderCount = 0;
  let futureTaskReviewReminderCount = 0;
  let pastTaskReviewReminderCount = 0;
  let suppressedTaskReminderCount = 0;
  let taskReminderCount = 0;
  let taskReviewReminderCount = 0;
  let projectReviewReminderCount = 0;

  if (taskRemindersEnabled) {
    for (const task of tasks) {
      const suppressTaskReminders = task.suppressMindwtrReminders === true;
      const hasSuppressedTaskReminder = (includeDueDate && hasTimeComponent(task.dueDate))
        || (includeStartTime && hasTimeComponent(task.startTime));
      if (suppressTaskReminders && hasSuppressedTaskReminder) {
        suppressedTaskReminderCount += 1;
      }
      if (!suppressTaskReminders && includeDueDate && task.dueDate) {
        if (hasTimeComponent(task.dueDate)) {
          const dueAt = safeParseDate(task.dueDate);
          const dueAtMs = dueAt?.getTime() ?? NaN;
          if (Number.isFinite(dueAtMs) && dueAtMs > nowMs) {
            futureDueDateReminderCount += 1;
          } else if (Number.isFinite(dueAtMs)) {
            pastDueDateReminderCount += 1;
          }
        } else {
          dateOnlyDueDateCount += 1;
        }
      }
      if (!suppressTaskReminders && includeStartTime && task.startTime) {
        if (hasTimeComponent(task.startTime)) {
          const startAt = safeParseDate(task.startTime);
          const startAtMs = startAt?.getTime() ?? NaN;
          if (Number.isFinite(startAtMs) && startAtMs > nowMs) {
            futureStartTimeReminderCount += 1;
          } else if (Number.isFinite(startAtMs)) {
            pastStartTimeReminderCount += 1;
          }
        } else {
          dateOnlyStartTimeCount += 1;
        }
      }
      if (includeReviewAt && task.reviewAt && hasTimeComponent(task.reviewAt)) {
        const reviewAt = safeParseDate(task.reviewAt);
        const reviewAtMs = reviewAt?.getTime() ?? NaN;
        if (Number.isFinite(reviewAtMs) && reviewAtMs > nowMs) {
          futureTaskReviewReminderCount += 1;
        } else if (Number.isFinite(reviewAtMs)) {
          pastTaskReviewReminderCount += 1;
        }
      }

      // Bounded due-time repeat occurrences (after the due moment). Scheduled independently of the
      // base reminder below: a task whose due time already passed has no future `next`, but its
      // remaining repeat occurrences must still fire. Past occurrences are reaped via activeKeys.
      const repeatTimes = getDueReminderRepeatTimes(task, { includeStartTime, includeDueDate, includeReviewAt });
      for (let repeatIndex = 0; repeatIndex < repeatTimes.length; repeatIndex += 1) {
        const repeatFireAt = repeatTimes[repeatIndex];
        const repeatFireAtMs = repeatFireAt.getTime();
        if (repeatFireAtMs <= nowMs) continue;
        oneShotReminders.push({
          key: getTaskRepeatKey(task.id, repeatIndex + 1), // 1-based: repeatTimes[0] = due + N => :r1
          fireAtMs: repeatFireAtMs,
          config: {
            title: task.title,
            message: task.description || '',
            fireAt: repeatFireAt,
            hasSnoozeAction: true,
            hasCompleteAction: true,
            data: {
              kind: 'task-reminder',
              taskId: task.id,
            },
          },
        });
      }

      const next = getNextScheduledAt(task, now, { includeStartTime, includeDueDate, includeReviewAt });
      const fireAtMs = next?.getTime() ?? NaN;
      if (!next || fireAtMs <= nowMs) continue;
      const reviewAt = includeReviewAt && hasTimeComponent(task.reviewAt)
        ? safeParseDate(task.reviewAt)
        : null;
      const kind = isSameScheduleTime(next, reviewAt) ? 'task-review' : 'task-reminder';
      if (kind === 'task-review') {
        taskReviewReminderCount += 1;
      } else {
        taskReminderCount += 1;
      }
      const key = getTaskKey(task.id);
      oneShotReminders.push({
        key,
        fireAtMs,
        config: {
          title: task.title,
          message: task.description || '',
          fireAt: next,
          hasSnoozeAction: true,
          hasCompleteAction: kind === 'task-reminder',
          data: {
            kind,
            taskId: task.id,
          },
        },
      });
    }
  }

  if (includeReviewAt) {
    const reviewLabel = tr['review.projectsStep'] ?? 'Review project';
    for (const project of projects) {
      if (project.deletedAt) continue;
      if (project.status === 'archived') continue;
      const reviewAt = safeParseDate(project.reviewAt);
      if (!reviewAt) continue;
      if (!hasTimeComponent(project.reviewAt)) {
        reviewAt.setHours(9, 0, 0, 0);
      }
      const fireAtMs = reviewAt.getTime();
      if (fireAtMs <= nowMs) continue;
      projectReviewReminderCount += 1;
      const key = getProjectKey(project.id);
      oneShotReminders.push({
        key,
        fireAtMs,
        config: {
          title: project.title,
          message: reviewLabel,
          fireAt: reviewAt,
          data: {
            kind: 'project-review',
            projectId: project.id,
          },
        },
      });
    }
  }

  oneShotReminders.sort((left, right) => left.fireAtMs - right.fireAtMs);
  const cappedOneShotReminders = oneShotReminders.slice(0, getMaxPendingOneShotReminderAlarms());
  for (const reminder of cappedOneShotReminders) {
    activeKeys.add(reminder.key);
  }
  await scheduleAlarmRequests(api, cappedOneShotReminders);
  scheduleOneShotTopUp(api, cappedOneShotReminders, nowMs);

  await cancelInactiveKeys(api, activeKeys);
  await saveAlarmMap();
  logNotificationInfo('Reschedule cycle complete', {
    activeFeature,
    scheduledAlarmCount: alarmMap.size,
    oneShotReminderCount: oneShotReminders.length,
    scheduledOneShotReminderCount: cappedOneShotReminders.length,
    maxPendingOneShotReminderAlarms: getMaxPendingOneShotReminderAlarms(),
    nextOneShotFireAt: cappedOneShotReminders[0]?.config.fireAt.toISOString() ?? '',
    taskReminderCount,
    taskReviewReminderCount,
    projectReviewReminderCount,
    dateOnlyDueDateCount,
    futureDueDateReminderCount,
    pastDueDateReminderCount,
    dateOnlyStartTimeCount,
    futureStartTimeReminderCount,
    pastStartTimeReminderCount,
    futureTaskReviewReminderCount,
    pastTaskReviewReminderCount,
    suppressedTaskReminderCount,
  });
}

function enqueueReschedule(api: AlarmNotificationsApi): void {
  rescheduleQueue = rescheduleQueue
    .catch(() => undefined)
    .then(async () => {
      await runRescheduleCycle(api);
    })
    .catch((error) => logNotificationError('Failed to reschedule local notifications', error));
}

function enqueueNotificationEventReschedule(api: AlarmNotificationsApi): void {
  clearNotificationEventRescheduleTimer();
  notificationEventRescheduleTimer = setTimeout(() => {
    notificationEventRescheduleTimer = null;
    enqueueReschedule(api);
  }, NOTIFICATION_EVENT_RESCHEDULE_DEBOUNCE_MS);
}

export function setLocalNotificationOpenHandler(handler: NotificationOpenHandler | null): void {
  notificationOpenHandler = handler;
  if (handler) {
    attachNativeEventListeners();
  }
}

export async function requestLocalNotificationPermission(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    const currentStatus = await getAndroidNotificationPermissionStatus();
    logNotificationInfo('Android notification permission checked', currentStatus);
    if (currentStatus.granted) {
      await ensureLocalReminderNotificationChannel();
      return currentStatus;
    }

    try {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      logNotificationInfo('Android notification permission requested', { result });
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        await ensureLocalReminderNotificationChannel();
        return { granted: true, canAskAgain: true };
      }
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        return { granted: false, canAskAgain: false };
      }
      return { granted: false, canAskAgain: true };
    } catch (error) {
      logNotificationError('Failed to request Android notification permission', error);
      return { granted: false, canAskAgain: false };
    }
  }

  const api = await loadAlarmApi();
  if (!api || typeof api.requestPermissions !== 'function') {
    return { granted: false, canAskAgain: false };
  }

  try {
    const result = await api.requestPermissions({ alert: true, badge: true, sound: true });
    const granted = Boolean((result as { alert?: boolean } | undefined)?.alert);
    return { granted, canAskAgain: !granted };
  } catch (error) {
    logNotificationError('Failed to request iOS notification permission', error);
    return { granted: false, canAskAgain: false };
  }
}

export async function sendLocalMobileNotification(
  title: string,
  message?: string,
  data?: Record<string, string>
): Promise<void> {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return;

  const api = await loadAlarmApi();
  if (!api) return;

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) return;

  try {
    const details = {
      title: trimmedTitle,
      message: normalizeNotificationMessage(trimmedTitle, message),
      channel: LOCAL_NOTIFICATION_CHANNEL,
      auto_cancel: true,
      small_icon: LOCAL_SMALL_ICON,
      color: LOCAL_NOTIFICATION_COLOR,
      has_button: false,
      loop_sound: false,
      play_sound: true,
      use_big_text: true,
      vibrate: false,
      data: {
        kind: 'pomodoro',
        ...(data ?? {}),
      },
    };

    if (typeof api.sendNotification === 'function') {
      api.sendNotification(details);
      return;
    }

    await api.scheduleAlarm({
      ...details,
      fire_date: api.parseDate(new Date(Date.now() + 2000)),
      schedule_type: 'once',
    });
  } catch (error) {
    logNotificationError('Failed to send local mobile notification', error);
  }
}

export async function cancelLocalPomodoroCompletionNotification(
  loadedApi?: AlarmNotificationsApi | null,
  options: { removeFired?: boolean } = {},
): Promise<void> {
  const api = loadedApi ?? await loadAlarmApi();
  const entry = await loadPomodoroAlarmEntry();
  if (api && entry) {
    try {
      api.deleteAlarm(entry.id);
      api.deleteRepeatingAlarm(entry.id);
      const shouldRemoveFired = options.removeFired ?? (!entry.fireAtMs || entry.fireAtMs > Date.now());
      if (shouldRemoveFired) {
        api.removeFiredNotification(entry.id);
      }
    } catch (error) {
      logNotificationError('Failed to cancel pomodoro alarm', error);
    }
  }
  await clearPomodoroAlarmEntry();
}

export async function scheduleLocalPomodoroCompletionNotification(
  title: string,
  message: string,
  fireAt: Date,
  data?: Record<string, string>,
): Promise<void> {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return;

  const fireAtMs = fireAt.getTime();
  if (!Number.isFinite(fireAtMs)) return;

  const api = await loadAlarmApi();
  if (!api) return;

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) return;

  await cancelLocalPomodoroCompletionNotification(api);

  if (fireAtMs <= Date.now() + 1000) {
    await sendLocalMobileNotification(trimmedTitle, message, data);
    return;
  }

  try {
    const result = await api.scheduleAlarm({
      title: trimmedTitle,
      message: normalizeNotificationMessage(trimmedTitle, message),
      channel: LOCAL_NOTIFICATION_CHANNEL,
      auto_cancel: true,
      small_icon: LOCAL_SMALL_ICON,
      color: LOCAL_NOTIFICATION_COLOR,
      has_button: false,
      loop_sound: false,
      play_sound: true,
      schedule_type: 'once',
      use_big_text: true,
      vibrate: false,
      fire_date: toAlarmFireDate(api, fireAt),
      data: {
        kind: 'pomodoro',
        ...(data ?? {}),
      },
    });
    const id = Number(result?.id);
    if (!Number.isFinite(id)) {
      logNotificationError('Pomodoro alarm returned invalid id');
      return;
    }
    await savePomodoroAlarmEntry({ id: Math.floor(id), fireAtMs });
  } catch (error) {
    logNotificationError('Failed to schedule pomodoro alarm', error);
  }
}

export async function startLocalMobileNotifications(): Promise<void> {
  if (started) {
    logNotificationInfo('Start requested while service is already running; rescheduling current reminders');
    const api = await loadAlarmApi();
    if (api) {
      await runRescheduleCycle(api);
    }
    return;
  }
  started = true;
  logNotificationInfo('Start requested', {
    platform: Platform.OS,
    platformVersion: String(Platform.Version),
  });

  const api = await loadAlarmApi();
  if (!api) {
    logNotificationInfo('Start aborted; alarm API unavailable');
    started = false;
    return;
  }

  const permission = await requestLocalNotificationPermission();
  if (!permission.granted) {
    logNotificationInfo('Start aborted; notification permission not granted', permission);
    await clearScheduledAlarms(api);
    started = false;
    return;
  }

  attachNativeEventListeners();
  await runRescheduleCycle(api);
  logNotificationInfo('Service started');

  storeSubscription?.();
  storeSubscription = useTaskStore.subscribe(() => {
    clearRescheduleTimer();
    rescheduleTimer = setTimeout(() => {
      rescheduleTimer = null;
      enqueueReschedule(api);
    }, 500);
  });
}

export async function stopLocalMobileNotifications(): Promise<void> {
  logNotificationInfo('Stop requested');
  clearRescheduleTimer();
  clearNotificationEventRescheduleTimer();

  storeSubscription?.();
  storeSubscription = null;

  openSubscription?.remove();
  openSubscription = null;

  dismissSubscription?.remove();
  dismissSubscription = null;
  notificationOpenHandler = null;

  const api = await loadAlarmApi();
  await clearScheduledAlarms(api);
  resetRuntimeState();
  started = false;
  logNotificationInfo('Service stopped');
}

export async function getLocalNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (Platform.OS === 'android') {
    return getAndroidNotificationPermissionStatus();
  }
  return requestLocalNotificationPermission();
}

export const __localNotificationTestUtils = {
  loadAlarmMapIfNeeded,
  getAlarmMapSnapshot: () => new Map(alarmMap),
  getNotificationOpenHandler: () => notificationOpenHandler,
  isAlarmMapLoaded: () => loadedAlarmMap,
  resetForTests: () => {
    clearRescheduleTimer();
    storeSubscription?.();
    storeSubscription = null;
    openSubscription?.remove();
    openSubscription = null;
    dismissSubscription?.remove();
    dismissSubscription = null;
    started = false;
    alarmApi = null;
    alarmMap = new Map<string, LocalAlarmMapEntry>();
    loadedAlarmMap = false;
    resetRuntimeState();
  },
};
