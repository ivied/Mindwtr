import type { FilterCriteria, MultiValueFilterMatchMode, Task, TaskEnergyLevel, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { hasActiveFilterCriteria, matchesTask, parseSearchQuery, taskMatchesFilterCriteria } from '@mindwtr/core';
export { getTaskMetadataFilterVisibility as getMobileTaskMetadataFilterVisibility } from '@mindwtr/core';

export type MobileTaskListFilters = {
  criteria: FilterCriteria;
  searchQuery: string;
};

export type MobileTaskListFilterInput = {
  energyLevels: TaskEnergyLevel[];
  locationQuery: string;
  priorities: TaskPriority[];
  searchQuery: string;
  timeEstimates: TimeEstimate[];
  tokens: string[];
  contextMatchMode: MultiValueFilterMatchMode;
};

const normalize = (value: string | undefined): string => value?.trim().toLowerCase() ?? '';

export const buildMobileTaskListFilterCriteria = (filters: MobileTaskListFilterInput): FilterCriteria => {
  const contexts = filters.tokens.filter((token) => token.trim().startsWith('@'));
  const tags = filters.tokens.filter((token) => token.trim().startsWith('#'));
  const location = filters.locationQuery.trim();
  return {
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(contexts.length > 1 ? { contextMatchMode: filters.contextMatchMode } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(filters.priorities.length > 0 ? { priority: filters.priorities } : {}),
    ...(filters.energyLevels.length > 0 ? { energy: filters.energyLevels } : {}),
    ...(filters.timeEstimates.length > 0 ? { timeEstimates: filters.timeEstimates } : {}),
    ...(location ? { locations: [location] } : {}),
  };
};

export const buildMobileTaskListFilters = (filters: MobileTaskListFilterInput): MobileTaskListFilters => ({
  criteria: buildMobileTaskListFilterCriteria(filters),
  searchQuery: filters.searchQuery,
});

const countActiveTaskListCriteria = (criteria: FilterCriteria): number => (
  (criteria.contexts?.length ?? 0)
  + (criteria.tags?.length ?? 0)
  + (criteria.priority?.length ?? 0)
  + (criteria.energy?.length ?? 0)
  + (criteria.timeEstimates?.length ?? 0)
  + (criteria.locations?.length ?? 0)
  + (criteria.dueDateRange ? 1 : 0)
  + (criteria.startDateRange ? 1 : 0)
  + (criteria.statuses?.length ?? 0)
  + (criteria.assignedTo?.length ?? 0)
  + (criteria.timeEstimateRange ? 1 : 0)
  + (criteria.hasDescription !== undefined ? 1 : 0)
  + (criteria.isStarred !== undefined ? 1 : 0)
);

export const countActiveMobileTaskFilters = (filters: MobileTaskListFilters): number => (
  (normalize(filters.searchQuery) ? 1 : 0)
  + countActiveTaskListCriteria(filters.criteria)
);

const taskMatchesMobileSearchQuery = (task: Task, searchQueryValue: string): boolean => {
  const searchQuery = normalize(searchQueryValue);
  if (searchQuery) {
    const parsedSearch = parseSearchQuery(searchQuery);
    const hasFieldedTerm = parsedSearch.clauses.some((clause) =>
      clause.terms.some((term) => term.field !== null)
    );
    if (hasFieldedTerm) {
      const now = new Date();
      const matchesSearch = parsedSearch.clauses.some((clause) =>
        clause.terms.every((term) => matchesTask(term, task, null, now))
      );
      if (!matchesSearch) return false;
    } else {
      const searchable = `${task.title} ${task.description ?? ''}`.toLowerCase();
      if (!searchable.includes(searchQuery)) return false;
    }
  }

  return true;
};

export const taskMatchesMobileTaskFilters = (
  task: Task,
  filters: MobileTaskListFilters,
): boolean => {
  if (!taskMatchesMobileSearchQuery(task, filters.searchQuery)) return false;
  if (!hasActiveFilterCriteria(filters.criteria)) return true;
  return taskMatchesFilterCriteria(task, filters.criteria, { tokenMatchMode: 'all' });
};
