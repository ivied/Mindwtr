import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AreaColorPicker } from './AreaColorPicker';

describe('AreaColorPicker', () => {
    it('applies a preset color selection', () => {
        const onChange = vi.fn();
        const { getByLabelText } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={onChange}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));
        fireEvent.click(getByLabelText('Area color: #10b981'));

        expect(onChange).toHaveBeenCalledWith('#10b981');
    });

    it('raises the open menu above manage panels', () => {
        const onChange = vi.fn();
        const { getByLabelText, getByTestId } = render(
            <AreaColorPicker
                value="#3b82f6"
                onChange={onChange}
                title="Area color"
            />,
        );

        fireEvent.click(getByLabelText('Area color'));

        expect(getByTestId('area-color-picker-root').className).toContain('z-50');
        expect(getByTestId('area-color-picker-menu').className).toContain('z-50');
    });
});
