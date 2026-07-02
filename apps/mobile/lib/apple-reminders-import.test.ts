import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetItem,
  mockSetItem,
  mockGetCalendarsAsync,
  mockGetRemindersAsync,
  mockDeleteReminderAsync,
  mockGetRemindersPermissionsAsync,
  mockRequestRemindersPermissionsAsync,
  mockPlatform,
} = vi.hoisted(() => ({
  mockGetItem: vi.fn(async () => null as string | null),
  mockSetItem: vi.fn(async () => undefined),
  mockGetCalendarsAsync: vi.fn(async () => []),
  mockGetRemindersAsync: vi.fn(async () => []),
  mockDeleteReminderAsync: vi.fn(async () => undefined),
  mockGetRemindersPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  mockRequestRemindersPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  mockPlatform: { OS: 'ios' },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: mockGetItem,
    setItem: mockSetItem,
  },
}));

vi.mock('react-native', () => ({
  Platform: mockPlatform,
}));

vi.mock('expo-calendar', () => ({
  EntityTypes: { REMINDER: 'reminder' },
  getCalendarsAsync: mockGetCalendarsAsync,
  getRemindersAsync: mockGetRemindersAsync,
  deleteReminderAsync: mockDeleteReminderAsync,
  getRemindersPermissionsAsync: mockGetRemindersPermissionsAsync,
  requestRemindersPermissionsAsync: mockRequestRemindersPermissionsAsync,
}));

import {
  APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
  getAppleReminderLists,
  importAppleRemindersIntoInbox,
  loadAppleRemindersImportSettings,
  requestAppleRemindersPermission,
} from './apple-reminders-import';

describe('apple-reminders-import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.OS = 'ios';
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    mockGetCalendarsAsync.mockResolvedValue([]);
    mockGetRemindersAsync.mockResolvedValue([]);
    mockDeleteReminderAsync.mockResolvedValue(undefined);
    mockGetRemindersPermissionsAsync.mockResolvedValue({ status: 'granted' });
    mockRequestRemindersPermissionsAsync.mockResolvedValue({ status: 'granted' });
  });

  it('loads reminder lists from iOS reminder calendars', async () => {
    mockGetCalendarsAsync.mockResolvedValue([
      { id: 'work', title: 'Work', color: '#2563eb' },
      { id: '', title: 'Broken' },
      { id: 'inbox', name: 'Inbox' },
    ] as any);

    await expect(getAppleReminderLists()).resolves.toEqual([
      { id: 'inbox', title: 'Inbox', color: undefined },
      { id: 'work', title: 'Work', color: '#2563eb' },
    ]);
    expect(mockGetCalendarsAsync).toHaveBeenCalledWith('reminder');
  });

  it('imports incomplete reminders into Inbox and preserves notes', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: ' Buy milk ', notes: ' 2% ', completed: false },
      { id: 'rem-2', title: 'Done item', completed: true },
      { id: 'rem-3', title: '   ', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      listId: 'list-1',
      listTitle: 'Inbox',
    })).resolves.toEqual({
      importedCount: 1,
      deletedCount: 0,
      deleteFailedCount: 0,
      skippedDuplicateCount: 0,
      skippedCompletedCount: 1,
      skippedEmptyTitleCount: 1,
      failedCount: 0,
    });

    expect(addTask).toHaveBeenCalledWith('Buy milk', {
      status: 'inbox',
      description: '2%',
    });
    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        selectedListId: 'list-1',
        selectedListTitle: 'Inbox',
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: false,
      }),
    );
  });

  it('deletes reminders only after their Inbox task is created when enabled', async () => {
    const addTask = vi.fn()
      .mockResolvedValueOnce({ success: true, id: 'task-id' })
      .mockResolvedValueOnce({ success: false });
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Imported task', completed: false },
      { id: 'rem-2', title: 'Failed task', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toEqual({
      importedCount: 1,
      deletedCount: 1,
      deleteFailedCount: 0,
      skippedDuplicateCount: 0,
      skippedCompletedCount: 0,
      skippedEmptyTitleCount: 0,
      failedCount: 1,
    });

    expect(mockDeleteReminderAsync).toHaveBeenCalledTimes(1);
    expect(mockDeleteReminderAsync).toHaveBeenCalledWith('rem-1');
    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        selectedListId: 'list-1',
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: true,
      }),
    );
  });

  it('keeps imported reminder IDs when deleting from Apple Reminders fails', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockDeleteReminderAsync.mockRejectedValue(new Error('delete failed'));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Imported task', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      listId: 'list-1',
      deleteImportedReminders: true,
    })).resolves.toMatchObject({
      importedCount: 1,
      deletedCount: 0,
      deleteFailedCount: 1,
      failedCount: 0,
    });

    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        selectedListId: 'list-1',
        importedReminderIds: ['rem-1'],
        deleteImportedReminders: true,
      }),
    );
  });

  it('skips reminders that were imported before', async () => {
    const addTask = vi.fn(async () => ({ success: true, id: 'task-id' }));
    mockGetItem.mockResolvedValue(JSON.stringify({
      selectedListId: 'list-1',
      deleteImportedReminders: false,
      importedReminderIds: ['rem-1', 'fallback:list-1:Floating thought:note:::'],
    }));
    mockGetRemindersAsync.mockResolvedValue([
      { id: 'rem-1', title: 'Already imported', completed: false },
      { title: 'Floating thought', notes: 'note', completed: false },
      { id: 'rem-2', title: 'New idea', completed: false },
    ] as any);

    await expect(importAppleRemindersIntoInbox({
      addTask,
      listId: 'list-1',
    })).resolves.toMatchObject({
      importedCount: 1,
      skippedDuplicateCount: 2,
      failedCount: 0,
    });

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith('New idea', { status: 'inbox' });
    expect(mockSetItem).toHaveBeenCalledWith(
      APPLE_REMINDERS_IMPORT_SETTINGS_KEY,
      JSON.stringify({
        selectedListId: 'list-1',
        importedReminderIds: ['rem-1', 'fallback:list-1:Floating thought:note:::', 'rem-2'],
        deleteImportedReminders: false,
      }),
    );
  });

  it('keeps malformed stored settings from breaking import state', async () => {
    mockGetItem.mockResolvedValue('{bad json');

    await expect(loadAppleRemindersImportSettings()).resolves.toEqual({
      importedReminderIds: [],
      deleteImportedReminders: false,
    });
  });

  it('reports unavailable reminders permissions outside iOS', async () => {
    mockPlatform.OS = 'android';

    await expect(requestAppleRemindersPermission()).resolves.toBe('unavailable');
    expect(mockRequestRemindersPermissionsAsync).not.toHaveBeenCalled();
  });
});
