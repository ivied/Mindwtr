import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Section } from '@mindwtr/core';

import { SectionSelector } from './SectionSelector';

const sections: Section[] = [
    { id: 's1', projectId: 'p1', title: 'Planning', order: 0, createdAt: '', updatedAt: '' },
    { id: 's2', projectId: 'p1', title: 'Launch', order: 1, createdAt: '', updatedAt: '' },
];

function setInputValue(input: HTMLInputElement, value: string) {
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(input));
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
        if (nativeSetter) {
            nativeSetter.call(input, value);
        } else {
            (input as any).value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('SectionSelector', () => {
    it('selects the first matching section from the search input with Enter', () => {
        const onChange = vi.fn();
        const { getByRole, getByLabelText } = render(
            <SectionSelector
                sections={sections}
                value=""
                onChange={onChange}
                onCreateSection={vi.fn()}
                placeholder="Select section"
                searchPlaceholder="Search sections"
                createSectionLabel="Create section"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select section' }));
        const input = getByLabelText('Search sections') as HTMLInputElement;
        setInputValue(input, 'Launch');
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).toHaveBeenCalledWith('s2');
    });

    it('moves from typed search to the first matching section with ArrowDown', () => {
        const { getByRole, getByLabelText } = render(
            <SectionSelector
                sections={sections}
                value=""
                onChange={vi.fn()}
                onCreateSection={vi.fn()}
                placeholder="Select section"
                searchPlaceholder="Search sections"
                createSectionLabel="Create section"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select section' }));
        const input = getByLabelText('Search sections') as HTMLInputElement;
        setInputValue(input, 'Launch');
        fireEvent.keyDown(input, { key: 'ArrowDown' });

        expect(getByRole('option', { name: 'Launch' })).toHaveFocus();
    });
});
