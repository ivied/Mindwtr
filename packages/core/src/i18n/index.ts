export type { Language } from './i18n-types';
export { translateText } from './i18n-translate';
import { en } from './locales/en';

export type TranslateFn = (key: string) => string;

let englishTextToKey: Map<string, string> | null = null;

export function getI18nKeyForEnglishText(text: string): string | undefined {
    if (!englishTextToKey) {
        englishTextToKey = new Map();
        for (const [key, value] of Object.entries(en)) {
            if (englishTextToKey.has(value)) continue;
            englishTextToKey.set(value, key);
        }
    }
    return englishTextToKey.get(text);
}

export function getEnglishI18nValue(key: string): string | undefined {
    return en[key];
}

export function translateWithFallback(t: TranslateFn, key: string, fallback: string): string {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
}

export function formatI18nTemplate(
    template: string,
    values: Record<string, string | number | boolean | null | undefined>,
): string {
    return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => (
        Object.prototype.hasOwnProperty.call(values, key)
            ? String(values[key] ?? '')
            : match
    ));
}

export const tFallback = translateWithFallback;
