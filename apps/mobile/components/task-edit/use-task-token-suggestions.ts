import { useMemo } from 'react';
import type { TaskTokenUsage } from '@mindwtr/core';
import { getFrequentTaskTokensFromUsage } from '@mindwtr/core';
import { QUICK_TOKEN_LIMIT } from './task-edit-modal.utils';
import { MAX_VISIBLE_SUGGESTIONS } from './recurrence-utils';
import { getActiveTokenQuery, parseTokenList } from './task-edit-token-utils';

type UseTaskTokenSuggestionsParams = {
    editedContexts?: string[];
    editedTags?: string[];
    contextInputDraft: string;
    tagInputDraft: string;
    allContexts: string[];
    allTags: string[];
    contextTokenUsage: TaskTokenUsage[];
    tagTokenUsage: TaskTokenUsage[];
};

export const useTaskTokenSuggestions = ({
    editedContexts,
    editedTags,
    contextInputDraft,
    tagInputDraft,
    allContexts,
    allTags,
    contextTokenUsage,
    tagTokenUsage,
}: UseTaskTokenSuggestionsParams) => {
    const contextSuggestionPool = useMemo(() => {
        return Array.from(new Set([...(editedContexts ?? []), ...allContexts]))
            .filter((item): item is string => Boolean(item?.startsWith('@')));
    }, [allContexts, editedContexts]);

    const tagSuggestionPool = useMemo(() => {
        return Array.from(new Set([...(editedTags ?? []), ...allTags]))
            .filter((item): item is string => Boolean(item?.startsWith('#')));
    }, [allTags, editedTags]);

    const contextTokenQuery = useMemo(
        () => getActiveTokenQuery(contextInputDraft, '@'),
        [contextInputDraft]
    );
    const tagTokenQuery = useMemo(
        () => getActiveTokenQuery(tagInputDraft, '#'),
        [tagInputDraft]
    );

    const contextTokenSuggestions = useMemo(() => {
        if (!contextTokenQuery) return [];
        const selected = new Set(parseTokenList(contextInputDraft, '@'));
        return contextSuggestionPool
            .filter((token) => token.slice(1).toLowerCase().includes(contextTokenQuery))
            .filter((token) => !selected.has(token))
            .slice(0, MAX_VISIBLE_SUGGESTIONS);
    }, [contextInputDraft, contextSuggestionPool, contextTokenQuery]);

    const tagTokenSuggestions = useMemo(() => {
        if (!tagTokenQuery) return [];
        const selected = new Set(parseTokenList(tagInputDraft, '#'));
        return tagSuggestionPool
            .filter((token) => token.slice(1).toLowerCase().includes(tagTokenQuery))
            .filter((token) => !selected.has(token))
            .slice(0, MAX_VISIBLE_SUGGESTIONS);
    }, [tagInputDraft, tagSuggestionPool, tagTokenQuery]);

    const frequentContextSuggestions = useMemo(
        () => getFrequentTaskTokensFromUsage(contextTokenUsage, QUICK_TOKEN_LIMIT),
        [contextTokenUsage]
    );

    const frequentTagSuggestions = useMemo(() => {
        return getFrequentTaskTokensFromUsage(tagTokenUsage, QUICK_TOKEN_LIMIT);
    }, [tagTokenUsage]);

    const selectedContextTokens = useMemo(
        () => new Set(parseTokenList(contextInputDraft, '@')),
        [contextInputDraft]
    );
    const selectedTagTokens = useMemo(
        () => new Set(parseTokenList(tagInputDraft, '#')),
        [tagInputDraft]
    );

    return {
        contextSuggestionPool,
        tagSuggestionPool,
        contextTokenQuery,
        tagTokenQuery,
        contextTokenSuggestions,
        tagTokenSuggestions,
        frequentContextSuggestions,
        frequentTagSuggestions,
        selectedContextTokens,
        selectedTagTokens,
    };
};
