import {
    JALALI_LOCALE_TAG,
    normalizeDateFormatSetting,
    normalizeTimeFormatSetting,
    normalizeWeekStartSetting,
    resolveCalendarSystemSetting,
    resolveDateLocaleTag,
} from '@mindwtr/core';

type NativeDateInputLocaleParams = {
    language?: string | null;
    dateFormat?: string | null;
    calendarSystem?: string | null;
    timeFormat?: string | null;
    weekStart?: 'monday' | 'sunday' | 'saturday' | null;
    systemLocale?: string | null;
};

const YMD_NATIVE_LOCALE_BY_LANGUAGE: Record<string, string> = {
    en: 'en-CA',
    fr: 'fr-CA',
    zh: 'zh-CN',
    'zh-Hant': 'zh-TW',
    ja: 'ja-JP',
    ko: 'ko-KR',
};

const normalizeLocaleTag = (value?: string | null): string => String(value || '').trim().replace(/_/g, '-');

const normalizeLanguageKey = (value?: string | null): string => {
    const normalized = normalizeLocaleTag(value);
    if (!normalized) return 'en';
    const lower = normalized.toLowerCase();
    if (lower === 'zh-hant' || lower.startsWith('zh-hant')) return 'zh-Hant';
    if (lower.startsWith('zh')) return 'zh';
    return lower.split('-')[0] || 'en';
};

export function resolveNativeDateInputLocale(params: NativeDateInputLocaleParams): string {
    const dateFormat = normalizeDateFormatSetting(params.dateFormat);
    const timeFormat = normalizeTimeFormatSetting(params.timeFormat);
    const systemLocale = normalizeLocaleTag(params.systemLocale) || undefined;
    const normalizedLanguage = normalizeLanguageKey(params.language);
    const calendarSystem = resolveCalendarSystemSetting(params.calendarSystem, {
        language: params.language,
        systemLocale,
    });

    let baseLocale = calendarSystem === 'jalali'
        ? JALALI_LOCALE_TAG
        : resolveDateLocaleTag({
            language: params.language,
            dateFormat,
            systemLocale,
        });

    if (dateFormat === 'ymd' && calendarSystem !== 'jalali') {
        baseLocale = YMD_NATIVE_LOCALE_BY_LANGUAGE[normalizedLanguage] ?? baseLocale;
    }

    const unicodePreferences: string[] = [];
    if (timeFormat === '24h') {
        unicodePreferences.push('hc-h23');
    } else if (timeFormat === '12h') {
        unicodePreferences.push('hc-h12');
    }
    const weekStart = normalizeWeekStartSetting(params.weekStart);
    if (weekStart === 'monday') {
        unicodePreferences.push('fw-mon');
    } else if (weekStart === 'saturday') {
        unicodePreferences.push('fw-sat');
    } else if (weekStart === 'sunday') {
        unicodePreferences.push('fw-sun');
    }

    if (unicodePreferences.length === 0) {
        return baseLocale;
    }

    const [localeBase, existingUnicodeExtension] = baseLocale.split('-u-', 2);
    const unicodeExtension = [
        ...(existingUnicodeExtension ? existingUnicodeExtension.split('-') : []),
        ...unicodePreferences,
    ].filter(Boolean);

    return `${localeBase}-u-${unicodeExtension.join('-')}`;
}
