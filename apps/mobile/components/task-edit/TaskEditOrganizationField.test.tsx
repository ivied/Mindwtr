import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditOrganizationField } from './TaskEditOrganizationField';

const styles = {
    formGroup: {},
    label: {},
    dateRow: {},
    dateBtn: {},
    flex1: {},
    clearDateBtn: {},
    clearDateText: {},
    compactFieldRow: {},
    compactFieldLabel: {},
    compactFieldValue: {},
    statusContainer: {},
    statusContainerCompact: {},
    statusChip: {},
    statusChipCompact: {},
    statusText: {},
    statusTextCompact: {},
    input: {},
    tokenSuggestionsMenu: {},
    tokenSuggestionItem: {},
    tokenSuggestionItemLast: {},
    tokenSuggestionText: {},
};

const tc = {
    cardBg: '#111',
    border: '#333',
    filterBg: '#222',
    inputBg: '#111',
    secondaryText: '#aaa',
    text: '#fff',
    tint: '#3b82f6',
};

const t = (key: string) => ({
    'taskEdit.projectLabel': 'Project',
    'taskEdit.noProjectOption': 'No Project',
    'taskEdit.areaLabel': 'Area',
    'taskEdit.noAreaOption': 'No Area',
    'taskEdit.sectionLabel': 'Section',
    'taskEdit.noSectionOption': 'No Section',
    'taskEdit.statusLabel': 'Status',
    'people.new': 'New Person',
    'common.clear': 'Clear',
}[key] ?? key);

const baseProps = {
    applyAssignedToSuggestion: vi.fn(),
    areas: [],
    assignedToSuggestions: [],
    availableStatusOptions: [],
    editedTask: {},
    energyLevelOptions: [],
    handleInputFocus: vi.fn(),
    createAssignedToPerson: vi.fn(),
    prioritiesEnabled: true,
    priorityOptions: [],
    projectSections: [],
    projects: [],
    setEditedTask: vi.fn(),
    setShowAreaPicker: vi.fn(),
    setShowProjectPicker: vi.fn(),
    setShowSectionPicker: vi.fn(),
    styles,
    t,
    task: null,
    tc,
    timeEstimateOptions: [],
    timeEstimatesEnabled: true,
};

describe('TaskEditOrganizationField', () => {
    it('renders an unset project as a compact picker row', () => {
        const setShowProjectPicker = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="project"
                    setShowProjectPicker={setShowProjectPicker}
                />
            );
        });

        const compactButton = tree.root.findByProps({ accessibilityLabel: 'Project: No Project' });
        expect(compactButton.props.accessibilityRole).toBe('button');

        act(() => {
            compactButton.props.onPress();
        });

        expect(setShowProjectPicker).toHaveBeenCalledWith(true);
    });

    it('renders an unset area as a compact picker row', () => {
        const setShowAreaPicker = vi.fn();

        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="area"
                    setShowAreaPicker={setShowAreaPicker}
                />
            );
        });

        const compactButton = tree.root.findByProps({ accessibilityLabel: 'Area: No Area' });
        expect(compactButton.props.accessibilityRole).toBe('button');

        act(() => {
            compactButton.props.onPress();
        });

        expect(setShowAreaPicker).toHaveBeenCalledWith(true);
    });

    it('hides section after clearing the task project', () => {
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="section"
                    editedTask={{ projectId: undefined, sectionId: undefined }}
                    task={{
                        id: 'task-1',
                        title: 'Task',
                        status: 'next',
                        projectId: 'project-1',
                        sectionId: 'section-1',
                        tags: [],
                        contexts: [],
                        createdAt: '2026-04-01T00:00:00.000Z',
                        updatedAt: '2026-04-01T00:00:00.000Z',
                    }}
                    projectSections={[{ id: 'section-1', projectId: 'project-1', title: 'Planning' }]}
                />
            );
        });

        expect(tree.toJSON()).toBeNull();
    });

    it('offers to create a person from an unmatched assignment value', async () => {
        const createAssignedToPerson = vi.fn().mockResolvedValue({ id: 'person-1', name: 'Morgan' });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <TaskEditOrganizationField
                    {...(baseProps as any)}
                    fieldId="assignedTo"
                    editedTask={{ assignedTo: 'Morgan' }}
                    assignedToSuggestions={[]}
                    createAssignedToPerson={createAssignedToPerson}
                />
            );
        });

        const createButton = tree.root.findByProps({ accessibilityLabel: 'New Person: Morgan' });
        await act(async () => {
            await createButton.props.onPress();
        });

        expect(createAssignedToPerson).toHaveBeenCalledWith('Morgan');
    });
});
