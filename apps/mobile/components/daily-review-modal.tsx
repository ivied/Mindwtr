import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, FlatList, Modal, TouchableOpacity, ScrollView, StyleSheet, Platform } from 'react-native';
import { router } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Calendar as CalendarIcon, Target, Inbox, Clock, Sparkles, Star, CheckCircle2, Play, ChevronDown, ChevronUp } from 'lucide-react-native';

import {
    formatFocusTaskLimitText,
    useTaskStore,
    shallow,
    isTaskInActiveProject,
    isDueForReview,
    normalizeFocusTaskLimit,
    safeFormatDate,
    safeParseDate,
    safeParseDueDate,
    shouldShowTaskForStart,
    sortTasksBy,
    tFallback,
    type ExternalCalendarEvent,
    type Task,
    type TaskSortBy,
    type TaskStatus,
} from '@mindwtr/core';

import { useTheme } from '../contexts/theme-context';
import { useLanguage } from '../contexts/language-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { SwipeableTaskItem } from './swipeable-task-item';
import { TaskEditModal } from './task-edit-modal';
import { InboxProcessingModal } from './inbox-processing-modal';
import { ErrorBoundary } from './ErrorBoundary';
import { fetchExternalCalendarEvents } from '../lib/external-calendar';

type DailyReviewStep = 'today' | 'focus' | 'inbox' | 'waiting' | 'complete';
type DailyReviewStepDefinition = {
    hasWork: boolean;
    id: DailyReviewStep;
    title: string;
    description: string;
};

interface DailyReviewModalProps {
    visible: boolean;
    onClose: () => void;
}

