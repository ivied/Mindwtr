import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';

import {
  buildContextsViewFilterSections,
  taskHasContextOrTag,
  taskMatchesContextOrTagFilter,
} from './contexts-view-filter-utils';

const task = (overrides: Partial<Task> = {}): Task => ({
  contexts: [],
  createdAt: '2026-06-30T00:00:00.000Z',
  id: 'task-1',
  status: 'next',
  tags: [],
  title: 'Task',
  updatedAt: '2026-06-30T00:00:00.000Z',
  ...overrides,
});

describe('contexts-view-filter-utils', () => {
  it('keeps context and tag filter sections separate', () => {
    expect(buildContextsViewFilterSections({
      contextTokens: ['@home', '@work'],
      searchQuery: '',
      tagTokens: ['#errand'],
    })).toEqual([
      { kind: 'contexts', tokens: ['@home', '@work'] },
      { kind: 'tags', tokens: ['#errand'] },
    ]);
  });

  it('filters context and tag sections without merging them', () => {
    expect(buildContextsViewFilterSections({
      contextTokens: ['@home', '@work'],
      searchQuery: 'work',
      tagTokens: ['#workshop'],
    })).toEqual([
      { kind: 'contexts', tokens: ['@work'] },
      { kind: 'tags', tokens: ['#workshop'] },
    ]);

    expect(buildContextsViewFilterSections({
      contextTokens: ['@home'],
      searchQuery: 'bug',
      tagTokens: ['#bug'],
    })).toEqual([
      { kind: 'tags', tokens: ['#bug'] },
    ]);
  });

  it('matches selected filters against both token fields with hierarchy support', () => {
    const item = task({
      contexts: ['@work/deep'],
      tags: ['#client/acme'],
    });

    expect(taskHasContextOrTag(item)).toBe(true);
    expect(taskHasContextOrTag(task())).toBe(false);
    expect(taskMatchesContextOrTagFilter(item, '@work')).toBe(true);
    expect(taskMatchesContextOrTagFilter(item, '#client')).toBe(true);
    expect(taskMatchesContextOrTagFilter(item, '@phone')).toBe(false);
  });
});
