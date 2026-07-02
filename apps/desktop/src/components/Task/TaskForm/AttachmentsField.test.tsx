import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentsField } from './AttachmentsField';

describe('AttachmentsField', () => {
    it('renders image attachments as inline previews and opens them on click', () => {
        const openAttachment = vi.fn();
        const attachment = {
            id: 'attachment-1',
            kind: 'file' as const,
            title: 'github-share.png',
            uri: 'file:///tmp/github-share.png',
            mimeType: 'image/png',
            createdAt: '2026-04-17T00:00:00.000Z',
            updatedAt: '2026-04-17T00:00:00.000Z',
        };

        const { getByRole } = render(
            <AttachmentsField
                t={(key) => key}
                attachmentError={null}
                visibleEditAttachments={[attachment]}
                addFileAttachment={vi.fn()}
                addLinkAttachment={vi.fn()}
                addObsidianNoteAttachment={vi.fn()}
                showObsidianNoteAttachment={false}
                editLinkAttachment={vi.fn()}
                openAttachment={openAttachment}
                removeAttachment={vi.fn()}
            />
        );

        expect(getByRole('img', { name: 'github-share.png' })).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'attachments.open: github-share.png' }));

        expect(openAttachment).toHaveBeenCalledWith(attachment);
    });

    it('shows an edit action for link attachments', () => {
        const editLinkAttachment = vi.fn();
        const attachment = {
            id: 'attachment-1',
            kind: 'link' as const,
            title: 'Project brief',
            uri: 'https://example.com/brief',
            createdAt: '2026-04-17T00:00:00.000Z',
            updatedAt: '2026-04-17T00:00:00.000Z',
        };

        const { getByRole } = render(
            <AttachmentsField
                t={(key) => key}
                attachmentError={null}
                visibleEditAttachments={[attachment]}
                addFileAttachment={vi.fn()}
                addLinkAttachment={vi.fn()}
                addObsidianNoteAttachment={vi.fn()}
                showObsidianNoteAttachment={false}
                editLinkAttachment={editLinkAttachment}
                openAttachment={vi.fn()}
                removeAttachment={vi.fn()}
            />
        );

        fireEvent.click(getByRole('button', { name: 'common.edit' }));

        expect(editLinkAttachment).toHaveBeenCalledWith(attachment);
    });

    it('surfaces an Obsidian note attachment action', () => {
        const addObsidianNoteAttachment = vi.fn();

        const { getByRole } = render(
            <AttachmentsField
                t={(key) => key}
                attachmentError={null}
                visibleEditAttachments={[]}
                addFileAttachment={vi.fn()}
                addLinkAttachment={vi.fn()}
                addObsidianNoteAttachment={addObsidianNoteAttachment}
                showObsidianNoteAttachment
                editLinkAttachment={vi.fn()}
                openAttachment={vi.fn()}
                removeAttachment={vi.fn()}
            />
        );

        fireEvent.click(getByRole('button', { name: 'attachments.attachObsidianNote' }));

        expect(addObsidianNoteAttachment).toHaveBeenCalledTimes(1);
    });

    it('hides the Obsidian note attachment action when the integration is disabled', () => {
        const { queryByRole } = render(
            <AttachmentsField
                t={(key) => key}
                attachmentError={null}
                visibleEditAttachments={[]}
                addFileAttachment={vi.fn()}
                addLinkAttachment={vi.fn()}
                addObsidianNoteAttachment={vi.fn()}
                showObsidianNoteAttachment={false}
                editLinkAttachment={vi.fn()}
                openAttachment={vi.fn()}
                removeAttachment={vi.fn()}
            />
        );

        expect(queryByRole('button', { name: 'attachments.attachObsidianNote' })).not.toBeInTheDocument();
    });

});
