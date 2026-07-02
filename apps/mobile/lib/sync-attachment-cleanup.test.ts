import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData } from '@mindwtr/core';

import * as FileSystem from './file-system';
import { runMobileAttachmentCleanup } from './sync-attachment-cleanup';

const now = '2026-01-01T00:00:00.000Z';

const buildData = (): AppData => ({
  tasks: [
    {
      id: 'deleted-task',
      title: 'Deleted task',
      status: 'done',
      contexts: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
      purgedAt: now,
      attachments: [
        {
          id: 'deleted-attachment',
          kind: 'file',
          title: 'shared.pdf',
          uri: '',
          cloudKey: 'attachments/shared.pdf',
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    {
      id: 'live-task',
      title: 'Live task',
      status: 'next',
      contexts: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      attachments: [
        {
          id: 'live-attachment',
          kind: 'file',
          title: 'shared.pdf',
          uri: '',
          cloudKey: 'attachments/shared.pdf',
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
  ],
  projects: [],
  sections: [],
  areas: [],
  people: [],
  settings: {},
});

const buildCleanupOptions = (appData: AppData) => ({
  appData,
  backend: 'file' as const,
  webdavConfig: null,
  cloudConfig: null,
  cloudProvider: 'selfhosted' as const,
  fileSyncPath: '/sync/mindwtr.json',
  fetcher: vi.fn() as unknown as typeof fetch,
  ensureLocalSnapshotFresh: vi.fn(),
  deleteDropboxAttachment: vi.fn(async () => undefined),
  isRemoteMissingError: vi.fn(() => false),
  logSyncInfo: vi.fn(),
  logSyncWarning: vi.fn(),
});

describe('runMobileAttachmentCleanup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not delete a remote attachment still referenced by another live task', async () => {
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);

    const result = await runMobileAttachmentCleanup(buildCleanupOptions(buildData()));

    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
    expect(result.appData.tasks.find((task) => task.id === 'live-task')?.attachments).toEqual([
      expect.objectContaining({
        id: 'live-attachment',
        cloudKey: 'attachments/shared.pdf',
      }),
    ]);
  });

  it('drops a stale pending remote delete when the cloud key is live again', async () => {
    const deleteAsync = vi.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);
    const data = buildData();
    data.settings = {
      attachments: {
        pendingRemoteDeletes: [
          {
            cloudKey: 'attachments/shared.pdf',
            title: 'shared.pdf',
            attempts: 1,
            lastErrorAt: now,
          },
        ],
      },
    };

    const result = await runMobileAttachmentCleanup(buildCleanupOptions(data));

    expect(deleteAsync).not.toHaveBeenCalled();
    expect(result.appData.settings.attachments?.pendingRemoteDeletes).toBeUndefined();
  });
});
