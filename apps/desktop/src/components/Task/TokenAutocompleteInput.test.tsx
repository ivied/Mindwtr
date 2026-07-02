import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TokenAutocompleteInput } from './TokenAutocompleteInput';

describe('TokenAutocompleteInput', () => {
    it('does not accept a substring match on Enter until an option is selected', async () => {
        const onChange = vi.fn();
        const onKeyDown = vi.fn();
        const { findByRole, getByRole } = render(
            <TokenAutocompleteInput
                value="@home"
                onChange={onChange}
                onKeyDown={onKeyDown}
                suggestions={['@home-office']}
                prefix="@"
                ariaLabel="Contexts"
            />
        );
        const input = getByRole('combobox', { name: 'Contexts' }) as HTMLInputElement;
        input.setSelectionRange(5, 5);

        fireEvent.keyUp(input, { key: 'e' });
        await findByRole('option', { name: '@home-office' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).not.toHaveBeenCalled();
        expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }));

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'Enter' });

        expect(onChange).toHaveBeenCalledWith('@home-office, ');
    });
});
