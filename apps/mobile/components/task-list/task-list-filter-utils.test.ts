import { describe, expect, it } from 'vitest';
import type { Task } from '@mindwtr/core';

import {
  buildMobileTaskListFilterCriteria,
  buildMobileTaskListFilters,
  countActiveMobileTaskFilters,
  getMobileTaskMetadataFilterVisibility,
  taskMatchesMobileTaskFilters,
  type MobileTaskListFilterInput,
} from './task-list-filter-utils';

const emptyFilterInput: MobileTaskListFilterInput = {
  energyLevels: [],
  locationQuery: '',
  priorities: [],
  searchQuery: '',
  timeEstimates: [],
  tokens: [],
  contextMatchMode: 'all',
};

const makeFilters = (overrides: Partial<MobileTaskListFilterInput> = {}) => (
  buildMobileTaskListFilters({ ...emptyFilterInput, ...overrides })
);

const task: Task = {
  contexts: ['@work/deep'],
  createdAt: '2026-05-27T10:00:00.000Z',
  description: 'Draft launch notes',
  energyLevel: 'high',
  id: 'c5290e2c-1b77-4f77-8927-6d187e141891',
  location: 'Office',
  priority: 'urgent',
  status: 'next',
  tags: ['#client/acme'],
  timeEstimate: '30min',
  title: 'Prepare release checklist',
  updatedAt: '2026-05-27T10:00:00.000Z',
};

describe('task-list-filter-utils', () => {
  it('builds core filter criteria from mobile filter controls', () => {
    expect(buildMobileTaskListFilterCriteria({
      ...emptyFilterInput,
      contextMatchMode: 'any',
      energyLevels: ['high'],
      locationQuery: 'office',
      priorities: ['urgent'],
      timeEstimates: ['30min'],
      tokens: ['@work', '@phone', '#client'],
    })).toEqual({
      contexts: ['@work', '@phone'],
      contextMatchMode: 'any',
      tags: ['#client'],
      priority: ['urgent'],
      energy: ['high'],
      timeEstimates: ['30min'],
      locations: ['office'],
    });
  });

  it('counts active filters across text and chip dimensions', () => {
    expect(countActiveMobileTaskFilters(makeFilters())).toBe(0);
    expect(countActiveMobileTaskFilters(makeFilters({
      energyLevels: ['high'],
      locationQuery: 'office',
      priorities: ['urgent'],
      searchQuery: 'release',
      timeEstimates: ['30min'],
      tokens: ['@work', '#client'],
    }))).toBe(7);
  });

  it('matches search query against title and description', () => {
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ searchQuery: 'release' }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ searchQuery: 'launch notes' }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ searchQuery: 'vacation' }))).toBe(false);
  });

  it('matches fielded task id searches with full and partial UUIDs', () => {
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ searchQuery: 'id:c5290e2c-1b77-4f77-8927-6d187e141891' }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ searchQuery: 'id:6d187e141891' }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ searchQuery: 'id:missing-task-id' }))).toBe(false);
  });

  it('matches context and tag filters using hierarchy prefixes', () => {
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ tokens: ['@work', '#client'] }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ tokens: ['@workshop'] }))).toBe(false);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ tokens: ['#ops'] }))).toBe(false);
  });

  it('can match any selected context while keeping tag filters required', () => {
    expect(taskMatchesMobileTaskFilters(task, makeFilters({
      tokens: ['@work', '@phone'],
      contextMatchMode: 'all',
    }))).toBe(false);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({
      tokens: ['@work', '@phone'],
      contextMatchMode: 'any',
    }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({
      tokens: ['@work', '@phone', '#ops'],
      contextMatchMode: 'any',
    }))).toBe(false);
  });

  it('matches priority, energy, time estimate, and location filters', () => {
    expect(taskMatchesMobileTaskFilters(task, makeFilters({
      energyLevels: ['high'],
      locationQuery: 'off',
      priorities: ['urgent'],
      timeEstimates: ['30min'],
    }))).toBe(true);

    expect(taskMatchesMobileTaskFilters(task, makeFilters({ priorities: ['low'] }))).toBe(false);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ energyLevels: ['low'] }))).toBe(false);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ timeEstimates: ['5min'] }))).toBe(false);
    expect(taskMatchesMobileTaskFilters(task, makeFilters({ locationQuery: 'home' }))).toBe(false);
  });

  it('matches custom time estimates by their coarse bucket', () => {
    const customTask = { ...task, timeEstimate: 'custom:150' as const };
    expect(taskMatchesMobileTaskFilters(customTask, makeFilters({ timeEstimates: ['3hr'] }))).toBe(true);
    expect(taskMatchesMobileTaskFilters(customTask, makeFilters({ timeEstimates: ['2hr'] }))).toBe(false);
  });

  it('shows metadata filters only when visible tasks already use those fields', () => {
    expect(getMobileTaskMetadataFilterVisibility([], {
      prioritiesEnabled: true,
      timeEstimatesEnabled: true,
    })).toEqual({
      energyLevel: false,
      location: false,
      priority: false,
      timeEstimate: false,
    });

    expect(getMobileTaskMetadataFilterVisibility([task], {
      prioritiesEnabled: true,
      timeEstimatesEnabled: true,
    })).toEqual({
      energyLevel: true,
      location: true,
      priority: true,
      timeEstimate: true,
    });

    expect(getMobileTaskMetadataFilterVisibility([task], {
      prioritiesEnabled: false,
      timeEstimatesEnabled: false,
    })).toMatchObject({ priority: false, timeEstimate: false });
  });
});
