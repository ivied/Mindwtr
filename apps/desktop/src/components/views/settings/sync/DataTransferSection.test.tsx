import { fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataTransferSection } from './DataTransferSection';

const baseProps = {
    t: {
        dataTransfer: 'Data Transfer',
        dataTransferDesc: 'Import and export data.',
        exportBackup: 'Export Backup',
        exportBackupDesc: 'Save backup.',
        restoreBackup: 'Restore Backup',
        restoreBackupDesc: 'Restore backup.',
        importTodoist: 'Import from Todoist',
        importTodoistDesc: 'Import Todoist exports.',
        importTickTick: 'Import from TickTick',
        importTickTickDesc: 'Import TickTick exports.',
        importDgt: 'Import from DGT GTD',
        importDgtDesc: 'Import DGT GTD exports.',
        importOmniFocus: 'Import from OmniFocus',
        importOmniFocusDesc: 'Import OmniFocus exports.',
        syncing: 'Working...',
    },
    transferAction: null,
    onExportBackup: vi.fn(),
    onRestoreBackup: vi.fn(),
    onImportTodoist: vi.fn(),
    onImportTickTick: vi.fn(),
    onImportDgt: vi.fn(),
    onImportOmniFocus: vi.fn(),
    onAddGettingStartedContent: vi.fn(),
} as unknown as ComponentProps<typeof DataTransferSection>;

describe('DataTransferSection', () => {
    it('links to the import guide in the docs site', () => {
        const { getByRole } = render(<DataTransferSection {...baseProps} />);

        expect(getByRole('link', { name: /Import guide/ })).toHaveAttribute(
            'href',
            'https://docs.mindwtr.app/import/'
        );
    });

    it('calls the TickTick import action', () => {
        const onImportTickTick = vi.fn();
        const { getByRole } = render(
            <DataTransferSection
                {...baseProps}
                onImportTickTick={onImportTickTick}
            />
        );

        fireEvent.click(getByRole('button', { name: /import from ticktick/i }));

        expect(onImportTickTick).toHaveBeenCalledTimes(1);
    });

    it('exposes a recovery action for Getting Started content', () => {
        const onAddGettingStartedContent = vi.fn();
        const { getByRole } = render(
            <DataTransferSection
                {...baseProps}
                onAddGettingStartedContent={onAddGettingStartedContent}
            />
        );

        fireEvent.click(getByRole('button', { name: /add getting started content/i }));

        expect(onAddGettingStartedContent).toHaveBeenCalledTimes(1);
    });
});
