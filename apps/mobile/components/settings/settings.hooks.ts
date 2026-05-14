import { useMemo } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatI18nTemplate, getEnglishI18nValue, translateText } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';

import { styles } from './settings.styles';

type I18nTemplateValues = Record<string, string | number | boolean | null | undefined>;

export function useSettingsLocalization() {
    const { language, t, setLanguage } = useLanguage();
    const isChineseLanguage = language === 'zh' || language === 'zh-Hant';
    const tr = useMemo(
        () => (key: string, values?: I18nTemplateValues) => {
            const english = getEnglishI18nValue(key);
            const translated = t(key);
            const template = english && translated === english
                ? translateText(english, language)
                : translated && translated !== key
                    ? translated
                    : english ?? key;
            return values ? formatI18nTemplate(template, values) : template;
        },
        [language, t],
    );

    return {
        isChineseLanguage,
        language,
        setLanguage,
        t,
        tr,
    };
}

export function useSettingsScrollContent(paddingBottom = 16) {
    const insets = useSafeAreaInsets();

    return useMemo(
        () => [styles.scrollContent, { paddingBottom: paddingBottom + insets.bottom }],
        [insets.bottom, paddingBottom],
    );
}
