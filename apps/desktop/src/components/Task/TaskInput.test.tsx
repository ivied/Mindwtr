import { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TaskInput } from './TaskInput';

function TaskInputHarness({
    initialValue = '',
    contexts = [],
}: {
    initialValue?: string;
    contexts?: string[];
}) {
    const [value, setValue] = useState(initialValue);

    return (
        <TaskInput
            value={value}
            onChange={setValue}
            projects={[]}
            contexts={contexts}
        />
    );
}

describe('TaskInput autocomplete', () => {
    it('suggests custom contexts for @ trigger', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <TaskInput
                value="@per"
                onChange={onChange}
                projects={[]}
                contexts={['@home', '@work', '@personal']}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        expect(getByRole('option', { name: '@personal' })).toBeInTheDocument();
    });

    it('suggests tags for # trigger and inserts selected tag', () => {
        const onChange = vi.fn();
        const { getByRole } = render(
            <TaskInput
                value="#urg"
                onChange={onChange}
                projects={[]}
                contexts={['#urgent', '#ops', '@work']}
            />
        );
        const input = getByRole('combobox') as HTMLInputElement;
        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.click(input);

        fireEvent.click(getByRole('option', { name: '#urgent' }));

        expect(onChange).toHaveBeenCalledWith('#urgent');
    });

    it('undoes task title edits with Ctrl+Z', async () => {
        const { getByRole } = render(<TaskInputHarness initialValue="Draft task" />);
        const input = getByRole('combobox') as HTMLInputElement;

        input.setSelectionRange(input.value.length, input.value.length);
        fireEvent.change(input, { target: { value: 'Draft task updated' } });

        expect(input.value).toBe('Draft task updated');

        fireEvent.keyDown(input, { key: 'z', ctrlKey: true });

        await waitFor(() => {
            expect(input.value).toBe('Draft task');
        });
    });
});
