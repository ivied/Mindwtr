export type PromptTestKind = 'announcement' | 'donation' | 'update' | 'review';

const PROMPT_TEST_EVENT = 'mindwtr:prompt-test';
const IS_TEST_RUNTIME = (
    import.meta.env.MODE === 'test'
    || import.meta.env.VITEST
    || process.env.NODE_ENV === 'test'
);

export const PROMPT_TEST_CONTROLS_ENABLED = (
    !IS_TEST_RUNTIME
    && (
        import.meta.env.DEV
        || import.meta.env.VITE_PROMPT_TEST_CONTROLS_ENABLED === '1'
        || import.meta.env.VITE_PROMPT_TEST_CONTROLS_ENABLED === 'true'
    )
);

export function dispatchPromptTest(kind: PromptTestKind): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(PROMPT_TEST_EVENT, { detail: { kind } }));
}

export function subscribePromptTest(handler: (kind: PromptTestKind) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = (event: Event) => {
        const kind = (event as CustomEvent<{ kind?: PromptTestKind }>).detail?.kind;
        if (
            kind === 'announcement'
            || kind === 'donation'
            || kind === 'update'
            || kind === 'review'
        ) {
            handler(kind);
        }
    };
    window.addEventListener(PROMPT_TEST_EVENT, listener);
    return () => window.removeEventListener(PROMPT_TEST_EVENT, listener);
}
