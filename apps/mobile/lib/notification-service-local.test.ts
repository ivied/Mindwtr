import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAsyncStorageGetItem,
  mockAsyncStorageRemoveItem,
  mockAsyncStorageSetItem,
  mockStoreSubscribe,
  mockStoreState,
  mockAlarmDeleteAlarm,
  mockAlarmDeleteRepeatingAlarm,
  mockAlarmRemoveAllFiredNotifications,
  mockAlarmRemoveFiredNotification,
  mockAlarmRequestPermissions,
  mockAlarmSendNotification,
  mockAlarmScheduleAlarm,
  mockEnsureReminderNotificationChannel,
  mockGetNextScheduledAt,
  mockGetDueReminderRepeatTimes,
  mockHasTimeComponent,
  mockLogInfo,
  mockPlatform,
  mockPermissionsAndroidCheck,
  mockPermissionsAndroidRequest,
} = vi.hoisted(() => ({
  mockAsyncStorageGetItem: vi.fn(),
  mockAsyncStorageRemoveItem: vi.fn(),
  mockAsyncStorageSetItem: vi.fn(),
  mockStoreSubscribe: vi.fn(() => () => undefined),
  mockStoreState: {
    settings: {} as Record<string, unknown>,
    tasks: [] as Array<{
      id: string;
      title: string;
      description?: string;
      dueDate?: string;
      reviewAt?: string;
      startTime?: string;
    }>,
    projects: [] as Array<Record<string, unknown>>,
  },
  mockAlarmDeleteAlarm: vi.fn(),
  mockAlarmDeleteRepeatingAlarm: vi.fn(),
  mockAlarmRemoveAllFiredNotifications: vi.fn(),
  mockAlarmRemoveFiredNotification: vi.fn(),
  mockAlarmRequestPermissions: vi.fn(async () => ({ alert: true })),
  mockAlarmSendNotification: vi.fn(),
  mockAlarmScheduleAlarm: vi.fn(async () => ({ id: 99 })),
  mockEnsureReminderNotificationChannel: vi.fn(async () => undefined),
  mockGetNextScheduledAt: vi.fn<(...args: unknown[]) => Date | null>(() => null),
  mockGetDueReminderRepeatTimes: vi.fn<(...args: unknown[]) => Date[]>(() => []),
  mockHasTimeComponent: vi.fn(() => false),
  mockLogInfo: vi.fn(async () => undefined),
  mockPlatform: {
    OS: 'android',
    Version: 34,
  },
  mockPermissionsAndroidCheck: vi.fn(async () => true),
  mockPermissionsAndroidRequest: vi.fn(async () => 'granted'),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mockAsyncStorageGetItem,
    removeItem: mockAsyncStorageRemoveItem,
    setItem: mockAsyncStorageSetItem,
  },
}));

vi.mock('react-native', () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  NativeModules: {},
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: mockPermissionsAndroidCheck,
    request: mockPermissionsAndroidRequest,
  },
  Platform: mockPlatform,
}));

vi.mock('react-native-alarm-notification', () => ({
  default: {
    parseDate: (date: Date) => date.toISOString(),
    scheduleAlarm: mockAlarmScheduleAlarm,
    sendNotification: mockAlarmSendNotification,
    deleteAlarm: mockAlarmDeleteAlarm,
    deleteRepeatingAlarm: mockAlarmDeleteRepeatingAlarm,
    removeFiredNotification: mockAlarmRemoveFiredNotification,
    removeAllFiredNotifications: mockAlarmRemoveAllFiredNotifications,
    requestPermissions: mockAlarmRequestPermissions,
  },
}));

