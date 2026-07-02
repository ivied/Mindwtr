import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { labelFallback } from './labels';
import { SettingsFeedbackModal } from './SettingsFeedbackModal';

const renderFeedbackModal = (props?: Partial<Parameters<typeof SettingsFeedbackModal>[0]>) => {
    const baseProps: Parameters<typeof SettingsFeedbackModal>[0] = {
        isConfigured: true,
        isOpen: true,
        onClose: vi.fn(),
        onOpenIssue: vi.fn(),
        onSubmit: vi.fn().mockResolvedValue(undefined),
        t: labelFallback.en,
    };
    return render(<SettingsFeedbackModal {...baseProps} {...props} />);
};

describe('SettingsFeedbackModal', () => {
    it('uses category-specific message placeholders', () => {
        renderFeedbackModal();

        expect(screen.getByPlaceholderText(labelFallback.en.feedbackMessagePlaceholderBug)).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: labelFallback.en.feedbackWhere })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: labelFallback.en.feedbackCategoryFeature }));

        expect(screen.getByPlaceholderText(labelFallback.en.feedbackMessagePlaceholderFeature)).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: labelFallback.en.feedbackWhere })).not.toBeInTheDocument();
    });

    it('includes the selected bug location in the submitted message', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        renderFeedbackModal({ onSubmit });

        fireEvent.change(screen.getByRole('combobox', { name: labelFallback.en.feedbackWhere }), {
            target: { value: 'sync' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: labelFallback.en.feedbackMessage }), {
            target: { value: 'CloudKit sync failed' },
        });
        fireEvent.click(screen.getByRole('button', { name: labelFallback.en.feedbackSubmit }));

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
                category: 'bug',
                message: 'Where: Sync\n\nCloudKit sync failed',
            }));
        });
    });

    it('routes unconfigured builds to GitHub issues', () => {
        const onOpenIssue = vi.fn();
        renderFeedbackModal({ isConfigured: false, onOpenIssue });

        expect(screen.getByText(labelFallback.en.feedbackUnavailableDesc)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: labelFallback.en.feedbackSubmit })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: labelFallback.en.feedbackOpenGitHubIssue }));

        expect(onOpenIssue).toHaveBeenCalled();
    });
});