function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function DailyReviewFlow({ onClose }: { onClose: () => void }) {
    const { tasks, projects, settings, updateTask, deleteTask } = useTaskStore((state) => ({
        tasks: state.tasks,
        projects: state.projects,
        settings: state.settings,
        updateTask: state.updateTask,
        deleteTask: state.deleteTask,
    }), shallow);
    const { isDark } = useTheme();
    const { t } = useLanguage();
    const tc = useThemeColors();
    const filledButton = useFilledButtonColors();
    const insets = useSafeAreaInsets();

    const [currentStep, setCurrentStep] = useState<DailyReviewStep>('today');
    const [editingTask, setEditingTask] = useState<Task | null>(null);
    const [isTaskModalVisible, setIsTaskModalVisible] = useState(false);
    const [showInboxProcessing, setShowInboxProcessing] = useState(false);
    const [externalEvents, setExternalEvents] = useState<ExternalCalendarEvent[]>([]);
    const [externalLoading, setExternalLoading] = useState(false);
    const [externalError, setExternalError] = useState<string | null>(null);
    const [calendarExpanded, setCalendarExpanded] = useState(true);

    const sortBy = (settings?.taskSortBy ?? 'default') as TaskSortBy;
    const includeFocusStep = settings.gtd?.dailyReview?.includeFocusStep !== false;
    const focusTaskLimit = normalizeFocusTaskLimit(settings.gtd?.focusTaskLimit);
    const showFutureStarts = settings?.appearance?.showFutureStarts === true;
    const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

    const today = useMemo(() => new Date(), []);
    const followUpTodayReviewAt = useMemo(
        () => new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString(),
        [today],
    );
    const tomorrow = useMemo(() => {
        const d = new Date(today);
        d.setDate(d.getDate() + 1);
        return d;
    }, [today]);
    const followUpTodayLabel = tFallback(t, 'dailyReview.followUpToday', 'Follow up today');
    const reviewDueLabel = tFallback(t, 'agenda.reviewDue', 'Review Due');

    useEffect(() => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const loadEvents = async () => {
            setExternalLoading(true);
            setExternalError(null);
            try {
                const start = new Date(today);
                start.setHours(0, 0, 0, 0);
                const end = new Date(start);
                end.setDate(end.getDate() + 2);
                end.setMilliseconds(-1);
                const { events } = await fetchExternalCalendarEvents(start, end, {
                    signal: controller?.signal,
                    timeoutMs: 15_000,
                });
                if (controller?.signal.aborted) return;
                setExternalEvents(events);
            } catch (error) {
                if (controller?.signal.aborted) return;
                setExternalError(error instanceof Error ? error.message : String(error));
                setExternalEvents([]);
            } finally {
                if (!controller?.signal.aborted) setExternalLoading(false);
            }
        };
        loadEvents();
        return () => {
            controller?.abort(new Error('Daily review calendar fetch cancelled'));
        };
    }, [today]);

    const getExternalEventsForDate = (date: Date) => {
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        return externalEvents
            .filter((event) => {
                const eventStart = safeParseDate(event.start);
                const eventEnd = safeParseDate(event.end);
                if (!eventStart || !eventEnd) return false;
                return eventStart.getTime() < end.getTime() && eventEnd.getTime() > start.getTime();
            })
            .sort((a, b) => {
                const aStart = safeParseDate(a.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                const bStart = safeParseDate(b.start)?.getTime() ?? Number.POSITIVE_INFINITY;
                return aStart - bStart;
            });
    };
    const todayEvents = useMemo(() => getExternalEventsForDate(today), [externalEvents, today]);
    const tomorrowEvents = useMemo(() => getExternalEventsForDate(tomorrow), [externalEvents, tomorrow]);

    const activeTasks = useMemo(
        () => tasks.filter((task) => (
            !task.deletedAt
            && task.status !== 'done'
            && task.status !== 'reference'
            && isTaskInActiveProject(task, projectById)
        )),
        [projectById, tasks],
    );

    const inboxTasks = useMemo(
        () => activeTasks.filter((task) => task.status === 'inbox'),
        [activeTasks],
    );

    const focusedTasks = useMemo(
        () => activeTasks.filter((task) => (
            task.isFocusedToday
            && task.status !== 'done'
            && shouldShowTaskForStart(task, { showFutureStarts })
        )),
        [activeTasks, showFutureStarts],
    );

    const focusCandidates = useMemo(() => {
        const now = new Date();
        const todayStr = now.toDateString();
        const byId = new Map<string, Task>();
        const addCandidate = (task: Task) => {
            if (!byId.has(task.id)) byId.set(task.id, task);
        };
        activeTasks.forEach((task) => {
            if (task.isFocusedToday && shouldShowTaskForStart(task, { showFutureStarts })) addCandidate(task);
            const due = safeParseDueDate(task.dueDate);
            if (due && (due < now || due.toDateString() === todayStr)) {
                addCandidate(task);
                return;
            }
            if (task.status === 'next') {
                const start = safeParseDate(task.startTime);
                if (start && start > now) return;
                addCandidate(task);
                return;
            }
            if ((task.status === 'waiting' || task.status === 'someday') && isDueForReview(task.reviewAt, now)) {
                addCandidate(task);
            }
        });
        return sortTasksBy(Array.from(byId.values()), sortBy);
    }, [activeTasks, showFutureStarts, sortBy]);

    const dueTodayTasks = useMemo(() => {
        const dueToday = activeTasks.filter((task) => {
            if (task.status === 'done') return false;
            const due = safeParseDueDate(task.dueDate);
            return due ? isSameDay(due, today) : false;
        });
        return sortTasksBy(dueToday, sortBy);
    }, [activeTasks, sortBy, today]);

    const overdueTasks = useMemo(() => {
        const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const overdue = activeTasks.filter((task) => {
            if (task.status === 'done') return false;
            const due = safeParseDueDate(task.dueDate);
            return due ? due < startOfToday : false;
        });
        return sortTasksBy(overdue, sortBy);
    }, [activeTasks, sortBy, today]);

    const waitingTasks = useMemo(() => {
        const waiting = activeTasks.filter((task) => task.status === 'waiting');
        return sortTasksBy(waiting, sortBy);
    }, [activeTasks, sortBy]);

    const steps: DailyReviewStepDefinition[] = useMemo(() => {
        const todayHasWork = overdueTasks.length > 0
            || dueTodayTasks.length > 0
            || todayEvents.length > 0
            || tomorrowEvents.length > 0
            || Boolean(externalError);
        const list: DailyReviewStepDefinition[] = [
            { id: 'today', title: t('dailyReview.todayStep'), description: t('dailyReview.todayDesc'), hasWork: todayHasWork },
            { id: 'inbox', title: t('dailyReview.inboxStep'), description: t('dailyReview.inboxDesc'), hasWork: inboxTasks.length > 0 },
        ];
        if (includeFocusStep) {
            list.push({ id: 'focus', title: t('dailyReview.focusStep'), description: t('dailyReview.focusDesc'), hasWork: focusCandidates.length > 0 });
        }
        list.push(
            { id: 'waiting', title: t('dailyReview.waitingStep'), description: t('dailyReview.waitingDesc'), hasWork: waitingTasks.length > 0 },
            { id: 'complete', title: t('dailyReview.completeTitle'), description: t('dailyReview.completeDesc'), hasWork: true },
        );
        return list;
    }, [
        dueTodayTasks.length,
        externalError,
        focusCandidates.length,
        inboxTasks.length,
        includeFocusStep,
        overdueTasks.length,
        t,
        todayEvents.length,
        tomorrowEvents.length,
        waitingTasks.length,
    ]);
    const activeSteps = useMemo(
        () => steps.filter((step) => step.hasWork || step.id === 'complete'),
        [steps],
    );

    const displayedStep = activeSteps.some((step) => step.id === currentStep)
        ? currentStep
        : activeSteps[0]?.id ?? 'complete';
    const currentIndex = steps.findIndex((s) => s.id === displayedStep);
    const safeCurrentIndex = Math.max(0, currentIndex);
    const activeStepIndex = activeSteps.findIndex((step) => step.id === displayedStep);
    const progress = (safeCurrentIndex / Math.max(1, steps.length - 1)) * 100;

    useEffect(() => {
        if (activeSteps.some((step) => step.id === currentStep)) return;
        setCurrentStep(activeSteps[0]?.id ?? 'complete');
    }, [activeSteps, currentStep]);

    const next = () => {
        if (activeStepIndex < 0) {
            setCurrentStep(activeSteps[0]?.id ?? 'complete');
            return;
        }
        if (activeStepIndex < activeSteps.length - 1) setCurrentStep(activeSteps[activeStepIndex + 1].id);
    };

    const back = () => {
        if (activeStepIndex > 0) setCurrentStep(activeSteps[activeStepIndex - 1].id);
    };

    const openTask = (task: Task) => {
        setEditingTask(task);
        setIsTaskModalVisible(true);
    };

    const closeTask = () => {
        setIsTaskModalVisible(false);
        setEditingTask(null);
    };
    const handleFollowUpToday = (task: Task) => {
        void updateTask(task.id, { reviewAt: followUpTodayReviewAt });
    };
    const handleNavigateToProject = (projectId: string) => {
        closeTask();
        onClose();
        openProjectScreen(projectId);
    };
    const handleNavigateToToken = (token: string) => {
        closeTask();
        onClose();
        openContextsScreen(token);
    };

    const renderStepRail = () => (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.stepRail, { borderBottomColor: tc.border }]}
            contentContainerStyle={styles.stepRailContent}
        >
            {steps.map((step, index) => {
                const skipped = !step.hasWork && step.id !== 'complete';
                const complete = skipped || index < safeCurrentIndex;
                const current = step.id === displayedStep;
                return (
                    <View
                        key={step.id}
                        style={[
                            styles.stepRailItem,
                            {
                                backgroundColor: current
                                    ? `${tc.tint}1A`
                                    : complete
                                        ? `${tc.success}1A`
                                        : tc.filterBg,
                                borderColor: current
                                    ? tc.tint
                                    : complete
                                        ? `${tc.success}66`
                                        : tc.border,
                            },
                        ]}
                    >
                        <View
                            style={[
                                styles.stepRailBadge,
                                {
                                    backgroundColor: current
                                        ? tc.tint
                                        : complete
                                            ? tc.success
                                            : tc.border,
                                },
                            ]}
                        >
                            {complete ? (
                                <CheckCircle2 size={12} color="#FFFFFF" strokeWidth={2.8} />
                            ) : (
                                <Text style={styles.stepRailBadgeText}>{index + 1}</Text>
                            )}
                        </View>
                        <Text
                            style={[styles.stepRailText, { color: current ? tc.text : tc.secondaryText }]}
                            numberOfLines={1}
                        >
                            {step.title}
                        </Text>
                    </View>
                );
            })}
        </ScrollView>
    );

    const renderTaskList = (list: Task[], options?: { showFocusToggle?: boolean; hideStatusBadge?: boolean; showFollowUpToday?: boolean }) => (
        <FlatList
            data={list}
            renderItem={({ item: task }) => {
                const taskRow = (
                    <SwipeableTaskItem
                        task={task}
                        isDark={isDark}
                        tc={tc}
                        onPress={() => openTask(task)}
                        onStatusChange={(status) => updateTask(task.id, { status: status as TaskStatus })}
                        onDelete={() => { void deleteTask(task.id); }}
                        showFocusToggle={options?.showFocusToggle}
                        hideStatusBadge={options?.hideStatusBadge}
                    />
                );
                if (!options?.showFollowUpToday) return taskRow;
                const reviewDue = isDueForReview(task.reviewAt, today);
                return (
                    <View style={styles.waitingTaskActionItem}>
                        {taskRow}
                        <TouchableOpacity
                            style={[
                                styles.followUpButton,
                                { borderColor: tc.border, backgroundColor: tc.cardBg, opacity: reviewDue ? 0.65 : 1 },
                            ]}
                            onPress={() => handleFollowUpToday(task)}
                            disabled={reviewDue}
                            hitSlop={6}
                            accessibilityRole="button"
                            accessibilityLabel={`${followUpTodayLabel}: ${task.title}`}
                        >
                            <Clock size={14} color={tc.tint} strokeWidth={2.2} />
                            <Text style={[styles.followUpButtonText, { color: tc.text }]}>
                                {reviewDue ? reviewDueLabel : followUpTodayLabel}
                            </Text>
                        </TouchableOpacity>
                    </View>
                );
            }}
            keyExtractor={(task) => task.id}
            style={styles.taskList}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            updateCellsBatchingPeriod={50}
            removeClippedSubviews={false}
            showsVerticalScrollIndicator={false}
        />
    );

    const renderExternalEventList = (events: ExternalCalendarEvent[]) => {
        if (externalLoading) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{t('common.loading')}</Text>;
        }
        if (externalError) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{externalError}</Text>;
        }
        if (events.length === 0) {
            return <Text style={[styles.eventMeta, { color: tc.secondaryText }]}>{t('calendar.noTasks')}</Text>;
        }
        return (
            <View style={styles.eventList}>
                {events.slice(0, 5).map((event) => {
                    const start = safeParseDate(event.start);
                    const end = safeParseDate(event.end);
                    const timeLabel = event.allDay || !start || !end
                        ? t('calendar.allDay')
                        : `${safeFormatDate(start, 'p')} - ${safeFormatDate(end, 'p')}`;
                    return (
                        <View key={`${event.sourceId}-${event.id}-${event.start}`} style={styles.eventRow}>
                            <Text style={[styles.eventTitle, { color: tc.text }]} numberOfLines={1}>
                                {event.title}
                            </Text>
                            <Text style={[styles.eventMeta, { color: tc.secondaryText }]} numberOfLines={1}>
                                {timeLabel}
                            </Text>
                        </View>
                    );
                })}
            </View>
        );
    };

    const renderStep = () => {
        switch (displayedStep) {
            case 'today': {
                const topTasks = [...overdueTasks, ...dueTodayTasks].slice(0, 8);
                const totalToday = overdueTasks.length + dueTodayTasks.length;
                const calendarEventCount = todayEvents.length + tomorrowEvents.length;
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <CalendarIcon size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>{t('dailyReview.todayStep')}</Text>
                        </View>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{totalToday}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.todayDesc')}</Text>
                        </View>
                        <View style={styles.calendarSection}>
                            <TouchableOpacity
                                style={[styles.calendarToggleButton, { backgroundColor: tc.cardBg, borderColor: tc.border }]}
                                onPress={() => setCalendarExpanded((expanded) => !expanded)}
                                activeOpacity={0.75}
                                accessibilityRole="button"
                                accessibilityState={{ expanded: calendarExpanded }}
                                accessibilityLabel={t('calendar.events')}
                            >
                                <View style={styles.calendarToggleTitle}>
                                    <CalendarIcon size={16} color={tc.secondaryText} strokeWidth={2} />
                                    <Text style={[styles.calendarToggleText, { color: tc.text }]}>
                                        {t('calendar.events')}
                                    </Text>
                                    <View style={[styles.calendarCountBadge, { backgroundColor: tc.filterBg }]}>
                                        <Text style={[styles.calendarCountText, { color: tc.secondaryText }]}>
                                            {calendarEventCount}
                                        </Text>
                                    </View>
                                </View>
                                {calendarExpanded ? (
                                    <ChevronUp size={18} color={tc.secondaryText} strokeWidth={2} />
                                ) : (
                                    <ChevronDown size={18} color={tc.secondaryText} strokeWidth={2} />
                                )}
                            </TouchableOpacity>
                            {calendarExpanded && (
                                <View style={styles.calendarGrid}>
                                    <View style={[styles.calendarCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                        <Text style={[styles.calendarCardTitle, { color: tc.secondaryText }]}>
                                            {safeFormatDate(today, 'P')} · {t('calendar.events')}
                                        </Text>
                                        {renderExternalEventList(todayEvents)}
                                    </View>
                                    <View style={[styles.calendarCard, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                                        <Text style={[styles.calendarCardTitle, { color: tc.secondaryText }]}>
                                            {safeFormatDate(tomorrow, 'P')} · {t('calendar.events')}
                                        </Text>
                                        {renderExternalEventList(tomorrowEvents)}
                                    </View>
                                </View>
                            )}
                        </View>
                        {topTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Sparkles size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('agenda.noTasks')}</Text>
                            </View>
                        ) : (
                            renderTaskList(topTasks)
                        )}
                    </View>
                );
            }
            case 'focus':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Target size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>{t('dailyReview.focusStep')}</Text>
                        </View>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{focusedTasks.length}</Text> {t('dailyReview.focusSelected')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.focusDesc')}</Text>
                        </View>
                        {focusCandidates.length === 0 ? (
                            <View style={styles.emptyState}>
                                <Star size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>
                                    {formatFocusTaskLimitText(t('agenda.focusHint'), focusTaskLimit)}
                                </Text>
                            </View>
                        ) : (
                            renderTaskList(focusCandidates.slice(0, 8), { showFocusToggle: true, hideStatusBadge: true })
                        )}
                    </View>
                );
            case 'inbox':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Inbox size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>{t('dailyReview.inboxStep')}</Text>
                        </View>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{inboxTasks.length}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.inboxDesc')}</Text>
                        </View>
                        {inboxTasks.length > 0 && (
                            <TouchableOpacity
                                style={[styles.processButton, { backgroundColor: filledButton.backgroundColor }]}
                                onPress={() => setShowInboxProcessing(true)}
                                hitSlop={8}
                                accessibilityRole="button"
                                accessibilityLabel={t('inbox.processButton')}
                            >
                                <Play size={14} color={filledButton.textColor ?? '#FFFFFF'} strokeWidth={2.5} fill={filledButton.textColor ?? '#FFFFFF'} />
                                <Text style={[styles.processButtonText, filledButton.textColor ? { color: filledButton.textColor } : null]}>
                                    {t('inbox.processButton')}
                                </Text>
                            </TouchableOpacity>
                        )}
                        {inboxTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.inboxEmpty')}</Text>
                            </View>
                        ) : (
                            renderTaskList(inboxTasks.slice(0, 8))
                        )}
                    </View>
                );
            case 'waiting':
                return (
                    <View style={styles.stepContent}>
                        <View style={styles.stepTitleRow}>
                            <Clock size={22} color={tc.text} strokeWidth={2} />
                            <Text style={[styles.stepTitleInline, { color: tc.text }]}>{t('dailyReview.waitingStep')}</Text>
                        </View>
                        <View style={[styles.infoBox, { backgroundColor: tc.cardBg, borderColor: tc.border }]}>
                            <Text style={[styles.infoText, { color: tc.text }]}>
                                <Text style={{ fontWeight: '700' }}>{waitingTasks.length}</Text> {t('common.tasks')}
                            </Text>
                            <Text style={[styles.guideText, { color: tc.secondaryText }]}>{t('dailyReview.waitingDesc')}</Text>
                        </View>
                        {waitingTasks.length === 0 ? (
                            <View style={styles.emptyState}>
                                <CheckCircle2 size={48} color={tc.secondaryText} strokeWidth={1.5} style={styles.emptyIcon} />
                                <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{t('review.waitingEmpty')}</Text>
                            </View>
                        ) : (
                            renderTaskList(waitingTasks.slice(0, 8), { showFollowUpToday: true })
                        )}
                    </View>
                );
            case 'complete':
                return (
                    <View style={styles.centerContent}>
                        <CheckCircle2 size={56} color={tc.tint} strokeWidth={1.5} style={styles.bigIcon} />
                        <Text style={[styles.heading, { color: tc.text }]}>{t('dailyReview.completeTitle')}</Text>
                        <Text style={[styles.description, { color: tc.secondaryText }]}>{t('dailyReview.completeDesc')}</Text>
                        <TouchableOpacity style={[styles.primaryButton, { backgroundColor: filledButton.backgroundColor }]} onPress={onClose}>
                            <Text style={[styles.primaryButtonText, filledButton.textColor ? { color: filledButton.textColor } : null]}>{t('review.finish')}</Text>
                        </TouchableOpacity>
                    </View>
                );
            default:
                return null;
        }
    };

    return (
        <GestureHandlerRootView
            style={[styles.modalContainer, { backgroundColor: tc.bg }]}
        >
            <SafeAreaView style={[styles.modalContainer, { backgroundColor: tc.bg }]} edges={['top']}>
                <View style={[styles.header, { borderBottomColor: tc.border }]}>
                    <TouchableOpacity
                        onPress={onClose}
                        style={styles.closeButton}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                        hitSlop={8}
                    >
                        <X size={22} color={tc.text} strokeWidth={2} />
                    </TouchableOpacity>
                    <View style={styles.headerCenter}>
                        <Text style={[styles.headerTitle, { color: tc.text }]}>{t('dailyReview.title')}</Text>
                        <Text style={[styles.headerStep, { color: tc.secondaryText }]}>
                            {t('review.step')} {Math.max(1, currentIndex + 1)} {t('review.of')} {steps.length}
                        </Text>
                    </View>
                    <View style={{ width: 28 }} />
                </View>

                <View style={[styles.progressTrack, { backgroundColor: tc.border }]}>
                    <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: tc.tint }]} />
                </View>
                {renderStepRail()}

                <View style={styles.content}>{renderStep()}</View>

                {displayedStep !== 'complete' && (
                    <View
                        style={[
                            styles.footer,
                            {
                                borderTopColor: tc.border,
                                backgroundColor: tc.cardBg,
                                paddingBottom: 14 + Math.max(insets.bottom, 8),
                            },
                        ]}
                    >
                        <TouchableOpacity
                            onPress={back}
                            disabled={activeStepIndex <= 0}
                            style={[styles.footerButton, { backgroundColor: tc.filterBg, opacity: activeStepIndex <= 0 ? 0.5 : 1 }]}
                        >
                            <Text style={[styles.footerButtonText, { color: tc.text }]}>{t('review.back')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={next} style={[styles.footerButton, { backgroundColor: filledButton.backgroundColor }]}>
                            <Text style={[styles.footerPrimaryText, filledButton.textColor ? { color: filledButton.textColor } : null]}>{t('review.nextStepBtn')}</Text>
                        </TouchableOpacity>
                    </View>
                )}
                <ErrorBoundary>
                    <InboxProcessingModal
                        visible={showInboxProcessing}
                        onClose={() => setShowInboxProcessing(false)}
                    />
                </ErrorBoundary>

                <ErrorBoundary>
                    <TaskEditModal
                        visible={isTaskModalVisible}
                        task={editingTask}
                        onClose={closeTask}
                        onSave={(taskId, updates) => {
                            updateTask(taskId, updates);
                            closeTask();
                        }}
                        defaultTab="view"
                        onProjectNavigate={handleNavigateToProject}
                        onContextNavigate={handleNavigateToToken}
                        onTagNavigate={handleNavigateToToken}
                        onFocusMode={(taskId) => {
                            closeTask();
                            router.push(`/check-focus?id=${taskId}`);
                        }}
                    />
                </ErrorBoundary>
            </SafeAreaView>
        </GestureHandlerRootView>
    );
}

