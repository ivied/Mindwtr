import { describe, expect, it } from 'vitest';

import { mergeMarkdownChecklist } from './task-item-checklist';

describe('mergeMarkdownChecklist', () => {
    it('uses markdown task lists as the checklist source while preserving matching ids', () => {
        const existing = [
            { id: 'a', title: 'Buy milk', isCompleted: true },
            { id: 'b', title: 'Legacy item', isCompleted: false },
        ];

        const merged = mergeMarkdownChecklist([
            { title: 'Buy milk', isCompleted: false },
            { title: 'Call mom', isCompleted: true },
        ], existing);

        expect(merged).toHaveLength(2);
        expect(merged?.[0]).toMatchObject({ id: 'a', title: 'Buy milk', isCompleted: false });
        expect(merged?.[1]).toMatchObject({ title: 'Call mom', isCompleted: true });
        expect(merged?.some((item) => item.title === 'Legacy item')).toBe(false);
    });
});
