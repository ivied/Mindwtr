/**
 * AssignedToPicker — combobox for the "Assigned to" task field.
 *
 * Plain text input with a dropdown sourced from the capture-wiki persons
 * registry (GET /v1/persons in ai-service). Behaves like a normal input —
 * the user can type any string; the dropdown is a convenience, not a
 * constraint. Falls back to a bare input when the AI service is not
 * configured (VITE_AI_SERVICE_URL/TOKEN unset).
 *
 * UX:
 *   - Focus / type → fetch matching persons, render up to 8 suggestions.
 *   - Click a suggestion or press Enter on a highlighted one → set value.
 *   - "Use as new person: '<typed>'" entry shown when the typed value
 *     doesn't exactly match an existing person — keeps free-text intent.
 *   - Esc closes the dropdown. Blur closes after a short delay so click
 *     handlers fire first.
 *   - Arrow keys navigate the list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    isProposalsAvailable,
    listPersons,
    type KnownPerson,
} from '../lib/proposals-client';

interface Props {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    /** Forwarded to the underlying input for parity with the previous plain-input
     *  usage in InboxProcessingWizard etc. */
    id?: string;
    ariaLabel?: string;
    className?: string;
    /** When true, the picker takes full width of its container. */
    fullWidth?: boolean;
    disabled?: boolean;
}

const MAX_SUGGESTIONS = 8;
const DEBOUNCE_MS = 120;

export function AssignedToPicker({
    value,
    onChange,
    placeholder,
    id,
    ariaLabel,
    className,
    fullWidth = true,
    disabled,
}: Props) {
    // Graceful fallback: when AI service isn't configured, behave as a plain
    // input so users without the proposals stack get the previous UX.
    const aiAvailable = isProposalsAvailable();

    const [open, setOpen] = useState(false);
    const [suggestions, setSuggestions] = useState<KnownPerson[]>([]);
    const [highlight, setHighlight] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const blurTimer = useRef<number | null>(null);

    // Fetch suggestions when query changes (debounced).
    useEffect(() => {
        if (!aiAvailable || !open) return;
        let cancelled = false;
        const t = window.setTimeout(async () => {
            try {
                const items = await listPersons(value, MAX_SUGGESTIONS);
                if (!cancelled) {
                    setSuggestions(items);
                    setHighlight(0);
                }
            } catch {
                if (!cancelled) setSuggestions([]);
            }
        }, DEBOUNCE_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(t);
        };
    }, [value, open, aiAvailable]);

    const exactMatch = suggestions.some(
        (p) =>
            p.name.toLowerCase() === value.trim().toLowerCase() ||
            p.aliases.some((a) => a.toLowerCase() === value.trim().toLowerCase())
    );
    const showCreateRow = open && value.trim().length > 0 && !exactMatch;

    // Items shown: suggestions + optional "use as new" row at index = suggestions.length.
    const itemCount = suggestions.length + (showCreateRow ? 1 : 0);

    const pick = useCallback(
        (person: KnownPerson) => {
            onChange(person.name);
            setOpen(false);
            // Defer blur so the input keeps focus visually but the list closes.
            inputRef.current?.blur();
        },
        [onChange]
    );

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            if (!open || itemCount === 0) {
                if (e.key === 'ArrowDown' && suggestions.length === 0) setOpen(true);
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlight((h) => Math.min(itemCount - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === 'Enter') {
                if (highlight < suggestions.length) {
                    e.preventDefault();
                    pick(suggestions[highlight]!);
                } else if (showCreateRow) {
                    // Accept the typed value as-is.
                    e.preventDefault();
                    setOpen(false);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
            }
        },
        [open, itemCount, highlight, suggestions, showCreateRow, pick]
    );

    const onFocus = useCallback(() => {
        if (!aiAvailable) return;
        if (blurTimer.current !== null) {
            window.clearTimeout(blurTimer.current);
            blurTimer.current = null;
        }
        setOpen(true);
    }, [aiAvailable]);

    const onBlur = useCallback(() => {
        // Delay so option click handlers fire first.
        blurTimer.current = window.setTimeout(() => setOpen(false), 150);
    }, []);

    return (
        <div className={`relative ${fullWidth ? 'w-full' : ''} ${className ?? ''}`}>
            <input
                ref={inputRef}
                id={id}
                type="text"
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel}
                disabled={disabled}
                autoComplete="off"
                onChange={(e) => {
                    onChange(e.target.value);
                    if (aiAvailable && !open) setOpen(true);
                }}
                onFocus={onFocus}
                onBlur={onBlur}
                onKeyDown={onKeyDown}
                className="w-full rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {open && (suggestions.length > 0 || showCreateRow) ? (
                <div className="absolute left-0 right-0 z-20 mt-0.5 max-h-64 overflow-auto rounded border border-border bg-popover shadow-md">
                    {suggestions.map((p, idx) => {
                        const isHighlighted = idx === highlight;
                        return (
                            <button
                                key={p.slug}
                                type="button"
                                tabIndex={-1}
                                onMouseDown={(e) => {
                                    // onMouseDown fires before onBlur — keeps the click from being
                                    // swallowed by the blur-close timer.
                                    e.preventDefault();
                                    pick(p);
                                }}
                                onMouseEnter={() => setHighlight(idx)}
                                className={`flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left text-sm ${
                                    isHighlighted ? 'bg-accent text-accent-foreground' : ''
                                }`}
                            >
                                <span className="flex-1 truncate">
                                    <span className="font-medium">{p.name}</span>
                                    {p.aliases.length > 0 ? (
                                        <span className="ml-1 text-xs text-muted-foreground">
                                            {p.aliases
                                                .filter((a) => a.toLowerCase() !== p.name.toLowerCase())
                                                .slice(0, 2)
                                                .join(', ')}
                                        </span>
                                    ) : null}
                                </span>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {p.mentionCount}×
                                </span>
                            </button>
                        );
                    })}
                    {showCreateRow ? (
                        <button
                            type="button"
                            tabIndex={-1}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                setOpen(false);
                                inputRef.current?.blur();
                            }}
                            onMouseEnter={() => setHighlight(suggestions.length)}
                            className={`flex w-full items-center gap-1 border-t border-border/50 px-2 py-1 text-left text-xs italic text-muted-foreground ${
                                highlight === suggestions.length ? 'bg-accent text-accent-foreground' : ''
                            }`}
                        >
                            <span>Use as new person:</span>
                            <span className="font-medium not-italic">"{value.trim()}"</span>
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
