import { describe, it, expect, vi } from 'vitest';
import { createEvent, fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { Task } from '@mindwtr/core';
import { ChecklistField, reorderChecklistItems } from './ChecklistField';

const initialChecklist: NonNullable<Task['checklist']> = [
    { id: '1', title: 'Item 1', isCompleted: false },
    { id: '2', title: 'Item 2', isCompleted: false },
    { id: '3', title: 'Item 3', isCompleted: false },
];

function ChecklistHarness({
    initial = initialChecklist,
    description,
    onUpdateTask,
}: {
    initial?: Task['checklist'];
    description?: string;
    onUpdateTask?: (updates: Partial<Task>) => void;
}) {
    const [checklist, setChecklist] = useState<Task['checklist']>(initial);
    return (
        <ChecklistField
            t={(key) => key}
            taskId="task-1"
            checklist={checklist}
            description={description}
            updateTask={(_taskId, updates) => {
                onUpdateTask?.(updates);
                setChecklist(updates.checklist ?? []);
            }}
            resetTaskChecklist={() => setChecklist([])}
        />
    );
}

describe('ChecklistField', () => {
    it('reorders checklist items without changing completion state', () => {
        const reordered = reorderChecklistItems(
            [
                { id: 'first', title: 'First', isCompleted: false },
                { id: 'second', title: 'Second', isCompleted: true },
                { id: 'third', title: 'Third', isCompleted: false },
            ],
            'third',
            'first',
        );

        expect(reordered?.map((item) => item.id)).toEqual(['third', 'first', 'second']);
        expect(reordered?.map((item) => item.isCompleted)).toEqual([false, false, true]);
    });

    it('syncs existing markdown task-list lines when checklist completion changes', () => {
        const updates: Partial<Task>[] = [];
        const { getByRole } = render(
            <ChecklistHarness
                description={'Intro\n- [ ] Item 1\n- [ ] Item 2\n- [ ] Item 3\nOutro'}
                onUpdateTask={(next) => updates.push(next)}
            />
        );

        fireEvent.click(getByRole('button', { name: 'taskEdit.checklist 1' }));

        expect(updates[updates.length - 1]).toEqual({
            checklist: [
                { id: '1', title: 'Item 1', isCompleted: true },
                { id: '2', title: 'Item 2', isCompleted: false },
                { id: '3', title: 'Item 3', isCompleted: false },
            ],
            description: 'Intro\n- [x] Item 1\n- [ ] Item 2\n- [ ] Item 3\nOutro',
        });
    });

    it('renders desktop drag handles only when checklist order can change', () => {
        const multiItem = render(<ChecklistHarness />);
        expect(multiItem.getAllByLabelText('Drag checklist item')).toHaveLength(3);

        multiItem.unmount();

        const singleItem = render(<ChecklistHarness initial={[initialChecklist[0]]} />);
        expect(singleItem.queryByLabelText('Drag checklist item')).not.toBeInTheDocument();
    });

    it('wraps selected checklist text with Markdown character pairs', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);

        const pairEvent = createEvent.keyDown(input, { key: '[', cancelable: true });
        fireEvent(input, pairEvent);

        expect(pairEvent.defaultPrevented).toBe(true);
        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('[Item 1]');
        });
    });

    it('keeps repeated checklist backticks on the selected text when the input selection briefly collapses', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);
        fireEvent.keyDown(input, { key: '`' });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('`Item 1`');
        });

        const onceInput = getAllByRole('textbox')[0] as HTMLInputElement;
        onceInput.setSelectionRange(onceInput.value.length, onceInput.value.length);
        fireEvent.keyDown(onceInput, { key: '`' });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('``Item 1``');
        });
    });

    it('applies Markdown bold and italic shortcuts inside checklist items', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);

        const boldEvent = createEvent.keyDown(input, { key: 'b', ctrlKey: true, cancelable: true });
        fireEvent(input, boldEvent);

        expect(boldEvent.defaultPrevented).toBe(true);
        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('**Item 1**');
        });

        const updatedInput = getAllByRole('textbox')[0] as HTMLInputElement;
        updatedInput.setSelectionRange(2, updatedInput.value.length - 2);
        fireEvent.select(updatedInput);

        const italicEvent = createEvent.keyDown(updatedInput, { key: 'i', metaKey: true, cancelable: true });
        fireEvent(updatedInput, italicEvent);

        expect(italicEvent.defaultPrevented).toBe(true);
        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('***Item 1***');
        });
    });

    it('keeps native selected-text replacements paired in checklist items', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const input = getAllByRole('textbox')[0] as HTMLInputElement;
        input.setSelectionRange(0, input.value.length);
        fireEvent.select(input);

        fireEvent.change(input, { target: { value: '`' } });

        await waitFor(() => {
            expect((getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('`Item 1`');
        });
    });

    it('keeps Tab and Shift+Tab navigation working after inserting with Enter', async () => {
        const { getAllByRole } = render(<ChecklistHarness />);

        const initialInputs = getAllByRole('textbox');
        fireEvent.focus(initialInputs[1]);
        fireEvent.keyDown(initialInputs[1], { key: 'Enter' });

        await waitFor(() => {
            expect(getAllByRole('textbox')).toHaveLength(4);
        }, { timeout: 500 });

        const afterInsert = getAllByRole('textbox');
        const tabEvent = createEvent.keyDown(afterInsert[2], { key: 'Tab', cancelable: true });
        fireEvent(afterInsert[2], tabEvent);
        expect(tabEvent.defaultPrevented).toBe(true);

        const shiftTabEvent = createEvent.keyDown(getAllByRole('textbox')[3], {
            key: 'Tab',
            shiftKey: true,
            cancelable: true,
        });
        fireEvent(getAllByRole('textbox')[3], shiftTabEvent);
        expect(shiftTabEvent.defaultPrevented).toBe(true);
    });

    it('focuses inserted checklist items without scrolling the editor container', async () => {
        const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus').mockImplementation(() => {});
        try {
            const { getByRole } = render(<ChecklistHarness />);

            fireEvent.click(getByRole('button', { name: /taskEdit.addItem/i }));

            await waitFor(() => {
                expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
            }, { timeout: 500 });
        } finally {
            focusSpy.mockRestore();
        }
    });

    it('keeps the add-item click from blurring the current editor control first', () => {
        const { getByRole } = render(<ChecklistHarness />);
        const addButton = getByRole('button', { name: /taskEdit.addItem/i });
        const mouseDown = createEvent.mouseDown(addButton, { cancelable: true });

        fireEvent(addButton, mouseDown);

        expect(mouseDown.defaultPrevented).toBe(true);
    });
});
