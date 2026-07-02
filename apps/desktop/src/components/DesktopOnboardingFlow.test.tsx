import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesktopOnboardingFlow } from './DesktopOnboardingFlow';

describe('DesktopOnboardingFlow', () => {
    const baseProps = () => ({
        isOpen: true,
        onOpenSync: vi.fn(),
        onOpenImport: vi.fn(),
        onStartFresh: vi.fn(),
        onSkip: vi.fn(),
    });

    it('renders the three first-run choices', () => {
        const props = baseProps();
        const { getByRole } = render(<DesktopOnboardingFlow {...props} />);

        expect(getByRole('heading', { name: 'Welcome to Mindwtr' })).toBeInTheDocument();
        expect(getByRole('button', { name: /set up sync/i })).toBeInTheDocument();
        expect(getByRole('button', { name: /import tasks/i })).toBeInTheDocument();
        expect(getByRole('button', { name: /start fresh/i })).toBeInTheDocument();
    });

    it('routes each choice to its callback', () => {
        const props = baseProps();
        const { getByRole } = render(<DesktopOnboardingFlow {...props} />);

        fireEvent.click(getByRole('button', { name: /set up sync/i }));
        fireEvent.click(getByRole('button', { name: /import tasks/i }));
        fireEvent.click(getByRole('button', { name: /start fresh/i }));
        fireEvent.click(getByRole('button', { name: /skip for now/i }));

        expect(props.onOpenSync).toHaveBeenCalledTimes(1);
        expect(props.onOpenImport).toHaveBeenCalledTimes(1);
        expect(props.onStartFresh).toHaveBeenCalledTimes(1);
        expect(props.onSkip).toHaveBeenCalledTimes(1);
    });

    it('does not render when closed', () => {
        const props = baseProps();
        const { queryByRole } = render(<DesktopOnboardingFlow {...props} isOpen={false} />);

        expect(queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows progress and inline errors for start fresh', () => {
        const props = baseProps();
        const { getByRole, getByText } = render(
            <DesktopOnboardingFlow
                {...props}
                busy
                error="Failed to create Getting Started onboarding."
            />
        );

        expect(getByRole('button', { name: /starting/i })).toBeDisabled();
        expect(getByText('Failed to create Getting Started onboarding.')).toBeInTheDocument();
    });
});
