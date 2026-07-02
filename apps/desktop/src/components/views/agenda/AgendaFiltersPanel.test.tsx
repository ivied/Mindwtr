import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgendaFiltersPanel } from './AgendaFiltersPanel';

const translations: Record<string, string> = {
    'common.delete': 'Delete',
    'filters.clear': 'Clear',
    'filters.contexts': 'Contexts & tags',
    'filters.hide': 'Hide',
    'filters.label': 'Filters',
    'filters.priority': 'Priority',
    'filters.projects': 'Projects',
    'filters.show': 'Show',
    'filters.timeEstimate': 'Time estimate',
    'priority.urgent': 'Urgent priority',
    'sort.created': 'Created',
    'sort.created-desc': 'Newest',
    'sort.default': 'Default',
    'sort.due': 'Due',
    'sort.label': 'Sort',
    'sort.priority': 'Priority',
    'sort.start': 'Start',
    'taskEdit.energyLevel': 'Energy level',
    'taskEdit.locationLabel': 'Location',
    'taskEdit.locationPlaceholder': 'Office',
    'energyLevel.high': 'High energy',
};

const t = (key: string) => translations[key] ?? key;

const createProps = (overrides: Partial<Parameters<typeof AgendaFiltersPanel>[0]> = {}): Parameters<typeof AgendaFiltersPanel>[0] => ({
    activeFilterChips: [],
    allTokens: [],
    canSaveFilter: false,
    contextMatchMode: 'all',
    contextMatchModeLabels: { title: 'Context matching', any: 'Any', all: 'All' },
    energyLevelOptions: ['high'],
    focusSortBy: 'default',
    formatEstimate: () => '30m',
    hasFilters: false,
    locationFilter: '',
    onClearFilters: vi.fn(),
    onContextMatchModeChange: vi.fn(),
    onLocationChange: vi.fn(),
    onSaveFilter: vi.fn(),
    onSearchChange: vi.fn(),
    onSortChange: vi.fn(),
    onToggleEnergy: vi.fn(),
    onToggleFiltersOpen: vi.fn(),
    onTogglePriority: vi.fn(),
    onToggleProject: vi.fn(),
    onToggleTime: vi.fn(),
    onToggleToken: vi.fn(),
    priorityOptions: ['urgent'],
    projectOptions: [],
    saveFilterLabel: 'Save filter',
    searchQuery: '',
    selectedEnergyLevels: [],
    selectedPriorities: [],
    selectedProjects: [],
    selectedTimeEstimates: [],
    selectedTokens: [],
    showEnergyLevelFilters: false,
    showFiltersPanel: true,
    showLocationFilter: false,
    showNoProjectOption: false,
    showPriorityFilters: false,
    showTimeEstimateFilters: false,
    t,
    timeEstimateOptions: ['30min'],
    ...overrides,
});

describe('AgendaFiltersPanel', () => {
    it('hides optional metadata filters until current Focus tasks use those fields', () => {
        render(<AgendaFiltersPanel {...createProps()} />);

        expect(screen.queryByText('Urgent priority')).not.toBeInTheDocument();
        expect(screen.queryByText('High energy')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Location')).not.toBeInTheDocument();
        expect(screen.queryByText('Time estimate')).not.toBeInTheDocument();
    });

    it('shows optional metadata filters when current Focus tasks use those fields', () => {
        render(<AgendaFiltersPanel {...createProps({
            showEnergyLevelFilters: true,
            showLocationFilter: true,
            showPriorityFilters: true,
            showTimeEstimateFilters: true,
        })} />);

        expect(screen.getByText('Urgent priority')).toBeInTheDocument();
        expect(screen.getByText('High energy')).toBeInTheDocument();
        expect(screen.getByLabelText('Location')).toBeInTheDocument();
        expect(screen.getByText('Time estimate')).toBeInTheDocument();
        expect(screen.getByText('30m')).toBeInTheDocument();
    });
});
