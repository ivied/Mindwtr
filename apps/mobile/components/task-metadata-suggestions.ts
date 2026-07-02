import { getPersonSuggestionNames, type Person, type Task } from '@mindwtr/core';

export const getAssignedToSuggestions = (
  tasks: Task[],
  value: string | undefined,
  limit: number,
  people: Person[] = [],
): string[] => {
  return getPersonSuggestionNames(people, tasks, value, limit);
};
