import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ListHeader } from './ListHeader';

const translations: Record<string, string> = {
    'bulk.select': 'Select',
    'common.tasks': 'tasks',
    'filters.priority': 'Priority',
    'focus.group.energy': 'Energy',
    'list.details': 'Details',
    'list.detailsOff': 'Details off',
    'list.density': 'Density',
    'list.densityComfortable': 'Comfortable',
    'list.groupBy': 'Group',
    'list.groupByArea': 'Area',
    'list.groupByContext': 'Context',
    'list.groupByNone': 'No grouping',
    'list.groupByProject': 'Project',
    'people.title': 'People',
    'sort.created': 'Oldest',
    'sort.created-desc': 'Newest',
    'sort.default': 'Default',
    'sort.due': 'Due date',
    'sort.label': 'Sort',
    'sort.review': 'Review',
    'sort.start': 'Start date',
    'sort.title': 'Title',
    'taskEdit.tagsLabel': 'Tags',
};

const t = (key: string) => translations[key] ?? key;

describe('ListHeader', () => {
    it('labels sort and group controls visibly inside the compact header controls', () => {
        render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByText('Sort')).toBeInTheDocument();
        expect(screen.getByText('Group')).toBeInTheDocument();
        expect(screen.getByTestId('list-sort-icon')).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Group' })).toBeInTheDocument();
    });

    it('renders supplied group-by options including tags', () => {
        render(
            <ListHeader
                title="Focus"
                showNextCount={false}
                nextCount={0}
                taskCount={3}
                hasFilters={false}
                filterSummaryLabel=""
                filterSummarySuffix=""
                sortBy="default"
                onChangeSortBy={vi.fn()}
                showGroupBy
                groupBy="none"
                groupByOptions={['none', 'tag']}
                onChangeGroupBy={vi.fn()}
                selectionMode={false}
                onToggleSelection={vi.fn()}
                showListDetails
                onToggleDetails={vi.fn()}
                densityMode="comfortable"
                onToggleDensity={vi.fn()}
                t={t}
            />
        );

        expect(screen.getByRole('option', { name: 'Tags' })).toBeInTheDocument();
    });
});
