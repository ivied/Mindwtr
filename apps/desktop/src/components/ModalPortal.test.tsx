import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { ModalPortal } from './ModalPortal';

describe('ModalPortal', () => {
    it('renders children outside transformed ancestors', () => {
        const { container, getByRole } = render(
            <div style={{ transform: 'translateY(50px)' }}>
                <ModalPortal>
                    <div role="dialog" aria-modal="true">
                        Portaled dialog
                    </div>
                </ModalPortal>
            </div>,
        );

        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(getByRole('dialog')).toBeInTheDocument();
    });
});
