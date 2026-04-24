const TEXTAREA_MIRROR_STYLE_PROPERTIES = [
    'borderBottomWidth',
    'borderLeftWidth',
    'borderRightWidth',
    'borderTopWidth',
    'boxSizing',
    'fontFamily',
    'fontFeatureSettings',
    'fontKerning',
    'fontSize',
    'fontStretch',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'letterSpacing',
    'lineHeight',
    'paddingBottom',
    'paddingLeft',
    'paddingRight',
    'paddingTop',
    'tabSize',
    'textAlign',
    'textIndent',
    'textTransform',
    'whiteSpace',
    'wordBreak',
    'wordSpacing',
] as const;

const VIEWPORT_PADDING = 12;
const POPOVER_GAP = 8;
const DEFAULT_POPOVER_WIDTH = 320;
const MAX_POPOVER_HEIGHT = 336;
const MIN_POPOVER_HEIGHT = 96;

export type AutocompletePopoverPosition = {
    left: number;
    maxHeight: number;
    placement: 'top' | 'bottom';
    top: number;
    width: number;
};

type RectLike = {
    bottom: number;
    left: number;
    top: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const parsePixelValue = (value: string, fallback: number) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export function getTextareaCaretViewportRect(
    textarea: HTMLTextAreaElement,
    caret: number,
): RectLike | null {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
        return null;
    }

    const computed = window.getComputedStyle(textarea);
    const mirror = document.createElement('div');
    const marker = document.createElement('span');

    mirror.setAttribute('aria-hidden', 'true');
    mirror.style.position = 'fixed';
    mirror.style.left = '-9999px';
    mirror.style.top = '0';
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.wordBreak = 'break-word';
    mirror.style.overflow = 'hidden';
    mirror.style.width = computed.width;
    mirror.style.height = computed.height;

    TEXTAREA_MIRROR_STYLE_PROPERTIES.forEach((property) => {
        mirror.style[property] = computed[property];
    });

    mirror.textContent = textarea.value.slice(0, caret);
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;

    const textareaRect = textarea.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const lineHeight = parsePixelValue(computed.lineHeight, parsePixelValue(computed.fontSize, 16) * 1.4);

    document.body.removeChild(mirror);

    const top = textareaRect.top + (markerRect.top - mirrorRect.top);
    const left = textareaRect.left + (markerRect.left - mirrorRect.left);

    return {
        top,
        left,
        bottom: top + Math.max(lineHeight, markerRect.height || 0),
    };
}

export function resolveAutocompletePopoverPosition({
    anchorRect,
    estimatedHeight,
    viewportHeight,
    viewportWidth,
}: {
    anchorRect: RectLike;
    estimatedHeight: number;
    viewportHeight: number;
    viewportWidth: number;
}): AutocompletePopoverPosition {
    const width = Math.min(DEFAULT_POPOVER_WIDTH, Math.max(160, viewportWidth - VIEWPORT_PADDING * 2));
    const desiredHeight = Math.min(MAX_POPOVER_HEIGHT, Math.max(MIN_POPOVER_HEIGHT, estimatedHeight));
    const availableBelow = Math.max(0, viewportHeight - anchorRect.bottom - POPOVER_GAP - VIEWPORT_PADDING);
    const availableAbove = Math.max(0, anchorRect.top - POPOVER_GAP - VIEWPORT_PADDING);
    const placement = availableBelow < Math.min(desiredHeight, 180) && availableAbove > availableBelow
        ? 'top'
        : 'bottom';
    const availableSpace = placement === 'top' ? availableAbove : availableBelow;
    const maxHeight = Math.max(
        Math.min(MIN_POPOVER_HEIGHT, Math.max(availableAbove, availableBelow)),
        Math.min(MAX_POPOVER_HEIGHT, availableSpace),
    );
    const height = Math.min(desiredHeight, maxHeight);
    const left = clamp(anchorRect.left, VIEWPORT_PADDING, viewportWidth - width - VIEWPORT_PADDING);
    const top = placement === 'top'
        ? Math.max(VIEWPORT_PADDING, anchorRect.top - POPOVER_GAP - height)
        : Math.min(viewportHeight - VIEWPORT_PADDING - height, anchorRect.bottom + POPOVER_GAP);

    return {
        left,
        top,
        width,
        maxHeight,
        placement,
    };
}
