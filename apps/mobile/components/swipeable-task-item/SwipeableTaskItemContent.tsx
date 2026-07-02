import React, { type ReactNode, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CircleDot, Repeat } from 'lucide-react-native';
import { useThemeTokens } from '../../hooks/use-theme-tokens';
import {
    getInlineMarkdownPreview,
    getTaskAgeLabel,
    getTaskDateCoherenceIssues,
    getTaskUrgency,
    getStatusColor,
    formatTimeEstimateLabel,
    hasTimeComponent,
    resolveTaskTextDirection,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    tFallback,
} from '@mindwtr/core';
import type { Area, Language, Project, ProjectSequenceTaskCue, Task } from '@mindwtr/core';
import type { ThemeColors } from '../../hooks/use-theme-colors';
import { FocusStarIcon } from '../FocusStarIcon';
import { MarkdownInlineText } from '../markdown-text';
import { styles } from './swipeable-task-item.styles';
import { CompactText } from '@/components/compact-text';

interface SwipeableTaskItemContentProps {
    accessibilityActions: { label: string; name: string }[];
    accessibilityHint: string;
    accessibilityLabel: string;
    canShowFocusToggle: boolean;
    checklistProgress: { completed: number; percent: number; total: number } | null;
    hideChecklistProgress: boolean;
    hideContexts: boolean;
    hideProjectMeta: boolean;
    hideStatusBadge: boolean;
    /** Render the status control as a compact icon button (no status-name label) for single-status lists */
    statusBadgeAsIcon: boolean;
    isDark: boolean;
    isHighlighted: boolean;
    isMultiSelected: boolean;
    language: string;
    localChecklist: Task['checklist'];
    interactionDisabled?: boolean;
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
    onContextPress?: (context: string) => void;
    onLongPress: () => void;
    onOpenStatusMenu: () => void;
    onPress: () => void;
    onProjectPress?: (projectId: string) => void;
    onTagPress?: (tag: string) => void;
    onToggleChecklist: () => void;
    onToggleChecklistItem: (index: number) => void;
    onToggleFocus: () => void;
    projects: Project[];
    projectDeadlineLabel?: string;
    recurrenceLabel?: string;
    sequenceCue?: ProjectSequenceTaskCue;
    areas: Area[];
    selectionMode: boolean;
    showChecklist: boolean;
    showTaskAge: boolean;
    t: (key: string) => string;
    task: Task;
    tc: ThemeColors;
}

