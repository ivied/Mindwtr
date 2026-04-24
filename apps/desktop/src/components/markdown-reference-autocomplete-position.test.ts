import { describe, expect, it } from 'vitest';

import { resolveAutocompletePopoverPosition } from './markdown-reference-autocomplete-position';

describe('resolveAutocompletePopoverPosition', () => {
    it('keeps the popover below the caret when there is space', () => {
        const position = resolveAutocompletePopoverPosition({
            anchorRect: { top: 120, bottom: 144, left: 180 },
            estimatedHeight: 220,
            viewportHeight: 900,
            viewportWidth: 1200,
        });

        expect(position.placement).toBe('bottom');
        expect(position.top).toBe(152);
        expect(position.left).toBe(180);
    });

    it('flips the popover above the caret near the bottom of the viewport', () => {
        const position = resolveAutocompletePopoverPosition({
            anchorRect: { top: 700, bottom: 724, left: 280 },
            estimatedHeight: 260,
            viewportHeight: 800,
            viewportWidth: 1200,
        });

        expect(position.placement).toBe('top');
        expect(position.top).toBe(432);
        expect(position.maxHeight).toBe(336);
    });

    it('clamps the popover horizontally inside the viewport', () => {
        const position = resolveAutocompletePopoverPosition({
            anchorRect: { top: 120, bottom: 144, left: 980 },
            estimatedHeight: 220,
            viewportHeight: 900,
            viewportWidth: 1200,
        });

        expect(position.left).toBe(868);
        expect(position.width).toBe(320);
    });
});
