import { matchesHierarchicalToken, type Task } from '@mindwtr/core';

export type ContextsViewFilterSection = {
  kind: 'contexts' | 'tags';
  tokens: string[];
};

type BuildContextsViewFilterSectionsInput = {
  contextTokens: string[];
  searchQuery: string;
  tagTokens: string[];
};

const matchesSearch = (token: string, query: string): boolean => {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery.length === 0 || token.toLowerCase().includes(normalizedQuery);
};

export const buildContextsViewFilterSections = ({
  contextTokens,
  searchQuery,
  tagTokens,
}: BuildContextsViewFilterSectionsInput): ContextsViewFilterSection[] => {
  const contexts = contextTokens.filter((token) => matchesSearch(token, searchQuery));
  const tags = tagTokens.filter((token) => matchesSearch(token, searchQuery));
  return [
    ...(contexts.length > 0 ? [{ kind: 'contexts' as const, tokens: contexts }] : []),
    ...(tags.length > 0 ? [{ kind: 'tags' as const, tokens: tags }] : []),
  ];
};

export const taskHasContextOrTag = (task: Task): boolean => (
  (task.contexts?.length ?? 0) > 0 || (task.tags?.length ?? 0) > 0
);

export const taskMatchesContextOrTagFilter = (task: Task, token: string): boolean => (
  [...(task.contexts ?? []), ...(task.tags ?? [])]
    .some((taskToken) => matchesHierarchicalToken(token, taskToken))
);
