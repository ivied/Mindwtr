import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { labelFallback } from './labels';
import { SettingsGtdPage } from './SettingsGtdPage';

describe('SettingsGtdPage', () => {
    it('saves the task editor presentation setting', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole, queryByText } = render(
            <SettingsGtdPage
                t={labelFallback.en}
                language="en"
                settings={{ gtd: { taskEditor: { presentation: 'inline' } } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        expect(queryByText('Temporary onboarding test')).not.toBeInTheDocument();
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

    it('saves the default project flow mode', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={labelFallback.en}
                language="en"
                settings={{ gtd: { defaultProjectFlowMode: 'parallel' } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /sequential/i }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    defaultProjectFlowMode: 'sequential',
                },
            });
        });
    });

    it('saves the default area for new tasks', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={labelFallback.en}
                language="en"
                settings={{ gtd: { defaultAreaId: null } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[{
                    id: 'area-work',
                    name: 'Work',
                    color: '#64748b',
                    order: 0,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }]}
            />
        );

        fireEvent.click(getByRole('button', { name: /default capture method/i }));
        fireEvent.change(getByRole('combobox', { name: /default area for new tasks/i }), {
            target: { value: 'area-work' },
        });

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    defaultAreaMode: 'fixed',
                    defaultAreaId: 'area-work',
                },
            });
        });
    });

    it('saves the active area mode for new tasks', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={labelFallback.en}
                language="en"
                settings={{ gtd: { defaultAreaId: null } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /default capture method/i }));
        fireEvent.change(getByRole('combobox', { name: /default area for new tasks/i }), {
            target: { value: '__active-area__' },
        });

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    defaultAreaMode: 'active',
                    defaultAreaId: null,
                },
            });
        });
    });
});
