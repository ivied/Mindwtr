import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
    createCustomTimeEstimate,
    formatTimeEstimateLabel,
    isCustomTimeEstimate,
    parseTimeEstimateInput,
    timeEstimateToMinutes,
    translateWithFallback,
} from '@mindwtr/core';

import type { TaskEditFieldRendererProps } from './TaskEditFieldRenderer.types';
import { getAreaIdForClearedProject, getEditedTaskValue } from './task-edit-modal.utils';
import { CompactText } from '@/components/compact-text';

type OrganizationFieldId =
    | 'status'
    | 'project'
    | 'section'
    | 'area'
    | 'priority'
    | 'energyLevel'
    | 'assignedTo'
    | 'timeEstimate';

type TaskEditOrganizationFieldProps = TaskEditFieldRendererProps & {
    fieldId: OrganizationFieldId;
};

export function TaskEditOrganizationField({
    applyAssignedToSuggestion,
    areas,
    assignedToSuggestions,
    availableStatusOptions,
    createAssignedToPerson,
    editedTask,
    energyLevelOptions,
    fieldId,
    handleInputFocus,
    prioritiesEnabled,
    priorityOptions,
    projectSections,
    projects,
    requestStatusChange,
    setEditedTask,
    setShowAreaPicker,
    setShowProjectPicker,
    setShowSectionPicker,
    styles,
    t,
    task,
    tc,
    timeEstimateOptions,
    timeEstimatesEnabled,
}: TaskEditOrganizationFieldProps) {
    const inputStyle = { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text };
    const currentTimeEstimate = editedTask.timeEstimate;
    const customTimeEstimateDraftSourceRef = React.useRef<string | undefined>(undefined);
    const [customTimeEstimateDraft, setCustomTimeEstimateDraft] = React.useState('');
    const isCustomTimeEstimateSelected = isCustomTimeEstimate(currentTimeEstimate);

    React.useEffect(() => {
        if (!isCustomTimeEstimateSelected) {
            customTimeEstimateDraftSourceRef.current = currentTimeEstimate;
            setCustomTimeEstimateDraft('');
            return;
        }

        if (customTimeEstimateDraftSourceRef.current !== currentTimeEstimate) {
            customTimeEstimateDraftSourceRef.current = currentTimeEstimate;
            setCustomTimeEstimateDraft(formatTimeEstimateLabel(currentTimeEstimate));
        }
    }, [currentTimeEstimate, isCustomTimeEstimateSelected]);

    const setCustomTimeEstimate = (minutes: number) => {
        const next = createCustomTimeEstimate(minutes);
        customTimeEstimateDraftSourceRef.current = next;
        setEditedTask((prev) => ({ ...prev, timeEstimate: next }));
        return next;
    };

    const beginCustomTimeEstimate = () => {
        const next = setCustomTimeEstimate(timeEstimateToMinutes(currentTimeEstimate));
        setCustomTimeEstimateDraft(formatTimeEstimateLabel(next));
    };

    const applyCustomTimeEstimateDraft = (draft: string): boolean => {
        const minutes = parseTimeEstimateInput(draft);
        if (minutes === null) return false;
        setCustomTimeEstimate(minutes);
        return true;
    };
    const getStatusChipStyle = (active: boolean) => ([
        styles.statusChip,
        { backgroundColor: active ? tc.tint : tc.filterBg, borderColor: active ? tc.tint : tc.border },
    ]);
    const getStatusTextStyle = (active: boolean, compact = false) => ([
        styles.statusText,
        compact ? styles.statusTextCompact : null,
        { color: active ? '#fff' : tc.secondaryText },
    ]);
    const getStatusLabel = (status: string) => {
        const key = `status.${status}` as const;
        return translateWithFallback(t, key, status);
    };
    const renderCompactPicker = (label: string, value: string, onPress: () => void) => (
        <View style={styles.formGroup}>
            <TouchableOpacity
                style={[styles.compactFieldRow, { backgroundColor: tc.filterBg, borderColor: tc.border }]}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${value}`}
            >
                <CompactText
                    style={[styles.compactFieldLabel, { color: tc.secondaryText }]}
                >
                    {label}
                </CompactText>
                <CompactText
                    style={[styles.compactFieldValue, { color: tc.tint }]}
                    numberOfLines={2}
                >
                    {value}
                </CompactText>
            </TouchableOpacity>
        </View>
    );
    const assignedToDraft = String(editedTask.assignedTo ?? '').trim();
    const assignedToCreateLabel = translateWithFallback(t, 'people.new', 'New Person');
    const canCreateAssignedToPerson = assignedToDraft.length > 0
        && !assignedToSuggestions.some((name) => name.trim().toLowerCase() === assignedToDraft.toLowerCase());

    switch (fieldId) {
        case 'status':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.statusLabel')}</Text>
                    <View style={styles.statusContainerCompact}>
                        {availableStatusOptions.map((status) => (
                            <TouchableOpacity
                                key={status}
                                style={[styles.statusChipCompact, ...getStatusChipStyle(editedTask.status === status)]}
                                onPress={() => requestStatusChange(status)}
                                accessibilityRole="button"
                                accessibilityState={{ selected: editedTask.status === status }}
                                accessibilityLabel={`${t('taskEdit.statusLabel')}: ${getStatusLabel(status)}`}
                            >
                                <Text
                                    style={getStatusTextStyle(editedTask.status === status, true)}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                    adjustsFontSizeToFit
                                    minimumFontScale={0.8}
                                >
                                    {getStatusLabel(status)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'project': {
            const projectId = getEditedTaskValue(editedTask, task, 'projectId');
            if (!projectId) {
                return renderCompactPicker(
                    t('taskEdit.projectLabel'),
                    t('taskEdit.noProjectOption'),
                    () => setShowProjectPicker(true)
                );
            }
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.projectLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowProjectPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {projects.find((project) => project.id === projectId)?.title || t('taskEdit.noProjectOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!projectId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({
                                    ...prev,
                                    projectId: undefined,
                                    sectionId: undefined,
                                    areaId: getAreaIdForClearedProject(prev, task, projects),
                                }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'section': {
            const projectId = getEditedTaskValue(editedTask, task, 'projectId');
            if (!projectId) return null;
            const section = projectSections.find((item) => item.id === editedTask.sectionId);
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.sectionLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowSectionPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {section?.title || t('taskEdit.noSectionOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!editedTask.sectionId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, sectionId: undefined }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'area': {
            const areaId = getEditedTaskValue(editedTask, task, 'areaId');
            if (getEditedTaskValue(editedTask, task, 'projectId')) return null;
            if (!areaId) {
                return renderCompactPicker(
                    t('taskEdit.areaLabel'),
                    t('taskEdit.noAreaOption'),
                    () => setShowAreaPicker(true)
                );
            }
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.areaLabel')}</Text>
                    <View style={styles.dateRow}>
                        <TouchableOpacity
                            style={[styles.dateBtn, styles.flex1, { backgroundColor: tc.inputBg, borderColor: tc.border }]}
                            onPress={() => setShowAreaPicker(true)}
                        >
                            <Text style={{ color: tc.text }}>
                                {areas.find((area) => area.id === areaId)?.name || t('taskEdit.noAreaOption')}
                            </Text>
                        </TouchableOpacity>
                        {!!areaId && (
                            <TouchableOpacity
                                style={[styles.clearDateBtn, { borderColor: tc.border, backgroundColor: tc.filterBg }]}
                                onPress={() => setEditedTask((prev) => ({ ...prev, areaId: undefined }))}
                            >
                                <Text style={[styles.clearDateText, { color: tc.secondaryText }]}>{t('common.clear')}</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            );
        }
        case 'priority':
            if (!prioritiesEnabled) return null;
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.priorityLabel')}</Text>
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={getStatusChipStyle(!editedTask.priority)}
                            onPress={() => setEditedTask((prev) => ({ ...prev, priority: undefined }))}
                        >
                            <Text style={getStatusTextStyle(!editedTask.priority)}>
                                {t('common.none')}
                            </Text>
                        </TouchableOpacity>
                        {priorityOptions.map((priority) => (
                            <TouchableOpacity
                                key={priority}
                                style={getStatusChipStyle(editedTask.priority === priority)}
                                onPress={() => setEditedTask((prev) => ({ ...prev, priority }))}
                            >
                                <Text style={getStatusTextStyle(editedTask.priority === priority)}>
                                    {t(`priority.${priority}`)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'energyLevel':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.energyLevel')}</Text>
                    <View style={styles.statusContainer}>
                        <TouchableOpacity
                            style={getStatusChipStyle(!editedTask.energyLevel)}
                            onPress={() => setEditedTask((prev) => ({ ...prev, energyLevel: undefined }))}
                        >
                            <Text style={getStatusTextStyle(!editedTask.energyLevel)}>
                                {t('common.none')}
                            </Text>
                        </TouchableOpacity>
                        {energyLevelOptions.map((energyLevel) => (
                            <TouchableOpacity
                                key={energyLevel}
                                style={getStatusChipStyle(editedTask.energyLevel === energyLevel)}
                                onPress={() => setEditedTask((prev) => ({ ...prev, energyLevel }))}
                            >
                                <Text style={getStatusTextStyle(editedTask.energyLevel === energyLevel)}>
                                    {t(`energyLevel.${energyLevel}`)}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                </View>
            );
        case 'assignedTo':
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.assignedTo')}</Text>
                    <TextInput
                        style={[styles.input, inputStyle]}
                        value={String(editedTask.assignedTo ?? '')}
                        onChangeText={(assignedTo) => setEditedTask((prev) => ({ ...prev, assignedTo }))}
                        onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                        placeholder={t('taskEdit.assignedToPlaceholder')}
                        placeholderTextColor={tc.secondaryText}
                        accessibilityLabel={t('taskEdit.assignedTo')}
                        accessibilityHint={t('taskEdit.assignedToPlaceholder')}
                    />
                    {(assignedToSuggestions.length > 0 || canCreateAssignedToPerson) && (
                        <View style={[styles.tokenSuggestionsMenu, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            {canCreateAssignedToPerson && (
                                <TouchableOpacity
                                    style={[
                                        styles.tokenSuggestionItem,
                                        assignedToSuggestions.length === 0 ? styles.tokenSuggestionItemLast : null,
                                    ]}
                                    onPress={() => {
                                        void createAssignedToPerson(assignedToDraft);
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${assignedToCreateLabel}: ${assignedToDraft}`}
                                >
                                    <Text style={[styles.tokenSuggestionText, { color: tc.tint }]}>+ {assignedToCreateLabel} &quot;{assignedToDraft}&quot;</Text>
                                </TouchableOpacity>
                            )}
                            {assignedToSuggestions.map((name, index) => (
                                <TouchableOpacity
                                    key={name}
                                    style={[
                                        styles.tokenSuggestionItem,
                                        index === assignedToSuggestions.length - 1 ? styles.tokenSuggestionItemLast : null,
                                    ]}
                                    onPress={() => applyAssignedToSuggestion(name)}
                                >
                                    <Text style={[styles.tokenSuggestionText, { color: tc.text }]}>{name}</Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                    )}
                </View>
            );
        case 'timeEstimate': {
            if (!timeEstimatesEnabled) return null;
            const customTimeEstimateLabel = translateWithFallback(t, 'recurrence.custom', 'Custom…');
            return (
                <View style={styles.formGroup}>
                    <Text style={[styles.label, { color: tc.secondaryText }]}>{t('taskEdit.timeEstimateLabel')}</Text>
                    <View style={styles.statusContainer}>
                        {timeEstimateOptions.map((option) => (
                            <TouchableOpacity
                                key={option.value || 'none'}
                                style={getStatusChipStyle(
                                    editedTask.timeEstimate === option.value || (!option.value && !editedTask.timeEstimate)
                                )}
                                onPress={() => setEditedTask((prev) => ({ ...prev, timeEstimate: option.value || undefined }))}
                            >
                                <Text style={getStatusTextStyle(
                                    editedTask.timeEstimate === option.value || (!option.value && !editedTask.timeEstimate)
                                )}>
                                    {option.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                            key="custom"
                            style={getStatusChipStyle(isCustomTimeEstimateSelected)}
                            onPress={beginCustomTimeEstimate}
                        >
                            <Text style={getStatusTextStyle(isCustomTimeEstimateSelected)}>
                                {customTimeEstimateLabel}
                            </Text>
                        </TouchableOpacity>
                    </View>
                    {isCustomTimeEstimateSelected && (
                        <TextInput
                            style={[styles.input, inputStyle]}
                            value={customTimeEstimateDraft}
                            onChangeText={(draft) => {
                                setCustomTimeEstimateDraft(draft);
                                const minutes = parseTimeEstimateInput(draft);
                                if (minutes === null) return;
                                setCustomTimeEstimate(minutes);
                            }}
                            onBlur={() => {
                                if (!applyCustomTimeEstimateDraft(customTimeEstimateDraft) && currentTimeEstimate) {
                                    setCustomTimeEstimateDraft(formatTimeEstimateLabel(currentTimeEstimate));
                                }
                            }}
                            onSubmitEditing={() => {
                                if (!applyCustomTimeEstimateDraft(customTimeEstimateDraft) && currentTimeEstimate) {
                                    setCustomTimeEstimateDraft(formatTimeEstimateLabel(currentTimeEstimate));
                                }
                            }}
                            onFocus={(event) => handleInputFocus(event.nativeEvent.target)}
                            placeholder="2h30"
                            placeholderTextColor={tc.secondaryText}
                            accessibilityLabel={`${t('taskEdit.timeEstimateLabel')}: ${customTimeEstimateLabel}`}
                        />
                    )}
                </View>
            );
        }
        default:
            return null;
    }
}
