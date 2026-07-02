import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgendaHeader } from './AgendaHeader';

const resolveText = (key: string, fallback: string) => {
    if (key === 'tags.title') return 'Tags';
    return fallback;
};

const t = (key: string) => resolveText(key, key);

describe('AgendaHeader', () => {
    it('offers tag as a Focus grouping option', () => {
        const onChangeGroupBy = vi.fn();
        const { getByLabelText } = render(
            <AgendaHeader
                filterCount={0}
                filtersOpen={false}
                nextActionsCount={3}
                nextGroupBy="none"
                onChangeGroupBy={onChangeGroupBy}
                onToggleDetails={vi.fn()}
                onToggleFilters={vi.fn()}
                onToggleTop3={vi.fn()}
                resolveText={resolveText}
                showListDetails={false}
                t={t}
                top3Only={false}
            />
        );

        const groupSelect = getByLabelText('Group') as HTMLSelectElement;

        expect([...groupSelect.options].map((option) => option.value)).toContain('tag');

        fireEvent.change(groupSelect, { target: { value: 'tag' } });

        expect(onChangeGroupBy).toHaveBeenCalledWith('tag');
    });
});
