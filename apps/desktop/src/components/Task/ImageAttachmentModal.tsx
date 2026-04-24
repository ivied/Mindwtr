import type { Attachment } from '@mindwtr/core';
import { AttachmentImage } from './AttachmentImage';

type ImageAttachmentModalProps = {
    attachment: Attachment | null;
    imageSource: string | null;
    onClose: () => void;
    onOpenExternally: () => void;
    t: (key: string) => string;
};

export function ImageAttachmentModal({
    attachment,
    imageSource: _imageSource,
    onClose,
    onOpenExternally,
    t,
}: ImageAttachmentModalProps) {
    if (!attachment) return null;
    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            role="button"
            tabIndex={0}
            aria-label={t('common.close')}
            onClick={onClose}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                if (event.currentTarget !== event.target) return;
                event.preventDefault();
                onClose();
            }}
        >
            <div
                className="w-full max-w-3xl bg-popover text-popover-foreground rounded-xl border shadow-2xl p-4 space-y-3"
                role="dialog"
                aria-modal="true"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">{attachment.title || t('attachments.title')}</div>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={onOpenExternally}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {t('attachments.open')}
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {t('common.close')}
                        </button>
                    </div>
                </div>
                <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-muted/30">
                    <AttachmentImage
                        attachment={attachment}
                        alt={attachment.title || t('attachments.title')}
                        className="block max-w-full h-auto mx-auto"
                    />
                </div>
            </div>
        </div>
    );
}