export function DailyReviewModal({ visible, onClose }: DailyReviewModalProps) {
    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
            allowSwipeDismissal
            onRequestClose={onClose}
        >
            <DailyReviewFlow onClose={onClose} />
        </Modal>
    );
}

export function DailyReviewScreen({ onClose }: { onClose: () => void }) {
    return <DailyReviewFlow onClose={onClose} />;
}

const styles = StyleSheet.create({
    modalContainer: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
    },
    closeButton: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerCenter: {
        alignItems: 'center',
        flex: 1,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: '700',
    },
    headerStep: {
        fontSize: 12,
        marginTop: 2,
    },
    progressTrack: {
        height: 3,
        width: '100%',
    },
    progressFill: {
        height: '100%',
    },
    stepRail: {
        borderBottomWidth: 1,
        maxHeight: 48,
    },
    stepRailContent: {
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    stepRailItem: {
        minWidth: 104,
        maxWidth: 148,
        height: 32,
        borderRadius: 999,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
    },
    stepRailBadge: {
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: 'center',
        justifyContent: 'center',
    },
    stepRailBadgeText: {
        color: '#FFFFFF',
        fontSize: 10,
        fontWeight: '800',
    },
    stepRailText: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        fontWeight: '700',
    },
    content: {
        flex: 1,
        padding: 20,
    },
    centerContent: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
        gap: 14,
    },
    bigIcon: {
        marginBottom: 6,
    },
    heading: {
        fontSize: 24,
        fontWeight: '800',
        textAlign: 'center',
    },
    description: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        maxWidth: 320,
    },
    primaryButton: {
        paddingHorizontal: 18,
        paddingVertical: 12,
        borderRadius: 12,
        marginTop: 8,
    },
    primaryButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
    },
    stepContent: {
        flex: 1,
        gap: 14,
    },
    stepTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    stepTitleInline: {
        fontSize: 18,
        fontWeight: '800',
    },
    infoBox: {
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        gap: 8,
    },
    infoText: {
        fontSize: 14,
        fontWeight: '700',
    },
    guideText: {
        fontSize: 13,
        lineHeight: 18,
    },
    calendarGrid: {
        gap: 10,
    },
    calendarSection: {
        gap: 10,
    },
    calendarToggleButton: {
        minHeight: 44,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    calendarToggleTitle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
        minWidth: 0,
    },
    calendarToggleText: {
        fontSize: 13,
        fontWeight: '700',
        flexShrink: 1,
    },
    calendarCountBadge: {
        minWidth: 28,
        height: 24,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
    },
    calendarCountText: {
        fontSize: 12,
        fontWeight: '700',
    },
    calendarCard: {
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        gap: 8,
    },
    calendarCardTitle: {
        fontSize: 11,
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
    },
    eventList: {
        gap: 6,
    },
    eventRow: {
        gap: 2,
    },
    eventTitle: {
        fontSize: 13,
        fontWeight: '600',
    },
    eventMeta: {
        fontSize: 12,
    },
    processButton: {
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    processButtonText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '700',
    },
    quickActions: {
        flexDirection: 'row',
        gap: 10,
        marginTop: 4,
    },
    actionButton: {
        borderWidth: 1,
        borderRadius: 999,
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    actionButtonText: {
        fontSize: 13,
        fontWeight: '600',
    },
    taskList: {
        flex: 1,
    },
    waitingTaskActionItem: {
        gap: 8,
    },
    followUpButton: {
        alignSelf: 'flex-start',
        minHeight: 36,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    followUpButtonText: {
        fontSize: 12,
        fontWeight: '700',
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 30,
        gap: 10,
    },
    emptyIcon: {
        opacity: 0.9,
    },
    emptyText: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
    },
    footer: {
        flexDirection: 'row',
        gap: 12,
        padding: 14,
        borderTopWidth: 1,
    },
    footerButton: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    footerButtonText: {
        fontSize: 14,
        fontWeight: '700',
    },
    footerPrimaryText: {
        fontSize: 14,
        fontWeight: '700',
        color: '#FFFFFF',
    },
});
