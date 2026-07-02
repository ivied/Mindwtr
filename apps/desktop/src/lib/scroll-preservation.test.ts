import { describe, expect, it } from 'vitest';

import { keepTextareaSelectionVisible } from './scroll-preservation';

describe('keepTextareaSelectionVisible', () => {
    it('scrolls to the textarea bottom when the caret is at the document end', () => {
        const textarea = document.createElement('textarea');
        textarea.value = '- first\n- second\n- ';
        Object.defineProperty(textarea, 'clientHeight', { configurable: true, value: 48 });
        Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 144 });
        textarea.scrollTop = 0;
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);

        keepTextareaSelectionVisible(textarea);

        expect(textarea.scrollTop).toBe(96);
    });
});
