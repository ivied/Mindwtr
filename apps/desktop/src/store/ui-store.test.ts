import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('useUiStore list options', () => {
    beforeEach(() => {
        window.localStorage.clear();
        vi.resetModules();
    });

    it('hydrates persisted Focus/list view options', async () => {
        window.localStorage.setItem('mindwtr:list-options:v1', JSON.stringify({
            showDetails: true,
            nextGroupBy: 'project',
            focusTop3Only: true,
        }));

        const { useUiStore } = await import('./ui-store');

        expect(useUiStore.getState().listOptions).toEqual({
            showDetails: true,
            nextGroupBy: 'project',
            focusTop3Only: true,
        });
    });

    it('persists Focus/list view options on change', async () => {
        const { LIST_OPTIONS_STORAGE_KEY, useUiStore } = await import('./ui-store');

        useUiStore.getState().setListOptions({
            showDetails: true,
            nextGroupBy: 'project',
            focusTop3Only: true,
        });

        expect(JSON.parse(window.localStorage.getItem(LIST_OPTIONS_STORAGE_KEY) || '{}')).toEqual({
            showDetails: true,
            nextGroupBy: 'project',
            focusTop3Only: true,
        });
    });
});
