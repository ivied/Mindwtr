import { describe, expect, test } from 'bun:test';
import type { AppData } from '@mindwtr/core';

import { createCloudService } from './cloud-service.js';

const iso = '2026-01-01T00:00:00.000Z';

const cloudData: AppData = {
  tasks: [
    {
      id: 'task-next',
      title: 'Call supplier',
      status: 'next',
      tags: ['#ops'],
      contexts: ['@phone'],
      description: 'Ask about the quote',
      projectId: 'project-1',
      dueDate: '2026-01-10',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    {
      id: 'task-inbox',
      title: 'Inbox note',
      status: 'inbox',
      tags: [],
      contexts: [],
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'task-token-only',
      title: 'Call finance',
      status: 'next',
      tags: ['#quote'],
      contexts: ['@quote'],
      assignedTo: 'Quote Owner',
      description: 'No matching body text',
      projectId: 'project-1',
      dueDate: '2026-01-11',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    },
    {
      id: 'task-deleted',
      title: 'Deleted task',
      status: 'next',
      tags: [],
      contexts: [],
      createdAt: iso,
      updatedAt: iso,
      deletedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  projects: [
    {
      id: 'project-1',
      title: 'Project One',
      status: 'active',
      color: '#6B7280',
      order: 0,
      tagIds: [],
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: 'project-deleted',
      title: 'Deleted Project',
      status: 'active',
      color: '#6B7280',
      order: 1,
      tagIds: [],
      createdAt: iso,
      updatedAt: iso,
      deletedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  sections: [
    {
      id: 'section-1',
      projectId: 'project-1',
      title: 'Section One',
      order: 0,
      createdAt: iso,
      updatedAt: iso,
    },
  ],
  areas: [
    {
      id: 'area-1',
      name: 'Work',
      order: 0,
      createdAt: iso,
      updatedAt: iso,
    },
  ],
  people: [
    {
      id: 'person-1',
      name: 'Alex',
      createdAt: iso,
      updatedAt: iso,
    },
    {
      id: 'person-deleted',
      name: 'Deleted Person',
      createdAt: iso,
      updatedAt: iso,
      deletedAt: '2026-01-04T00:00:00.000Z',
    },
  ],
  settings: {},
};

describe('cloud-backed MCP service', () => {
  test('reads and filters self-hosted Cloud data through /v1/data', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get('authorization') });
      return new Response(JSON.stringify(cloudData), { status: 200 });
    };
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher,
    });

    const tasks = await service.listTasks({
      status: 'next',
      projectId: 'project-1',
      search: 'quote',
      dueDateFrom: '2026-01-01',
      dueDateTo: '2026-01-31',
      sortBy: 'title',
      sortOrder: 'asc',
    });
    const task = await service.getTask({ id: 'task-next' });
    const projects = await service.listProjects();
    const sections = await service.listSections({ projectId: 'project-1' });
    const areas = await service.listAreas();
    const people = await service.listPeople();
    const deletedPeople = await service.listPeople({ includeDeleted: true });

    expect(requests[0]).toEqual({
      url: 'https://mindwtr.example.com/v1/data',
      authorization: 'Bearer cloud-token',
    });
    expect(tasks.map((item) => item.id)).toEqual(['task-next']);
    expect(task.title).toBe('Call supplier');
    expect(projects.map((item) => item.id)).toEqual(['project-1']);
    expect(sections.map((item) => item.id)).toEqual(['section-1']);
    expect(areas.map((item) => item.id)).toEqual(['area-1']);
    expect(people.map((item) => item.id)).toEqual(['person-1']);
    expect(deletedPeople.map((item) => item.id)).toEqual(['person-1', 'person-deleted']);
  });

  test('rejects write methods because Cloud MCP mode is read-only', async () => {
    const service = createCloudService({
      url: 'https://mindwtr.example.com',
      token: 'cloud-token',
      fetcher: async () => new Response(JSON.stringify(cloudData), { status: 200 }),
    });

    await expect(service.addTask({ title: 'Write' })).rejects.toThrow('Cloud MCP mode is read-only');
    await expect(service.deleteProject('project-1')).rejects.toThrow('Cloud MCP mode is read-only');
  });
});
