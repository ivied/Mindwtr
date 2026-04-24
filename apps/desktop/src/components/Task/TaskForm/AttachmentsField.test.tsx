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
                openAttachment={openAttachment}
                removeAttachment={vi.fn()}
            />
        );

        expect(getByRole('img', { name: 'github-share.png' })).toBeInTheDocument();

        fireEvent.click(getByRole('button', { name: 'attachments.open: github-share.png' }));

        expect(openAttachment).toHaveBeenCalledWith(attachment);
    });
});
