import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ListFiltersPanel } from './ListFiltersPanel';

const translations: Record<string, string> = {
    'filters.clear': 'Clear',
    'filters.contexts': 'Contexts & tags',
    'filters.hide': 'Hide',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'filters.timeEstimate': 'Time estimate',
    'priority.urgent': 'Urgent priority',
};

const t = (key: string) => translations[key] ?? key;

const createProps = (overrides: Partial<Parameters<typeof ListFiltersPanel>[0]> = {}): Parameters<typeof ListFiltersPanel>[0] => ({
    allTokens: ['@home'],
    formatEstimate: () => '30m',
    hasFilters: false,
    onClearFilters: vi.fn(),
    onToggleEstimate: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleToken: vi.fn(),
    onToggleOpen: vi.fn(),
    priorityOptions: ['urgent'],
    selectedPriorities: [],
    selectedTimeEstimates: [],
    selectedTokens: [],
    showFiltersPanel: true,
    showPriorityFilters: false,
    showTimeEstimateFilters: false,
    t,
    timeEstimateOptions: ['30min'],
    tokenCounts: { '@home': 1 },
    ...overrides,
});

describe('ListFiltersPanel', () => {
    it('hides optional metadata filters until the current list uses those fields', () => {
        render(<ListFiltersPanel {...createProps()} />);

        expect(screen.getByText('Contexts & tags')).toBeInTheDocument();
        expect(screen.queryByText('Urgent priority')).not.toBeInTheDocument();
        expect(screen.queryByText('Time estimate')).not.toBeInTheDocument();
    });

    it('shows optional metadata filters when the current list uses those fields', () => {
        render(<ListFiltersPanel {...createProps({
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
        })} />);

        expect(screen.getByText('Urgent priority')).toBeInTheDocument();
        expect(screen.getByText('Time estimate')).toBeInTheDocument();
        expect(screen.getByText('30m')).toBeInTheDocument();
    });
});
