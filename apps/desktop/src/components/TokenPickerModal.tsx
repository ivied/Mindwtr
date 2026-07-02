import { useEffect, useId, useMemo, useState } from 'react';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { ModalPortal } from './ModalPortal';

interface TokenPickerModalProps {
    isOpen: boolean;
    title: string;
    description?: string;
    tokens: string[];
    placeholder?: string;
    allowCustomValue?: boolean;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
}

export function TokenPickerModal({
    isOpen,
    title,
    description,
    tokens,
    placeholder,
    allowCustomValue = false,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: TokenPickerModalProps) {
    const { t } = useLanguage();
    const [query, setQuery] = useState('');
    const [selectedToken, setSelectedToken] = useState<string | null>(null);
    const titleId = useId();
    const descriptionId = useId();

    useEffect(() => {
        if (!isOpen) return;
        setQuery('');
        setSelectedToken(null);
    }, [isOpen]);

    const filteredTokens = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return tokens;
        return tokens.filter((token) => token.toLowerCase().includes(normalizedQuery));
    }, [query, tokens]);

    const confirmValue = allowCustomValue
        ? (selectedToken ?? query.trim())
        : selectedToken;
    const canConfirm = Boolean(confirmValue && confirmValue.trim().length > 0);

    if (!isOpen) return null;

    return (
        <ModalPortal>
        <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[16vh]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            onClick={onCancel}
        >
            <div
                className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="border-b px-4 py-3">
                    <h3 id={titleId} className="font-semibold">{title}</h3>
                    {description && (
                        <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                <div className="flex flex-1 flex-col gap-3 p-4">
                    <input
                        autoFocus
                        type="text"
                        value={query}
                        onChange={(event) => {
                            const value = event.target.value;
                            setQuery(value);
                            if (!allowCustomValue) {
                                const exactMatch = tokens.find((token) => token.toLowerCase() === value.trim().toLowerCase());
                                setSelectedToken(exactMatch ?? null);
                            } else if (selectedToken && selectedToken !== value) {
                                setSelectedToken(null);
                            }
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.preventDefault();
                                onCancel();
                            }
                            if (event.key === 'Enter' && canConfirm && confirmValue) {
                                event.preventDefault();
                                onConfirm(confirmValue);
                            }
                        }}
                        placeholder={placeholder}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 shadow-sm transition-all focus:border-transparent focus:ring-2 focus:ring-primary"
                    />
                    <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto rounded-lg border border-border/80 bg-card/60 p-3">
                        {filteredTokens.length > 0 ? filteredTokens.map((token) => {
                            const isActive = token === selectedToken;
                            return (
                                <button
                                    key={token}
                                    type="button"
                                    onClick={() => {
                                        setSelectedToken(token);
                                        setQuery(token);
                                    }}
                                    className={cn(
                                        'rounded-full border px-3 py-1.5 text-xs transition-colors',
                                        isActive
                                            ? 'border-primary bg-primary/10 text-primary'
                                            : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                                    )}
                                >
                                    {token}
                                </button>
                            );
                        }) : (
                            <div className="w-full py-6 text-center text-sm text-muted-foreground">
                                {t('common.noMatches')}
                            </div>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onCancel}
                            className="rounded-md bg-muted px-3 py-1.5 text-sm hover:bg-muted/80"
                        >
                            {cancelLabel}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                if (confirmValue) {
                                    onConfirm(confirmValue);
                                }
                            }}
                            disabled={!canConfirm}
                            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {confirmLabel}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
