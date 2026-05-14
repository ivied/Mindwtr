import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { labelFallback } from './labels';
import { SettingsGtdPage } from './SettingsGtdPage';

describe('SettingsGtdPage', () => {
    it('saves the task editor presentation setting', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={labelFallback.en}
                language="en"
                settings={{ gtd: { taskEditor: { presentation: 'inline' } } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
            />
        );

        fireEvent.click(getByRole('button', { name: /task editor layout/i }));
        fireEvent.click(getByRole('button', { name: /pop-up/i }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    taskEditor: {
                        presentation: 'modal',
                    },
                },
            });
        });
    });
});
