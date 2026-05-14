import { describe, expect, it } from 'vitest';
import { formatI18nTemplate, getEnglishI18nValue, getI18nKeyForEnglishText } from './index';

describe('formatI18nTemplate', () => {
    it('replaces repeated named placeholders wherever translators place them', () => {
        expect(formatI18nTemplate('{{name}} löschen? {{ name }}', { name: 'Inbox' })).toBe('Inbox löschen? Inbox');
    });

    it('leaves unknown placeholders intact', () => {
        expect(formatI18nTemplate('Delete {{name}} from {{list}}?', { name: 'Inbox' })).toBe('Delete Inbox from {{list}}?');
    });
});

describe('getI18nKeyForEnglishText', () => {
    it('maps existing English locale text back to its typed key', () => {
        expect(getI18nKeyForEnglishText('Pomodoro timer')).toBe('settings.featurePomodoro');
        expect(getI18nKeyForEnglishText('Focus minutes')).toBe('settings.pomodoroFocusMinutes');
    });

    it('returns undefined for dynamic text that is not in the locale table', () => {
        expect(getI18nKeyForEnglishText('Backup date: 2026-01-01')).toBeUndefined();
    });
});

describe('getEnglishI18nValue', () => {
    it('returns English copy for a locale key', () => {
        expect(getEnglishI18nValue('settings.featurePomodoro')).toBe('Pomodoro timer');
        expect(getEnglishI18nValue('settings.missing')).toBeUndefined();
    });
});
