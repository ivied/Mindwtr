import React from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { translateWithFallback } from '@mindwtr/core';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { CheckCircle2, Pencil, Plus, Sparkles } from 'lucide-react-native';

import { styles } from './task-list.styles';
import { FocusStarIcon } from '../FocusStarIcon';

type ThemeColors = {
  border: string;
  inputBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

type TriggerState = { end: number; query: string; start: number; type: 'project' | 'context' };
type Option =
  | { kind: 'create'; label: string; value: string }
  | { kind: 'project'; label: string; value: string }
  | { kind: 'context'; label: string; value: string };

type TaskListQuickAddProps = {
  aiEnabled: boolean;
  applyTypeaheadOption: (option: Option) => void | Promise<void>;
  copilotApplied: boolean;
  copilotContext?: string;
  copilotSuggestion: { context?: string; tags?: string[] } | null;
  copilotTags: string[];
  copilotThinking: boolean;
  enableCopilot: boolean;
  handleAddAndEditTask?: () => void | Promise<void>;
  handleAddTask: () => void | Promise<void>;
  focusNewTask: boolean;
  canFocusNewTask: boolean;
  focusNewTaskDisabledReason?: string;
  inputRef?: React.RefObject<TextInput | null>;
  newTaskTitle: string;
  onApplyCopilot: () => void;
  onChangeText: (text: string) => void;
  onInputFocus?: (targetInput?: number | string) => void;
  onSelectionChange: (selection: { end: number; start: number }) => void;
  onToggleFocusNewTask: () => void;
  projectId?: string;
  setTypeaheadIndex: (index: number) => void;
  showQuickAddHelp: boolean;
  t: (key: string) => string;
  themeColors: ThemeColors;
  title: string;
  trailingAccessory?: React.ReactNode;
  trigger: TriggerState | null;
  typeaheadIndex: number;
  typeaheadOpen: boolean;
  typeaheadOptions: Option[];
};

export function TaskListQuickAdd({
  aiEnabled,
  applyTypeaheadOption,
  copilotApplied,
  copilotContext,
  copilotSuggestion,
  copilotTags,
  copilotThinking,
  enableCopilot,
  handleAddAndEditTask,
  handleAddTask,
  focusNewTask,
  canFocusNewTask,
  focusNewTaskDisabledReason,
  inputRef,
  newTaskTitle,
  onApplyCopilot,
  onChangeText,
  onInputFocus,
  onSelectionChange,
  onToggleFocusNewTask,
  projectId,
  setTypeaheadIndex,
  showQuickAddHelp,
  t,
  themeColors,
  title,
  trailingAccessory,
  trigger,
  typeaheadIndex,
  typeaheadOpen,
  typeaheadOptions,
}: TaskListQuickAddProps) {
  const filledButton = useFilledButtonColors();
  const resolveText = (key: string, fallback: string) => {
    return translateWithFallback(t, key, fallback);
  };
  const addTaskLabel = resolveText('nav.addTask', 'Add Task');
  const editLabel = resolveText('common.edit', 'Edit');
  const addAndEditTaskLabel = `${addTaskLabel} / ${editLabel}`;
  const inputLabel = title ? `${addTaskLabel}: ${title}` : resolveText('quickAdd.inputLabel', 'Task title');
  const inputHint = resolveText('quickAdd.inputHint', 'Type a task title, then press add or the return key.');
  const addDisabled = !newTaskTitle.trim();
  const focusDisabled = !focusNewTask && !canFocusNewTask;
  const focusLabel = focusNewTask
    ? resolveText('agenda.removeFromFocus', "Remove from today's focus")
    : (focusDisabled ? (focusNewTaskDisabledReason || resolveText('agenda.addToFocus', "Add to today's focus")) : resolveText('agenda.addToFocus', "Add to today's focus"));

  return (
    <>
      <View style={[styles.inputContainer, { borderBottomColor: themeColors.border }]}>
        <TextInput
          ref={inputRef}
          style={[styles.input, { backgroundColor: themeColors.inputBg, borderColor: themeColors.border, color: themeColors.text }]}
          autoCapitalize="sentences"
          autoCorrect={false}
          placeholder={projectId ? t('projects.addTaskPlaceholder') : t('inbox.addPlaceholder')}
          placeholderTextColor={themeColors.secondaryText}
          value={newTaskTitle}
          onChangeText={(text) => {
            onChangeText(text);
            setTypeaheadIndex(0);
          }}
          onSelectionChange={(event) => {
            const selection = event.nativeEvent.selection;
            onSelectionChange(selection);
          }}
          onFocus={(event) => {
            onInputFocus?.(event.nativeEvent.target);
          }}
          blurOnSubmit={false}
          onSubmitEditing={() => { void handleAddTask(); }}
          returnKeyType="done"
          accessibilityLabel={inputLabel}
          accessibilityHint={inputHint}
        />
        {trailingAccessory}
        <TouchableOpacity
          onPress={onToggleFocusNewTask}
          style={[
            styles.addAndEditButton,
            { backgroundColor: themeColors.inputBg, borderColor: focusNewTask ? themeColors.tint : themeColors.border },
            focusDisabled && styles.addButtonDisabled,
          ]}
          disabled={focusDisabled}
          accessibilityLabel={focusLabel}
          accessibilityRole="button"
          accessibilityState={{ selected: focusNewTask, disabled: focusDisabled }}
          activeOpacity={0.85}
          hitSlop={8}
        >
          <FocusStarIcon
            focused={focusNewTask}
            inactiveColor={themeColors.secondaryText}
            disabled={focusDisabled}
            size={20}
          />
        </TouchableOpacity>
        {handleAddAndEditTask ? (
          <TouchableOpacity
            onPress={() => { void handleAddAndEditTask(); }}
            style={[
              styles.addAndEditButton,
              { backgroundColor: themeColors.inputBg, borderColor: themeColors.border },
              addDisabled && styles.addButtonDisabled,
            ]}
            disabled={addDisabled}
            accessibilityLabel={addAndEditTaskLabel}
            accessibilityRole="button"
            accessibilityState={{ disabled: addDisabled }}
            activeOpacity={0.85}
            hitSlop={8}
          >
            <Pencil size={20} color={themeColors.tint} strokeWidth={2.4} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={() => { void handleAddTask(); }}
          style={[
            styles.addButton,
            { backgroundColor: filledButton.backgroundColor },
            addDisabled && styles.addButtonDisabled,
          ]}
          disabled={addDisabled}
          accessibilityLabel={addTaskLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: addDisabled }}
          activeOpacity={0.85}
          hitSlop={8}
        >
          <Plus size={22} color={filledButton.textColor ?? themeColors.onTint} strokeWidth={2.6} />
        </TouchableOpacity>
      </View>
      {typeaheadOpen && trigger && typeaheadOptions.length > 0 && (
        <View style={[styles.typeaheadContainer, { backgroundColor: themeColors.inputBg, borderColor: themeColors.border }]}>
          {typeaheadOptions.map((option, index) => (
            <TouchableOpacity
              key={`${option.kind}:${option.value}`}
              onPress={() => applyTypeaheadOption(option)}
              style={[
                styles.typeaheadRow,
                index === typeaheadIndex && { backgroundColor: themeColors.border },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: index === typeaheadIndex }}
              activeOpacity={0.78}
            >
              {option.kind === 'create' && (
                <Sparkles size={14} color={themeColors.tint} strokeWidth={2} />
              )}
              <Text style={[styles.typeaheadText, { color: themeColors.text }]}>
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      {enableCopilot && aiEnabled && copilotSuggestion && !copilotApplied && (
        <TouchableOpacity
          style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}
          onPress={onApplyCopilot}
          accessibilityRole="button"
          activeOpacity={0.82}
        >
          <View style={[styles.copilotIcon, { backgroundColor: themeColors.tint }]}>
            <Sparkles size={14} color={themeColors.onTint} strokeWidth={2.2} />
          </View>
          <View style={styles.copilotContent}>
            <Text style={[styles.copilotText, { color: themeColors.text }]}>
              {t('copilot.suggested')}{' '}
              {copilotSuggestion.context ? `${copilotSuggestion.context} ` : ''}
              {copilotSuggestion.tags?.length ? copilotSuggestion.tags.join(' ') : ''}
            </Text>
            <Text style={[styles.copilotHint, { color: themeColors.secondaryText }]}>
              {t('copilot.applyHint')}
            </Text>
          </View>
        </TouchableOpacity>
      )}
      {enableCopilot && aiEnabled && copilotThinking && !copilotSuggestion && !copilotApplied && (
        <View style={[styles.copilotPill, styles.copilotLoadingRow, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
          <ActivityIndicator size="small" color={themeColors.tint} />
          <View style={styles.copilotContent}>
            <Text style={[styles.copilotHint, { color: themeColors.secondaryText, marginTop: 0 }]}>
              {t('common.loading')}
            </Text>
          </View>
        </View>
      )}
      {enableCopilot && aiEnabled && copilotApplied && (
        <View style={[styles.copilotPill, { borderColor: themeColors.border, backgroundColor: themeColors.inputBg }]}>
          <View style={[styles.copilotIcon, { backgroundColor: themeColors.tint }]}>
            <CheckCircle2 size={14} color={themeColors.onTint} strokeWidth={2.2} />
          </View>
          <View style={styles.copilotContent}>
            <Text style={[styles.copilotText, { color: themeColors.text }]}>
              {t('copilot.applied')}{' '}
              {copilotContext ? `${copilotContext} ` : ''}
              {copilotTags.length ? copilotTags.join(' ') : ''}
            </Text>
          </View>
        </View>
      )}
      {showQuickAddHelp && !projectId && (
        <Text style={[styles.quickAddHelp, { color: themeColors.secondaryText }]}>
          {t('quickAdd.help')}
        </Text>
      )}
    </>
  );
}
