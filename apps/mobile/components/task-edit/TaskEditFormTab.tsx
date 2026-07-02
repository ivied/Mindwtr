import React from 'react';
import {
    Alert,
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    ActivityIndicator,
    Keyboard,
    Dimensions,
    UIManager,
    findNodeHandle,
    type ScrollViewProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { getRecurrenceUntilValue, tFallback, type Task, type TaskEditorFieldId, type TaskEditorSectionId, type TimeEstimate } from '@mindwtr/core';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { CollapsibleSection } from './CollapsibleSection';

type CopilotSuggestion = { context?: string; timeEstimate?: TimeEstimate; tags?: string[] };

type TaskEditFormTabProps = {
    t: (key: string) => string;
    tc: ThemeColors;
    styles: Record<string, any>;
    inputStyle: Record<string, any>;
    editedTask: Partial<Task>;
    setEditedTask: React.Dispatch<React.SetStateAction<Partial<Task>>>;
    aiEnabled: boolean;
    isAIWorking: boolean;
    handleAIClarify: () => void;
    handleAIBreakdown: () => void;
    copilotSuggestion: CopilotSuggestion | null;
    copilotApplied: boolean;
    applyCopilotSuggestion: () => void;
    copilotContext: string | undefined;
    copilotEstimate: TimeEstimate | undefined;
    copilotTags: string[];
    timeEstimatesEnabled: boolean;
    renderField: (fieldId: TaskEditorFieldId) => React.ReactNode;
    basicFields: TaskEditorFieldId[];
    schedulingFields: TaskEditorFieldId[];
    organizationFields: TaskEditorFieldId[];
    detailsFields: TaskEditorFieldId[];
    sectionOpenDefaults: Record<TaskEditorSectionId, boolean>;
    showDatePicker: string | null;
    pendingStartDate: Date | null;
    pendingDueDate: Date | null;
    getSafePickerDateValue: (dateStr?: string) => Date;
    onDateChange: (event: DateTimePickerEvent, selectedDate?: Date) => void;
    containerWidth: number;
    textDirectionStyle: Record<string, any>;
    titleDraft: string;
    onTitleDraftChange: (text: string) => void;
    onInputFocusTracked?: (targetInput?: number | string) => void;
    onTitleInputFocusChange?: (focused: boolean) => void;
    registerScrollToEnd?: (handler: ((targetInput?: number | string) => void) | null) => void;
    formResetKey?: string;
    suspendKeyboardHandling?: boolean;
};

const TASK_FORM_BASE_BOTTOM_PADDING = 32;

function TaskEditFormTabComponent({
    t,
    tc,
    styles,
    inputStyle,
    editedTask,
    setEditedTask,
    aiEnabled,
    isAIWorking,
    handleAIClarify,
    handleAIBreakdown,
    copilotSuggestion,
    copilotApplied,
    applyCopilotSuggestion,
    copilotContext,
    copilotEstimate,
    copilotTags,
    timeEstimatesEnabled,
    renderField,
    basicFields,
    schedulingFields,
    organizationFields,
    detailsFields,
    sectionOpenDefaults,
    showDatePicker,
    pendingStartDate,
    pendingDueDate,
    getSafePickerDateValue,
    onDateChange,
    containerWidth,
    textDirectionStyle,
    titleDraft,
    onTitleDraftChange,
    onInputFocusTracked,
    onTitleInputFocusChange,
    registerScrollToEnd,
    formResetKey,
    suspendKeyboardHandling = false,
}: TaskEditFormTabProps) {
    const [titleFocused, setTitleFocused] = React.useState(false);
    const formScrollRef = React.useRef<ScrollView | null>(null);
    const formScrollOffsetRef = React.useRef(0);
    const keyboardTopRef = React.useRef(Dimensions.get('window').height);
    const keyboardVisibleRef = React.useRef(false);
    const [keyboardBottomInset, setKeyboardBottomInset] = React.useState(0);
    const androidScrollViewFocusProps: Partial<ScrollViewProps> & { scrollsChildToFocus?: boolean } = (
        Platform.OS === 'android' ? { scrollsChildToFocus: false } : {}
    );
    const aiWorkingLabel = t('ai.working');
    const aiWorkingText = aiWorkingLabel === 'ai.working' ? 'Working...' : aiWorkingLabel;
    const taskEditorLayoutHelpLabel = tFallback(t, 'taskEdit.editorLayoutHelpLabel', 'Editor layout help');
    const taskEditorLayoutHelpText = tFallback(
        t,
        'taskEdit.editorLayoutHelpText',
        'You can customize which fields appear here in Settings -> GTD -> Task Editor Layout.'
    );
    const showTaskEditorLayoutHelp = React.useCallback(() => {
        Alert.alert(taskEditorLayoutHelpLabel, taskEditorLayoutHelpText);
    }, [taskEditorLayoutHelpLabel, taskEditorLayoutHelpText]);

    React.useEffect(() => {
        formScrollOffsetRef.current = 0;
        const resetScroll = () => {
            formScrollRef.current?.scrollTo({ y: 0, animated: false });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(resetScroll);
        } else {
            setTimeout(resetScroll, 0);
        }
    }, [formResetKey]);

    React.useEffect(() => {
        if (suspendKeyboardHandling) {
            keyboardTopRef.current = Dimensions.get('window').height;
            keyboardVisibleRef.current = false;
            setKeyboardBottomInset(0);
            return;
        }
        if (typeof Keyboard?.addListener !== 'function') return;
        const updateKeyboardTop = (event: { endCoordinates?: { screenY?: number; height?: number } }) => {
            const windowHeight = Dimensions.get('window').height;
            const endCoords = event.endCoordinates;
            let nextKeyboardTop = windowHeight;
            if (typeof endCoords?.screenY === 'number') {
                nextKeyboardTop = endCoords.screenY;
            } else if (typeof endCoords?.height === 'number') {
                nextKeyboardTop = Math.max(0, windowHeight - endCoords.height);
            }
            keyboardTopRef.current = nextKeyboardTop;
            keyboardVisibleRef.current = nextKeyboardTop < windowHeight;
            setKeyboardBottomInset(Math.max(0, windowHeight - nextKeyboardTop));
        };
        const resetKeyboardTop = () => {
            keyboardTopRef.current = Dimensions.get('window').height;
            keyboardVisibleRef.current = false;
            setKeyboardBottomInset(0);
        };
        const showListener = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
            updateKeyboardTop
        );
        const changeListener = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidChangeFrame',
            updateKeyboardTop
        );
        const hideListener = Keyboard.addListener(
            Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
            resetKeyboardTop
        );
        return () => {
            showListener.remove();
            changeListener.remove();
            hideListener.remove();
        };
    }, [suspendKeyboardHandling]);

    const scrollHandleIntoView = React.useCallback((targetHandle: number) => {
        const scrollView = formScrollRef.current;
        if (!scrollView) return;

        const scrollHandle = findNodeHandle(scrollView);
        if (!scrollHandle) return;

        UIManager.measureInWindow(targetHandle, (_x, targetY, _w, targetH) => {
            if (!Number.isFinite(targetY) || !Number.isFinite(targetH)) return;
            UIManager.measureInWindow(scrollHandle, (_sx, scrollY, _sw, scrollH) => {
                if (!Number.isFinite(scrollY) || !Number.isFinite(scrollH)) return;
                const visibleTop = scrollY;
                const keyboardTop = keyboardTopRef.current;
                const visibleBottom = Math.min(scrollY + scrollH, keyboardTop);
                const visibleHeight = Math.max(0, visibleBottom - visibleTop);
                const bottomClearance = visibleHeight * 0.18;
                const effectiveVisibleBottom = visibleBottom - bottomClearance;
                const targetTop = targetY;
                const targetBottom = targetY + targetH;

                if (targetBottom > effectiveVisibleBottom) {
                    const delta = targetBottom - effectiveVisibleBottom;
                    const nextOffset = Math.max(0, formScrollOffsetRef.current + delta);
                    formScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
                    return;
                }

                if (targetTop < visibleTop && Platform.OS !== 'android') {
                    const delta = visibleTop - targetTop;
                    const nextOffset = Math.max(0, formScrollOffsetRef.current - delta);
                    formScrollRef.current?.scrollTo({ y: nextOffset, animated: true });
                }
            });
        });
    }, []);

    const scheduleScrollHandleIntoView = React.useCallback((targetHandle: number) => {
        if (Platform.OS === 'android' && !keyboardVisibleRef.current) return;
        const scrollIntoView = () => scrollHandleIntoView(targetHandle);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                scrollIntoView();
                if (Platform.OS === 'android') {
                    requestAnimationFrame(scrollIntoView);
                }
            });
        } else {
            setTimeout(scrollIntoView, 0);
        }
        if (Platform.OS === 'android') return;
        setTimeout(scrollIntoView, 180);
        setTimeout(scrollIntoView, 360);
    }, [scrollHandleIntoView]);

    const ensureInputVisible = React.useCallback((targetInput?: number | string) => {
        const normalizedHandle = typeof targetInput === 'number'
            ? targetInput
            : typeof targetInput === 'string'
                ? Number(targetInput)
                : NaN;
        const hasTargetHandle = Number.isFinite(normalizedHandle) && normalizedHandle > 0;
        if (!hasTargetHandle) {
            return;
        }
        scheduleScrollHandleIntoView(normalizedHandle);
    }, [scheduleScrollHandleIntoView]);

    React.useEffect(() => {
        if (!registerScrollToEnd) return;
        if (suspendKeyboardHandling) {
            registerScrollToEnd(null);
            return;
        }
        registerScrollToEnd((targetInput) => {
            ensureInputVisible(targetInput);
        });
        return () => registerScrollToEnd(null);
    }, [ensureInputVisible, registerScrollToEnd, suspendKeyboardHandling]);
    const countFilledFields = (fieldIds: TaskEditorFieldId[]): number => {
        return fieldIds.filter((fieldId) => {
            switch (fieldId) {
                case 'startTime':
                    return Boolean(editedTask.startTime);
                case 'recurrence':
                    return Boolean(editedTask.recurrence);
                case 'reviewAt':
                    return Boolean(editedTask.reviewAt);
                case 'contexts':
                    return (editedTask.contexts?.length ?? 0) > 0;
                case 'tags':
                    return (editedTask.tags?.length ?? 0) > 0;
                case 'priority':
                    return Boolean(editedTask.priority);
                case 'energyLevel':
                    return Boolean(editedTask.energyLevel);
                case 'assignedTo':
                    return Boolean(String(editedTask.assignedTo ?? '').trim());
                case 'timeEstimate':
                    return Boolean(editedTask.timeEstimate);
                case 'description':
                    return Boolean(String(editedTask.description ?? '').trim());
                case 'location':
                    return Boolean(String(editedTask.location ?? '').trim());
                case 'checklist':
                    return (editedTask.checklist?.length ?? 0) > 0;
                case 'attachments':
                    return (editedTask.attachments || []).some((attachment) => !attachment.deletedAt);
                default:
                    return false;
            }
        }).length;
    };
    const schedulingFilledCount = countFilledFields(schedulingFields);
    const organizationFilledCount = countFilledFields(organizationFields);
    const detailsFilledCount = countFilledFields(detailsFields);

    return (
        <View style={[styles.tabPage, { width: containerWidth || '100%' }]}>
            <KeyboardAvoidingView
                behavior={suspendKeyboardHandling ? undefined : (Platform.OS === 'android' ? 'height' : undefined)}
                style={{ flex: 1 }}
                keyboardVerticalOffset={0}
            >
                <ScrollView
                    ref={formScrollRef}
                    style={styles.content}
                    contentContainerStyle={[
                        styles.contentContainer,
                        keyboardBottomInset > 0
                            ? { paddingBottom: TASK_FORM_BASE_BOTTOM_PADDING + keyboardBottomInset }
                            : null,
                    ]}
                    keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                    keyboardShouldPersistTaps="handled"
                    scrollEnabled={!suspendKeyboardHandling}
                    {...androidScrollViewFocusProps}
                    onScroll={(event) => {
                        formScrollOffsetRef.current = event.nativeEvent.contentOffset.y;
                    }}
                    scrollEventThrottle={16}
                    nestedScrollEnabled
                >
                        <View style={styles.formGroup}>
                            <View style={styles.labelRow}>
                                <Text style={[styles.label, { color: tc.secondaryText, marginBottom: 0 }]}>
                                    {t('taskEdit.titleLabel')}
                                </Text>
                                <TouchableOpacity
                                    accessibilityLabel={taskEditorLayoutHelpLabel}
                                    accessibilityRole="button"
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    onPress={showTaskEditorLayoutHelp}
                                    style={[
                                        styles.fieldHelpButton,
                                        { backgroundColor: tc.filterBg, borderColor: tc.border },
                                    ]}
                                >
                                    <Ionicons name="help-circle-outline" size={18} color={tc.secondaryText} />
                                </TouchableOpacity>
                            </View>
                            <TextInput
                            style={[styles.input, inputStyle, textDirectionStyle, styles.titleInput]}
                            value={titleDraft}
                            onChangeText={(text) => onTitleDraftChange(text.replace(/[\r\n]+/g, ' '))}
                            placeholderTextColor={tc.secondaryText}
                            multiline
                            onFocus={() => {
                                onInputFocusTracked?.(undefined);
                                setTitleFocused(true);
                                onTitleInputFocusChange?.(true);
                            }}
                            onBlur={() => {
                                setTitleFocused(false);
                                onTitleInputFocusChange?.(false);
                            }}
                            selection={titleFocused ? undefined : { start: 0, end: 0 }}
                        />
                    </View>
                    {aiEnabled && (
                        <View style={styles.aiRow}>
                            <TouchableOpacity
                                style={[styles.aiButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                onPress={handleAIClarify}
                                disabled={isAIWorking}
                            >
                                <Text style={[styles.aiButtonText, { color: tc.tint }]}>{t('taskEdit.aiClarify')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[styles.aiButton, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                                onPress={handleAIBreakdown}
                                disabled={isAIWorking}
                            >
                                <Text style={[styles.aiButtonText, { color: tc.tint }]}>{t('taskEdit.aiBreakdown')}</Text>
                            </TouchableOpacity>
                            {isAIWorking && (
                                <View style={styles.aiWorking}>
                                    <ActivityIndicator size="small" color={tc.tint} />
                                    <Text style={[styles.aiWorkingText, { color: tc.secondaryText }]}>
                                        {aiWorkingText}
                                    </Text>
                                </View>
                            )}
                        </View>
                    )}
                    {aiEnabled && copilotSuggestion && !copilotApplied && (
                        <TouchableOpacity
                            style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                            onPress={applyCopilotSuggestion}
                        >
                            <Text style={[styles.copilotText, { color: tc.text }]}>
                                ✨ {t('copilot.suggested')}{' '}
                                {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
                                {timeEstimatesEnabled && copilotSuggestion.timeEstimate ? `${copilotSuggestion.timeEstimate}` : ''}
                                {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
                            </Text>
                            <Text style={[styles.copilotHint, { color: tc.secondaryText }]}>
                                {t('copilot.applyHint')}
                            </Text>
                        </TouchableOpacity>
                    )}
                    {aiEnabled && copilotApplied && (
                        <View style={[styles.copilotPill, { borderColor: tc.border, backgroundColor: tc.filterBg }]}>
                            <Text style={[styles.copilotText, { color: tc.text }]}>
                                ✅ {t('copilot.applied')}{' '}
                                {copilotContext ? `${copilotContext} ` : ''}
                                {timeEstimatesEnabled && copilotEstimate ? `${copilotEstimate}` : ''}
                                {copilotTags.length ? copilotTags.join(' ') : ''}
                            </Text>
                        </View>
                    )}
                    {basicFields.map((fieldId) => (
                        <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                    ))}

                    {schedulingFields.length > 0 && (
                        <CollapsibleSection
                            resetKey={`${formResetKey ?? 'task'}:scheduling`}
                            title={t('taskEdit.scheduling')}
                            badge={schedulingFilledCount}
                            defaultExpanded={sectionOpenDefaults.scheduling || schedulingFilledCount > 0}
                        >
                            {schedulingFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))}
                        </CollapsibleSection>
                    )}

                    {organizationFields.length > 0 && (
                        <CollapsibleSection
                            resetKey={`${formResetKey ?? 'task'}:organization`}
                            title={t('taskEdit.organization')}
                            badge={organizationFilledCount}
                            defaultExpanded={sectionOpenDefaults.organization || organizationFilledCount > 0}
                        >
                            {organizationFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))}
                        </CollapsibleSection>
                    )}

                    {detailsFields.length > 0 && (
                        <CollapsibleSection
                            resetKey={`${formResetKey ?? 'task'}:details`}
                            title={t('taskEdit.details')}
                            badge={detailsFilledCount}
                            defaultExpanded={sectionOpenDefaults.details || detailsFilledCount > 0}
                        >
                            {detailsFields.map((fieldId) => (
                                <React.Fragment key={fieldId}>{renderField(fieldId)}</React.Fragment>
                            ))}
                        </CollapsibleSection>
                    )}

                    <View style={{ height: 100 }} />

                    {showDatePicker && Platform.OS === 'android' && (
                        <View>
                            <DateTimePicker
                                value={(() => {
                                    if (showDatePicker === 'start') return getSafePickerDateValue(editedTask.startTime);
                                    if (showDatePicker === 'start-time') return pendingStartDate ?? getSafePickerDateValue(editedTask.startTime);
                                    if (showDatePicker === 'review') return getSafePickerDateValue(editedTask.reviewAt);
                                    if (showDatePicker === 'recurrence-end') {
                                        return getSafePickerDateValue(getRecurrenceUntilValue(editedTask.recurrence));
                                    }
                                    if (showDatePicker === 'due-time') return pendingDueDate ?? getSafePickerDateValue(editedTask.dueDate);
                                    return getSafePickerDateValue(editedTask.dueDate);
                                })()}
                                mode={
                                    showDatePicker === 'start-time' || showDatePicker === 'due-time'
                                        ? 'time'
                                        : 'date'
                                }
                                display="default"
                                onChange={onDateChange}
                            />
                        </View>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
        </View>
    );
}

export const TaskEditFormTab = React.memo(TaskEditFormTabComponent);