vi.mock('@mindwtr/core', () => ({
  getNextScheduledAt: mockGetNextScheduledAt,
  getDueReminderRepeatTimes: mockGetDueReminderRepeatTimes,
  getSystemDefaultLanguage: vi.fn(() => 'en'),
  getTranslations: vi.fn(async () => ({
    'digest.morningTitle': 'Morning',
    'digest.morningBody': 'Morning body',
    'digest.eveningTitle': 'Evening',
    'digest.eveningBody': 'Evening body',
    'digest.weeklyReviewTitle': 'Weekly review',
    'digest.weeklyReviewBody': 'Weekly review body',
    'review.projectsStep': 'Review project',
  })),
  hasTimeComponent: mockHasTimeComponent,
  loadStoredLanguage: vi.fn(async () => 'en'),
  parseTimeOfDay: vi.fn((value: string | undefined, fallback: { hour: number; minute: number }) => {
    if (!value) return fallback;
    const [hour, minute] = value.split(':').map((part) => Number(part));
    return {
      hour: Number.isFinite(hour) ? hour : fallback.hour,
      minute: Number.isFinite(minute) ? minute : fallback.minute,
    };
  }),
  safeParseDate: vi.fn((value?: string) => (value ? new Date(value) : null)),
  useTaskStore: {
    getState: () => mockStoreState,
    subscribe: mockStoreSubscribe,
  },
}));

vi.mock('./app-log', () => ({
  logInfo: mockLogInfo,
  logWarn: vi.fn(async () => undefined),
}));

vi.mock('@/modules/notification-open-intents', () => ({
  ensureReminderNotificationChannel: mockEnsureReminderNotificationChannel,
}));

import {
  __localNotificationTestUtils,
  cancelLocalPomodoroCompletionNotification,
  scheduleLocalPomodoroCompletionNotification,
  sendLocalMobileNotification,
  setLocalNotificationOpenHandler,
  startLocalMobileNotifications,
  stopLocalMobileNotifications,
} from './notification-service-local';

