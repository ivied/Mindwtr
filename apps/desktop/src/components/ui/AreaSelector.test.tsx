import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Area } from '@mindwtr/core';

import { AreaSelector } from './AreaSelector';

const areas: Area[] = [
    { id: 'a1', name: 'Work', color: '#3b82f6', order: 0, createdAt: '', updatedAt: '' },
    { id: 'a2', name: 'Home', color: '#10b981', order: 1, createdAt: '', updatedAt: '' },
];

describe('AreaSelector', () => {
    it('renders the dropdown in a body portal so task rows cannot clip it', () => {
        const { getByRole } = render(
            <AreaSelector
                areas={areas}
                value=""
                onChange={vi.fn()}
                placeholder="Select area"
                searchPlaceholder="Search areas"
            />
        );

        fireEvent.click(getByRole('button', { name: 'Select area' }));

        const dropdown = getByRole('listbox', { name: 'Select area' }).closest('[data-selector-dropdown="true"]');
        expect(dropdown).toHaveClass('z-[70]');
        expect(dropdown?.parentElement).toBe(document.body);
        expect(dropdown).toHaveStyle({ position: 'fixed' });
    });
});
