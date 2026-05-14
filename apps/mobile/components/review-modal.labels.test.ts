import { describe, expect, it } from 'vitest';

import { getReviewLabels } from './review-modal.labels';

describe('review modal labels', () => {
    it('uses typed i18n keys instead of the old Chinese-only table', () => {
        const translations: Record<string, string> = {
            'nav.calendar': '日曆',
            'nav.inbox': '收件匣',
            'review.aiStep': 'AI 洞察',
            'review.waitingStep': '等待中',
        };

        const labels = getReviewLabels((key) => translations[key] ?? key);

        expect(labels.calendar).toBe('日曆');
        expect(labels.inbox).toBe('收件匣');
        expect(labels.ai).toBe('AI 洞察');
        expect(labels.waiting).toBe('等待中');
    });

    it('routes every modal label through a typed i18n key', () => {
        const keys: string[] = [];
        const labels = getReviewLabels((key) => {
            keys.push(key);
            return `translated:${key}`;
        });

        expect(Object.values(labels).every((label) => label.startsWith('translated:'))).toBe(true);
        expect(keys).toEqual(expect.arrayContaining([
            'review.inboxGuide',
            'review.calendarEmpty',
            'review.calendarTasks',
            'review.calendarTasksEmpty',
            'review.addTaskPlaceholder',
            'review.next',
            'review.activeTasks',
            'review.moreItems',
        ]));
    });

    it('falls back to English defaults when a typed translation is missing', () => {
        const labels = getReviewLabels((key) => key);

        expect(labels.calendarTasks).toBe('Mindwtr tasks (next 7 days)');
        expect(labels.moreItems).toBe('more items');
    });
});