describe('notification-service-local', () => {
  beforeEach(() => {
    mockAsyncStorageGetItem.mockReset();
    mockAsyncStorageRemoveItem.mockReset();
    mockAsyncStorageSetItem.mockReset();
    mockStoreSubscribe.mockClear();
    mockStoreState.settings = {};
    mockStoreState.tasks = [];
    mockStoreState.projects = [];
    mockAlarmDeleteAlarm.mockReset();
    mockAlarmDeleteRepeatingAlarm.mockReset();
    mockAlarmRemoveAllFiredNotifications.mockReset();
    mockAlarmRemoveFiredNotification.mockReset();
    mockAlarmRequestPermissions.mockReset();
    mockAlarmRequestPermissions.mockResolvedValue({ alert: true });
    mockAlarmSendNotification.mockReset();
    mockAlarmScheduleAlarm.mockReset();
    mockAlarmScheduleAlarm.mockResolvedValue({ id: 99 });
    mockEnsureReminderNotificationChannel.mockReset();
    mockEnsureReminderNotificationChannel.mockResolvedValue(undefined);
    mockGetNextScheduledAt.mockReset();
    mockGetNextScheduledAt.mockReturnValue(null);
    mockGetDueReminderRepeatTimes.mockReset();
    mockGetDueReminderRepeatTimes.mockReturnValue([]);
    mockHasTimeComponent.mockReset();
    mockHasTimeComponent.mockReturnValue(false);
    mockLogInfo.mockClear();
    mockPermissionsAndroidCheck.mockReset();
    mockPermissionsAndroidRequest.mockReset();
    mockPermissionsAndroidCheck.mockResolvedValue(true);
    mockPermissionsAndroidRequest.mockResolvedValue('granted');
    mockPlatform.OS = 'android';
    mockPlatform.Version = 34;
    __localNotificationTestUtils.resetForTests();
  });

  afterEach(() => {
    __localNotificationTestUtils.resetForTests();
  });

  it('retries loading the alarm map after a failed storage read', async () => {
    mockAsyncStorageGetItem
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce(JSON.stringify({ 'task:1': { id: 42 } }));

    await __localNotificationTestUtils.loadAlarmMapIfNeeded();
    expect(__localNotificationTestUtils.isAlarmMapLoaded()).toBe(false);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().size).toBe(0);

    await __localNotificationTestUtils.loadAlarmMapIfNeeded();
    expect(__localNotificationTestUtils.isAlarmMapLoaded()).toBe(true);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().get('task:1')).toEqual({ id: 42 });
  });

  it('clears the notification open handler when the service stops', async () => {
    const handler = vi.fn();
    setLocalNotificationOpenHandler(handler);

    expect(__localNotificationTestUtils.getNotificationOpenHandler()).toBe(handler);

    await stopLocalMobileNotifications();

    expect(__localNotificationTestUtils.getNotificationOpenHandler()).toBeNull();
  });

  it('clears persisted alarms when Android notification permission is denied on startup', async () => {
    mockAsyncStorageGetItem.mockResolvedValue(JSON.stringify({ 'task:1': { id: 42 } }));
    mockPermissionsAndroidCheck.mockResolvedValue(false);
    mockPermissionsAndroidRequest.mockResolvedValue('never_ask_again');

    await startLocalMobileNotifications();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(42);
    expect(mockAlarmDeleteRepeatingAlarm).toHaveBeenCalledWith(42);
    expect(mockAlarmRemoveFiredNotification).toHaveBeenCalledWith(42);
    expect(mockAlarmRemoveAllFiredNotifications).toHaveBeenCalledTimes(1);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().size).toBe(0);
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith('mindwtr:local:alarms:v1', '{}');
  });

  it('ensures the Android reminder notification channel when permission is already granted', async () => {
    await startLocalMobileNotifications();

    expect(mockEnsureReminderNotificationChannel).toHaveBeenCalledWith(
      'mindwtr_reminders_v2',
      'Mindwtr reminders'
    );
  });

  it('ensures the Android reminder notification channel after permission is granted from the runtime prompt', async () => {
    mockPermissionsAndroidCheck.mockResolvedValue(false);
    mockPermissionsAndroidRequest.mockResolvedValue('granted');

    await startLocalMobileNotifications();

    expect(mockEnsureReminderNotificationChannel).toHaveBeenCalledWith(
      'mindwtr_reminders_v2',
      'Mindwtr reminders'
    );
  });

  it('schedules task reminders with a non-empty message body and snooze action', async () => {
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Pay rent',
        description: '',
      },
    ];
    mockGetNextScheduledAt.mockReturnValue(new Date(Date.now() + 5 * 60 * 1000));

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_cancel: true,
        channel: 'mindwtr_reminders_v2',
        has_button: true,
        has_complete_action: true,
        loop_sound: false,
        message: 'Pay rent',
        play_sound: true,
        snooze_interval: 10,
        title: 'Pay rent',
        use_big_text: true,
        vibrate: false,
        data: expect.objectContaining({
          kind: 'task-reminder',
          notificationActionComplete: 'true',
          taskId: 'task-1',
        }),
      })
    );
  });

  it('schedules future due-time repeat occurrences as :r{i} keyed one-shots', async () => {
    const now = Date.now();
    mockStoreState.tasks = [{ id: 'task-1', title: 'Pay rent', description: '' }];
    mockGetNextScheduledAt.mockReturnValue(new Date(now + 5 * 60 * 1000));
    mockGetDueReminderRepeatTimes.mockReturnValue([
      new Date(now + 35 * 60 * 1000),
      new Date(now + 65 * 60 * 1000),
      new Date(now + 95 * 60 * 1000),
      new Date(now + 125 * 60 * 1000),
    ]);

    await startLocalMobileNotifications();

    const alarmKeys = (mockAlarmScheduleAlarm.mock.calls as unknown as Array<[{ data?: { alarmKey?: string } }]>)
      .map((call) => call[0]?.data?.alarmKey);
    expect(alarmKeys).toEqual(expect.arrayContaining([
      'task:task-1:r1',
      'task:task-1:r2',
      'task:task-1:r3',
      'task:task-1:r4',
    ]));
    expect(alarmKeys).not.toContain('task:task-1:r5');
  });

  it('reaps due-time repeat occurrences when the task is no longer active', async () => {
    mockAsyncStorageGetItem.mockResolvedValue(JSON.stringify({
      'task:task-1:r1': { id: 42 },
      'task:task-1:r2': { id: 43 },
    }));
    // Task is done: no base reminder and no repeat occurrences.
    mockStoreState.tasks = [{ id: 'task-1', title: 'Pay rent', description: '' }];
    mockGetNextScheduledAt.mockReturnValue(null);
    mockGetDueReminderRepeatTimes.mockReturnValue([]);

    await startLocalMobileNotifications();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(42);
    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(43);
    const snapshot = __localNotificationTestUtils.getAlarmMapSnapshot();
    expect(snapshot.has('task:task-1:r1')).toBe(false);
    expect(snapshot.has('task:task-1:r2')).toBe(false);
  });

  it('logs reminder scheduling diagnostics without task title or description content', async () => {
    const fireAt = new Date(Date.now() + 5 * 60 * 1000);
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Private task title',
        description: 'Private task details',
        dueDate: fireAt.toISOString(),
      },
    ];
    mockHasTimeComponent.mockImplementation((value?: string) => Boolean(value?.includes('T')));
    mockGetNextScheduledAt.mockReturnValue(fireAt);

    await startLocalMobileNotifications();

    expect(mockLogInfo).toHaveBeenCalledWith(
      '[Local Notifications] Reschedule cycle complete',
      expect.objectContaining({
        scope: 'notifications',
        extra: expect.objectContaining({
          futureDueDateReminderCount: 1,
          oneShotReminderCount: 1,
          scheduledOneShotReminderCount: 1,
          taskReminderCount: 1,
        }),
      })
    );

    const logPayload = JSON.stringify(mockLogInfo.mock.calls);
    expect(logPayload).not.toContain('Private task title');
    expect(logPayload).not.toContain('Private task details');
  });

  it('only schedules the next 60 upcoming task reminders on iOS', async () => {
    const baseTime = new Date('2026-03-04T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    mockPlatform.OS = 'ios';

    try {
      mockStoreState.tasks = Array.from({ length: 65 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        description: '',
      })).reverse();
      mockGetNextScheduledAt.mockImplementation((task) => {
        const id = String((task as { id: string }).id);
        const index = Number(id.replace('task-', ''));
        return new Date(baseTime.getTime() + (index + 1) * 60_000);
      });

      await startLocalMobileNotifications();

      const alarmScheduleCalls = mockAlarmScheduleAlarm.mock.calls as unknown as Array<[
        { data?: { taskId?: string } },
      ]>;
      const scheduledTaskIds = new Set(
        alarmScheduleCalls
          .map(([details]) => details.data?.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string')
      );

      expect(scheduledTaskIds.size).toBe(60);
      expect(scheduledTaskIds.has('task-0')).toBe(true);
      expect(scheduledTaskIds.has('task-59')).toBe(true);
      expect(scheduledTaskIds.has('task-60')).toBe(false);
    } finally {
      mockPlatform.OS = 'android';
      vi.useRealTimers();
    }
  });

  it('allows a larger one-shot reminder window on Android', async () => {
    const baseTime = new Date('2026-03-04T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      mockStoreState.tasks = Array.from({ length: 205 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        description: '',
      })).reverse();
      mockGetNextScheduledAt.mockImplementation((task) => {
        const id = String((task as { id: string }).id);
        const index = Number(id.replace('task-', ''));
        return new Date(baseTime.getTime() + (index + 1) * 60_000);
      });

      await startLocalMobileNotifications();

      const alarmScheduleCalls = mockAlarmScheduleAlarm.mock.calls as unknown as Array<[
        { data?: { taskId?: string } },
      ]>;
      const scheduledTaskIds = new Set(
        alarmScheduleCalls
          .map(([details]) => details.data?.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string')
      );

      expect(scheduledTaskIds.size).toBe(200);
      expect(scheduledTaskIds.has('task-0')).toBe(true);
      expect(scheduledTaskIds.has('task-199')).toBe(true);
      expect(scheduledTaskIds.has('task-200')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes separate start and due reminder preferences into task scheduling', async () => {
    mockStoreState.settings = {
      notificationsEnabled: true,
      startDateNotificationsEnabled: false,
      dueDateNotificationsEnabled: true,
    };
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Pay rent',
        description: '',
      },
    ];
    mockGetNextScheduledAt.mockReturnValue(new Date(Date.now() + 5 * 60 * 1000));

    await startLocalMobileNotifications();

    expect(mockGetNextScheduledAt).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      expect.any(Date),
      expect.objectContaining({
        includeStartTime: false,
        includeDueDate: true,
        includeReviewAt: true,
      })
    );
  });

  it('marks task review date reminders so notification taps can open Review', async () => {
    const reviewAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockStoreState.settings = {
      notificationsEnabled: true,
      reviewAtNotificationsEnabled: true,
    };
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Review proposal',
        description: '',
        reviewAt,
      },
    ];
    mockHasTimeComponent.mockReturnValue(true);
    mockGetNextScheduledAt.mockReturnValue(new Date(reviewAt));

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'task-review',
          taskId: 'task-1',
        }),
        has_complete_action: false,
      })
    );
  });

  it('schedules weekly review even when task reminders are disabled', async () => {
    mockStoreState.settings = {
      notificationsEnabled: false,
      weeklyReviewEnabled: true,
      weeklyReviewDay: 2,
      weeklyReviewTime: '18:30',
    };

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_cancel: true,
        channel: 'mindwtr_reminders_v2',
        message: 'Weekly review body',
        title: 'Weekly review',
      })
    );
  });

  it('reschedules current task reminders when startup is requested while already running', async () => {
    const firstFireAt = new Date(Date.now() + 5 * 60 * 1000);
    const recurringFollowUpFireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    mockStoreState.tasks = [
      { id: 'recurring-original', title: 'Daily standup', description: '' },
    ];
    mockGetNextScheduledAt.mockImplementation((task) => {
      const id = String((task as { id?: string }).id);
      if (id === 'recurring-original') return firstFireAt;
      if (id === 'recurring-follow-up') return recurringFollowUpFireAt;
      return null;
    });

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'recurring-original' }),
      })
    );

    mockAlarmScheduleAlarm.mockClear();
    mockStoreState.tasks = [
      { id: 'recurring-follow-up', title: 'Daily standup', description: '' },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'recurring-follow-up' }),
      })
    );
  });

  it('does not reschedule unchanged persisted daily digest alarms on startup', async () => {
    const signature = JSON.stringify({
      title: 'Morning',
      message: 'Morning body',
      fireAt: 'daily:09:00',
      repeatInterval: 'daily',
      hasSnoozeAction: false,
      data: { kind: 'daily-digest' },
    });
    mockAsyncStorageGetItem.mockResolvedValue(JSON.stringify({
      'digest:morning': { id: 42, signature },
    }));
    mockStoreState.settings = {
      notificationsEnabled: true,
      dailyDigestMorningEnabled: true,
      dailyDigestMorningTime: '09:00',
    };

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).not.toHaveBeenCalled();
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().get('digest:morning')).toEqual({
      id: 42,
      signature,
    });
  });

  it('falls back to the title when sending an immediate notification without a message', async () => {
    await sendLocalMobileNotification('Focus session done');

    expect(mockAlarmSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Focus session done',
        message: 'Focus session done',
      })
    );
    expect(mockAlarmScheduleAlarm).not.toHaveBeenCalled();
  });

  it('schedules a sound-enabled pomodoro completion alarm', async () => {
    mockAsyncStorageGetItem.mockResolvedValue(null);
    const fireAt = new Date('2099-05-22T12:30:00.000Z');

    await scheduleLocalPomodoroCompletionNotification('Pomodoro Focus', 'Take a break.', fireAt, {
      phase: 'focus-complete',
    });

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Pomodoro Focus',
        message: 'Take a break.',
        play_sound: true,
        schedule_type: 'once',
        fire_date: fireAt.toISOString(),
        data: {
          kind: 'pomodoro',
          phase: 'focus-complete',
        },
      })
    );
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith(
      'mindwtr:local:pomodoro-alarm:v1',
      JSON.stringify({ id: 99, fireAtMs: fireAt.getTime() })
    );
  });

  it('cancels a pending pomodoro completion alarm', async () => {
    mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
      key === 'mindwtr:local:pomodoro-alarm:v1'
        ? JSON.stringify({ id: 41, fireAtMs: Date.now() + 60_000 })
        : null
    ));

    await cancelLocalPomodoroCompletionNotification();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmDeleteRepeatingAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmRemoveFiredNotification).toHaveBeenCalledWith(41);
    expect(mockAsyncStorageRemoveItem).toHaveBeenCalledWith('mindwtr:local:pomodoro-alarm:v1');
  });

  it('keeps an already fired pomodoro notification visible while clearing its stored alarm', async () => {
    mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
      key === 'mindwtr:local:pomodoro-alarm:v1'
        ? JSON.stringify({ id: 41, fireAtMs: Date.now() - 1000 })
        : null
    ));

    await cancelLocalPomodoroCompletionNotification();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmDeleteRepeatingAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmRemoveFiredNotification).not.toHaveBeenCalled();
    expect(mockAsyncStorageRemoveItem).toHaveBeenCalledWith('mindwtr:local:pomodoro-alarm:v1');
  });
});