export function SwipeableTaskItemContent({
    accessibilityActions,
    accessibilityHint,
    accessibilityLabel,
    areas,
    canShowFocusToggle,
    checklistProgress,
    hideChecklistProgress,
    hideContexts,
    hideProjectMeta,
    hideStatusBadge,
    statusBadgeAsIcon,
    isDark,
    isHighlighted,
    isMultiSelected,
    interactionDisabled = false,
    language,
    localChecklist,
    onAccessibilityAction,
    onContextPress,
    onLongPress,
    onOpenStatusMenu,
    onPress,
    onProjectPress,
    onTagPress,
    onToggleChecklist,
    onToggleChecklistItem,
    onToggleFocus,
    projects,
    projectDeadlineLabel,
    recurrenceLabel,
    sequenceCue,
    selectionMode,
    showChecklist,
    showTaskAge,
    t,
    task,
    tc,
}: SwipeableTaskItemContentProps) {
    const { project, projectColor } = useMemo(() => {
        const activeProject = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
        const projectArea = activeProject?.areaId
            ? areas.find((area) => area.id === activeProject.areaId)
            : undefined;
        return {
            project: activeProject,
            projectColor: projectArea?.color,
        };
    }, [areas, projects, task.projectId]);

    const resolvedDirection = resolveTaskTextDirection(task);
    const textDirection = resolvedDirection === 'rtl' ? 'rtl' : 'ltr';
    const textAlign = resolvedDirection === 'rtl' ? 'right' : 'left';
    const timeEstimateLabel = (() => {
        if (!task.timeEstimate) return null;
        return formatTimeEstimateLabel(task.timeEstimate);
    })();
    const dueLabel = (() => {
        const due = safeParseDueDate(task.dueDate);
        if (!due) return null;
        const hasTime = hasTimeComponent(task.dueDate);
        return safeFormatDate(due, hasTime ? 'Pp' : 'P');
    })();
    const dueColor = (() => {
        const urgency = getTaskUrgency(task);
        if (urgency === 'overdue') return tc.danger;
        if (urgency === 'urgent' || urgency === 'upcoming') return tc.warning;
        return tc.secondaryText;
    })();
    const startLabel = (() => {
        const start = safeParseDate(task.startTime);
        if (!start) return null;
        const hasTime = hasTimeComponent(task.startTime);
        return safeFormatDate(start, hasTime ? 'Pp' : 'P');
    })();
    const startDateLabel = tFallback(t, 'taskEdit.startDateLabel', 'Start');
    const dateIssueLabel = getTaskDateCoherenceIssues(task).some((issue) => issue.code === 'start_after_due')
        ? tFallback(t, 'task.dateIssue.startAfterDue', 'Starts after due date')
        : null;
    const completionLabel = (() => {
        if (task.status !== 'done' && task.status !== 'archived') return null;
        const completionTimestamp = task.completedAt || task.updatedAt;
        if (!completionTimestamp) return null;
        return safeFormatDate(completionTimestamp, 'Pp', completionTimestamp);
    })();
    const ageLabel = getTaskAgeLabel(task.createdAt, language as Language);
    const showAge = showTaskAge
        && task.status !== 'done'
        && task.status !== 'reference'
        && !!ageLabel;
    const statusColors = getStatusColor(task.status);
    const isAvailableNextAction = sequenceCue === 'available';
    const descriptionPreview = useMemo(
        () => getInlineMarkdownPreview(task.description ?? ''),
        [task.description],
    );
    const metaParts: ReactNode[] = [];
    const canNavigateMeta = !selectionMode;

    const addMetaPart = (node: ReactNode, key: string) => {
        if (metaParts.length > 0) {
            metaParts.push(
                <Text key={`sep-${key}`} style={[styles.metaSeparator, { color: tc.secondaryText }]}>
                    ·
                </Text>
            );
        }
        metaParts.push(node);
    };

    const renderMetaItem = ({
        accessibilityLabel: metaAccessibilityLabel,
        children,
        key,
        onPress: onMetaPress,
    }: {
        accessibilityLabel?: string;
        children: ReactNode;
        key: string;
        onPress?: () => void;
    }) => {
        if (!onMetaPress) {
            return (
                <View key={key} style={styles.inlineMetaItem}>
                    {children}
                </View>
            );
        }
        return (
            <Pressable
                key={key}
                onPress={(event) => {
                    event.stopPropagation();
                    onMetaPress();
                }}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel={metaAccessibilityLabel}
                style={styles.inlineMetaButton}
            >
                <View style={styles.inlineMetaItem}>
                    {children}
                </View>
            </Pressable>
        );
    };

    if (!hideProjectMeta && project) {
        addMetaPart(
            renderMetaItem({
                key: 'project',
                onPress: canNavigateMeta && onProjectPress ? () => onProjectPress(project.id) : undefined,
                accessibilityLabel: `Open project ${project.title}`,
                children: (
                    <>
                        <View style={[styles.projectDot, { backgroundColor: projectColor || tc.tint }]} />
                        <CompactText
                            style={[styles.metaText, { color: tc.secondaryText }]}
                            numberOfLines={2}
                        >
                            {project.title}
                        </CompactText>
                    </>
                ),
            }),
            'project'
        );
    }

    if (projectDeadlineLabel) {
        addMetaPart(
            <CompactText
                key="project-deadline"
                style={[styles.metaText, styles.projectDeadlineText]}
                numberOfLines={2}
            >
                {projectDeadlineLabel}
            </CompactText>,
            'project-deadline'
        );
    }

    if (!hideContexts && task.contexts?.length) {
        const context = task.contexts[0];
        const moreContexts = task.contexts.length - 1;
        addMetaPart(
            renderMetaItem({
                key: 'context',
                onPress: canNavigateMeta && onContextPress ? () => onContextPress(context) : undefined,
                accessibilityLabel: `Open context ${context}`,
                children: (
                    <>
                        <CompactText
                            style={[styles.metaText, styles.contextText]}
                            numberOfLines={2}
                        >
                            {context}
                        </CompactText>
                        {moreContexts > 0 && (
                            <CompactText style={[styles.metaText, { color: tc.secondaryText }]}>+{moreContexts}</CompactText>
                        )}
                    </>
                ),
            }),
            'context'
        );
    }

    if (task.tags?.length) {
        const tag = task.tags[0];
        const moreTags = task.tags.length - 1;
        addMetaPart(
            renderMetaItem({
                key: 'tag',
                onPress: canNavigateMeta && onTagPress ? () => onTagPress(tag) : undefined,
                accessibilityLabel: `Open tag ${tag}`,
                children: (
                    <>
                        <CompactText
                            style={[styles.metaText, styles.tagText]}
                            numberOfLines={2}
                        >
                            {tag}
                        </CompactText>
                        {moreTags > 0 && (
                            <CompactText style={[styles.metaText, { color: tc.secondaryText }]}>+{moreTags}</CompactText>
                        )}
                    </>
                ),
            }),
            'tag'
        );
    }

    if (completionLabel) {
        addMetaPart(
            <CompactText
                key="completed"
                style={[styles.metaText, { color: tc.secondaryText }]}
            >
                {`${t('list.done') || 'Completed'}: ${completionLabel}`}
            </CompactText>,
            'completed'
        );
    }

    if (dueLabel) {
        addMetaPart(
            <CompactText
                key="due"
                style={[styles.metaText, styles.dueText, { color: dueColor }]}
            >
                {dueLabel}
            </CompactText>,
            'due'
        );
    }

    if (startLabel) {
        addMetaPart(
            <CompactText
                key="start"
                style={[styles.metaText, { color: tc.secondaryText }]}
            >
                {`${startDateLabel}: ${startLabel}`}
            </CompactText>,
            'start'
        );
    }

    if (dateIssueLabel) {
        addMetaPart(
            <CompactText
                key="date-issue"
                style={[styles.metaText, styles.dateIssueText]}
                numberOfLines={1}
            >
                {dateIssueLabel}
            </CompactText>,
            'date-issue'
        );
    }

    if (recurrenceLabel) {
        addMetaPart(
            renderMetaItem({
                key: 'recurrence',
                children: (
                    <>
                        <Repeat size={12} color={tc.secondaryText} strokeWidth={2} />
                        <CompactText
                            key="recurrence-label"
                            style={[styles.metaText, { color: tc.secondaryText }]}
                            numberOfLines={2}
                        >
                            {recurrenceLabel}
                        </CompactText>
                    </>
                ),
            }),
            'recurrence'
        );
    }

    if (timeEstimateLabel) {
        addMetaPart(
            <Text key="estimate" style={[styles.metaText, { color: tc.secondaryText }]}>
                {timeEstimateLabel}
            </Text>,
            'estimate'
        );
    }

    const { isMaterial, shape, state } = useThemeTokens();

    return (
        <Pressable
            android_ripple={isMaterial && state.rippleColor ? { color: state.rippleColor } : undefined}
            style={[
                styles.taskItem,
                isMaterial ? { borderRadius: shape.large } : undefined,
                { backgroundColor: tc.taskItemBg },
                { borderWidth: StyleSheet.hairlineWidth, borderColor: tc.border },
                isAvailableNextAction && !selectionMode && {
                    backgroundColor: isDark ? 'rgba(59, 130, 246, 0.08)' : 'rgba(59, 130, 246, 0.05)',
                    borderColor: isDark ? 'rgba(59, 130, 246, 0.34)' : 'rgba(59, 130, 246, 0.24)',
                },
                !isDark && {
                    shadowColor: '#0F172A',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.06,
                    shadowRadius: 6,
                    elevation: 2,
                },
                canShowFocusToggle && task.isFocusedToday && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                isHighlighted && !selectionMode && { borderWidth: 2, borderColor: tc.tint },
                selectionMode && { borderWidth: 2, borderColor: isMultiSelected ? tc.tint : tc.border },
            ]}
            onPress={onPress}
            onLongPress={onLongPress}
            delayLongPress={300}
            disabled={interactionDisabled}
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={accessibilityHint}
            accessibilityRole="button"
            accessibilityState={interactionDisabled ? { disabled: true } : undefined}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={onAccessibilityAction}
        >
            {selectionMode && (
                <View
                    style={[
                        styles.selectionIndicator,
                        {
                            borderColor: tc.tint,
                            backgroundColor: isMultiSelected ? tc.tint : 'transparent',
                        },
                    ]}
                    pointerEvents="none"
                >
                    {isMultiSelected && <Text style={styles.selectionIndicatorText}>✓</Text>}
                </View>
            )}
            <View style={styles.taskContent}>
                <View style={styles.titleRow}>
                    <Text
                        style={[
                            styles.taskTitle,
                            { color: tc.text, writingDirection: textDirection, textAlign },
                            canShowFocusToggle && styles.taskTitleFlex,
                        ]}
                        numberOfLines={2}
                    >
                        {task.title}
                    </Text>
                    {canShowFocusToggle && !selectionMode && (
                        <Pressable
                            onPress={(event) => {
                                event.stopPropagation();
                                onToggleFocus();
                            }}
                            hitSlop={8}
                            style={styles.focusButton}
                            accessibilityRole="button"
                            accessibilityLabel={task.isFocusedToday ? t('agenda.removeFromFocus') : t('agenda.addToFocus')}
                        >
                            <FocusStarIcon
                                focused={task.isFocusedToday === true}
                                inactiveColor={tc.secondaryText}
                            />
                        </Pressable>
                    )}
                </View>
                {descriptionPreview ? (
                    <MarkdownInlineText
                        markdown={descriptionPreview}
                        tc={tc}
                        direction={textDirection}
                        style={[styles.taskDescription, { color: tc.secondaryText }]}
                        numberOfLines={1}
                    />
                ) : null}
                {metaParts.length > 0 && (
                    <View style={styles.inlineMeta}>
                        {metaParts}
                    </View>
                )}
                {!hideChecklistProgress && checklistProgress && (
                    <Pressable
                        onPress={onToggleChecklist}
                        style={styles.checklistRow}
                        accessibilityRole="button"
                        accessibilityLabel={t('checklist.progress')}
                    >
                        <Text style={[styles.checklistText, { color: tc.secondaryText }]}>
                            {checklistProgress.completed}/{checklistProgress.total}
                        </Text>
                        <View style={[styles.checklistBar, { backgroundColor: tc.border }]}>
                            <View
                                style={[
                                    styles.checklistBarFill,
                                    { width: `${Math.round(checklistProgress.percent * 100)}%`, backgroundColor: tc.tint },
                                ]}
                            />
                        </View>
                    </Pressable>
                )}
                {showChecklist && (localChecklist || []).length > 0 && (
                    <View style={styles.checklistItems}>
                        {(localChecklist || []).map((item, index) => (
                            <Pressable
                                key={item.id || index}
                                onPress={() => onToggleChecklistItem(index)}
                                style={styles.checklistItem}
                                accessibilityRole="button"
                                accessibilityLabel={item.title}
                                accessibilityState={{ checked: item.isCompleted }}
                            >
                                <MarkdownInlineText
                                    markdown={`${item.isCompleted ? '✓' : '○'} ${item.title}`}
                                    tc={tc}
                                    style={[
                                        styles.checklistItemText,
                                        { color: tc.secondaryText },
                                        item.isCompleted ? styles.checklistItemCompleted : undefined,
                                    ]}
                                    numberOfLines={1}
                                />
                            </Pressable>
                        ))}
                    </View>
                )}
                {showAge && (
                    <Text style={[styles.staleText, { color: tc.secondaryText }]}>
                        ⏱ {ageLabel}
                    </Text>
                )}
            </View>
            {!hideStatusBadge && (
                <Pressable
                    onPress={(event) => {
                        event.stopPropagation();
                        onOpenStatusMenu();
                    }}
                    hitSlop={8}
                    style={
                        statusBadgeAsIcon
                            ? styles.statusIconButton
                            : [
                                styles.statusBadge,
                                { backgroundColor: statusColors.bg, borderColor: statusColors.border },
                            ]
                    }
                    accessibilityLabel={`Change status. Current status: ${task.status}`}
                    accessibilityHint="Double tap to open status menu"
                    accessibilityRole="button"
                >
                    {statusBadgeAsIcon ? (
                        <CircleDot size={20} color={statusColors.text} strokeWidth={2} />
                    ) : (
                        <Text style={[styles.statusText, { color: statusColors.text }]}>
                            {t(`status.${task.status}`)}
                        </Text>
                    )}
                </Pressable>
            )}
        </Pressable>
    );
}
