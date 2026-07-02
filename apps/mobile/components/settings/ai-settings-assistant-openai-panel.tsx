import React, { useState } from 'react';
import { Platform, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { AIReasoningEffort } from '@mindwtr/core';

import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CompactText } from '@/components/compact-text';

import { styles } from './settings.styles';

type SettingsTranslator = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
type Translate = (key: string) => string;

type AiSettingsAssistantOpenAiPanelProps = {
    aiApiKey: string;
    aiBaseUrl: string;
    aiExtraBodyParamsDraft: string;
    aiExtraBodyParamsError: string;
    aiReasoningEffort: AIReasoningEffort;
    isFossBuild: boolean;
    tr: SettingsTranslator;
    onAiApiKeyChange: (value: string) => void;
    onAiBaseUrlChange: (value: string) => void;
    onAiExtraBodyParamsDraftChange: (value: string) => void;
    onAiExtraBodyParamsSave: () => void;
    onAiReasoningEffortChange: (value: AIReasoningEffort) => void;
    t: Translate;
    tc: ThemeColors;
};

export function AiSettingsAssistantOpenAiPanel({
    aiApiKey,
    aiBaseUrl,
    aiExtraBodyParamsDraft,
    aiExtraBodyParamsError,
    aiReasoningEffort,
    isFossBuild,
    tr,
    onAiApiKeyChange,
    onAiBaseUrlChange,
    onAiExtraBodyParamsDraftChange,
    onAiExtraBodyParamsSave,
    onAiReasoningEffortChange,
    t,
    tc,
}: AiSettingsAssistantOpenAiPanelProps) {
    const [extraParamsOpen, setExtraParamsOpen] = useState(false);

    return (
        <>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiReasoning')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                        {t(isFossBuild ? 'settings.aiReasoningHintFoss' : 'settings.aiReasoningHint')}
                    </Text>
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <View style={styles.backendToggle}>
                    {(['low', 'medium', 'high'] as AIReasoningEffort[]).map((effort) => (
                        <TouchableOpacity
                            key={effort}
                            style={[
                                styles.backendOption,
                                { borderColor: tc.border, backgroundColor: aiReasoningEffort === effort ? tc.filterBg : 'transparent' },
                            ]}
                            onPress={() => onAiReasoningEffortChange(effort)}
                        >
                            <CompactText
                                style={[styles.backendOptionText, { color: aiReasoningEffort === effort ? tc.tint : tc.secondaryText }]}
                                numberOfLines={2}
                            >
                                {effort === 'low'
                                    ? t('settings.aiEffortLow')
                                    : effort === 'medium'
                                        ? t('settings.aiEffortMedium')
                                        : t('settings.aiEffortHigh')}
                            </CompactText>
                        </TouchableOpacity>
                    ))}
                </View>
            </View>
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiBaseUrl')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiBaseUrlHint')}</Text>
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                <TextInput
                    value={aiBaseUrl}
                    onChangeText={onAiBaseUrlChange}
                    placeholder={t('settings.aiBaseUrlPlaceholder')}
                    placeholderTextColor={tc.secondaryText}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                />
            </View>
            <TouchableOpacity
                style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}
                onPress={() => setExtraParamsOpen((open) => !open)}
            >
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiExtraBodyParams')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>
                        {t('settings.aiExtraBodyParamsDesc')}
                    </Text>
                </View>
                <Text style={[styles.chevron, { color: tc.secondaryText }]}>{extraParamsOpen ? '▾' : '▸'}</Text>
            </TouchableOpacity>
            {extraParamsOpen && (
                <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
                    <TextInput
                        value={aiExtraBodyParamsDraft}
                        onChangeText={onAiExtraBodyParamsDraftChange}
                        placeholder={'{\n  "thinking": { "type": "disabled" }\n}'}
                        placeholderTextColor={tc.secondaryText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        multiline
                        textAlignVertical="top"
                        style={[
                            styles.textInput,
                            {
                                borderColor: aiExtraBodyParamsError ? tc.danger : tc.border,
                                color: tc.text,
                                minHeight: 120,
                                fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
                            },
                        ]}
                    />
                    <Text style={[styles.settingDescription, { color: aiExtraBodyParamsError ? tc.danger : tc.secondaryText, marginTop: 6 }]}>
                        {aiExtraBodyParamsError || t('settings.aiExtraBodyParamsHint')}
                    </Text>
                    <TouchableOpacity
                        style={{
                            alignItems: 'center',
                            borderColor: tc.border,
                            borderRadius: 10,
                            borderWidth: 1,
                            marginTop: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 10,
                        }}
                        onPress={onAiExtraBodyParamsSave}
                    >
                        <Text style={{ color: tc.text, fontSize: 13, fontWeight: '700' }}>
                            {t('settings.aiExtraBodyParamsSave')}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}
            <View style={[styles.settingRow, { borderTopWidth: 1, borderTopColor: tc.border }]}>
                <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: tc.text }]}>{t('settings.aiApiKey')}</Text>
                    <Text style={[styles.settingDescription, { color: tc.secondaryText }]}>{t('settings.aiApiKeyHint')}</Text>
                    {isFossBuild && (
                        <Text style={[styles.settingDescription, { color: tc.secondaryText, marginTop: 6 }]}>
                            {tr('settings.aiMobile.useTheApiKeyForYourLocalOrSelfHosted')}
                        </Text>
                    )}
                </View>
            </View>
            <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
                <TextInput
                    value={aiApiKey}
                    onChangeText={onAiApiKeyChange}
                    placeholder={t('settings.aiApiKeyPlaceholder')}
                    placeholderTextColor={tc.secondaryText}
                    autoCapitalize="none"
                    secureTextEntry
                    style={[styles.textInput, { borderColor: tc.border, color: tc.text }]}
                />
            </View>
        </>
    );
}
