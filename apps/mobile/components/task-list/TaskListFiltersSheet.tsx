import React from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import type { MultiValueFilterMatchMode, TaskEnergyLevel, TaskPriority, TimeEstimate } from '@mindwtr/core';
import { X } from 'lucide-react-native';

import { MOBILE_TIME_ESTIMATE_OPTIONS, formatTimeEstimateChipLabel } from '../time-estimate-filter-utils';
import { styles } from './task-list.styles';

type ThemeColors = {
  bg: string;
  border: string;
  cardBg: string;
  filterBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

type TaskListFiltersSheetProps = {
  energyLevelOptions: TaskEnergyLevel[];
  extraContent?: React.ReactNode;
  hasFilters: boolean;
  contextMatchMode: MultiValueFilterMatchMode;
  contextMatchModeLabels: {
    title: string;
    any: string;
    all: string;
  };
  locationQuery: string;
  onChangeContextMatchMode: (value: MultiValueFilterMatchMode) => void;
  onChangeLocationQuery: (value: string) => void;
  onChangeSearchQuery: (value: string) => void;
  onClearFilters: () => void;
  onClose: () => void;
  showEnergyLevelFilters: boolean;
  showPriorityFilters: boolean;
  priorityOptions: TaskPriority[];
  searchQuery: string;
  selectedEnergyLevels: TaskEnergyLevel[];
  selectedPriorities: TaskPriority[];
  selectedTimeEstimates: TimeEstimate[];
  selectedTokens: string[];
  showContextMatchMode: boolean;
  showLocationFilter: boolean;
  showTimeEstimateFilters: boolean;
  t: (key: string) => string;
  themeColors: ThemeColors;
  timeEstimateOptions?: TimeEstimate[];
  toggleEnergyLevel: (value: TaskEnergyLevel) => void;
  togglePriority: (value: TaskPriority) => void;
  toggleTimeEstimate: (value: TimeEstimate) => void;
  toggleToken: (value: string) => void;
  tokenOptions: string[];
  visible: boolean;
};

const resolveText = (t: (key: string) => string, key: string, fallback: string): string => {
  const value = t(key);
  return value === key ? fallback : value;
};

export function TaskListFiltersSheet({
  energyLevelOptions,
  extraContent,
  hasFilters,
  contextMatchMode,
  contextMatchModeLabels,
  locationQuery,
  onChangeContextMatchMode,
  onChangeLocationQuery,
  onChangeSearchQuery,
  onClearFilters,
  onClose,
  showEnergyLevelFilters,
  showPriorityFilters,
  priorityOptions,
  searchQuery,
  selectedEnergyLevels,
  selectedPriorities,
  selectedTimeEstimates,
  selectedTokens,
  showContextMatchMode,
  showLocationFilter,
  showTimeEstimateFilters,
  t,
  themeColors,
  timeEstimateOptions = MOBILE_TIME_ESTIMATE_OPTIONS,
  toggleEnergyLevel,
  togglePriority,
  toggleTimeEstimate,
  toggleToken,
  tokenOptions,
  visible,
}: TaskListFiltersSheetProps) {
  const renderChip = (label: string, selected: boolean, onPress: () => void, key = label) => (
    <TouchableOpacity
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.taskFilterChip,
        {
          backgroundColor: selected ? themeColors.tint : themeColors.filterBg,
          borderColor: selected ? themeColors.tint : themeColors.border,
        },
      ]}
    >
      <Text style={[styles.taskFilterChipText, { color: selected ? themeColors.onTint : themeColors.text }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <Modal
      animationType="fade"
      accessibilityViewIsModal
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <View style={styles.taskFilterSheetRoot}>
        <Pressable
          accessibilityLabel={resolveText(t, 'common.close', 'Close')}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.taskFilterSheetBackdrop}
        />
        <View
          accessibilityLabel={resolveText(t, 'filters.label', 'Filters')}
          style={[styles.taskFilterSheet, { backgroundColor: themeColors.cardBg, borderColor: themeColors.border }]}
        >
          <View style={styles.taskFilterSheetHeader}>
            <Text style={[styles.taskFilterSheetTitle, { color: themeColors.text }]}>
              {resolveText(t, 'filters.label', 'Filters')}
            </Text>
            <View style={styles.taskFilterSheetHeaderActions}>
              {hasFilters ? (
                <TouchableOpacity accessibilityRole="button" onPress={onClearFilters} style={styles.taskFilterTextButton}>
                  <Text style={[styles.taskFilterTextButtonText, { color: themeColors.tint }]}>
                    {resolveText(t, 'filters.clear', 'Clear')}
                  </Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                accessibilityLabel={resolveText(t, 'common.close', 'Close')}
                accessibilityRole="button"
                onPress={onClose}
                style={styles.taskFilterIconButton}
              >
                <X size={18} color={themeColors.secondaryText} />
              </TouchableOpacity>
            </View>
          </View>

          <ScrollView
            contentContainerStyle={styles.taskFilterSheetContent}
            showsVerticalScrollIndicator={false}
            style={styles.taskFilterSheetScroll}
          >
            <Text style={[styles.taskFilterSectionLabel, { color: themeColors.secondaryText }]}>
              {resolveText(t, 'common.search', 'Search')}
            </Text>
            <TextInput
              accessibilityLabel={resolveText(t, 'common.search', 'Search')}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={onChangeSearchQuery}
              placeholder={resolveText(t, 'search.placeholder', 'Search tasks')}
              placeholderTextColor={themeColors.secondaryText}
              returnKeyType="search"
              style={[styles.taskFilterInput, { backgroundColor: themeColors.bg, borderColor: themeColors.border, color: themeColors.text }]}
              value={searchQuery}
            />

            {extraContent}

            {tokenOptions.length > 0 ? (
              <>
                <Text style={[styles.taskFilterSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText(t, 'filters.contexts', 'Contexts & tags')}
                </Text>
                <View style={styles.taskFilterChipRow}>
                  {tokenOptions.map((token) => renderChip(token, selectedTokens.includes(token), () => toggleToken(token), `token:${token}`))}
                </View>
                {showContextMatchMode ? (
                  <View style={styles.taskFilterMatchModeRow}>
                    <Text style={[styles.taskFilterMatchModeLabel, { color: themeColors.secondaryText }]}>
                      {contextMatchModeLabels.title}
                    </Text>
                    <View style={[styles.taskFilterMatchModeControl, { borderColor: themeColors.border, backgroundColor: themeColors.filterBg }]}>
                      {(['any', 'all'] as const).map((mode) => (
                        <TouchableOpacity
                          key={mode}
                          accessibilityRole="button"
                          accessibilityState={{ selected: contextMatchMode === mode }}
                          onPress={() => onChangeContextMatchMode(mode)}
                          style={[
                            styles.taskFilterMatchModeButton,
                            { backgroundColor: contextMatchMode === mode ? themeColors.tint : 'transparent' },
                          ]}
                        >
                          <Text
                            style={[
                              styles.taskFilterMatchModeButtonText,
                              { color: contextMatchMode === mode ? themeColors.onTint : themeColors.secondaryText },
                            ]}
                          >
                            {mode === 'any' ? contextMatchModeLabels.any : contextMatchModeLabels.all}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </View>
                ) : null}
              </>
            ) : null}

            {showPriorityFilters ? (
              <>
                <Text style={[styles.taskFilterSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText(t, 'filters.priority', 'Priority')}
                </Text>
                <View style={styles.taskFilterChipRow}>
                  {priorityOptions.map((priority) => (
                    renderChip(t(`priority.${priority}`), selectedPriorities.includes(priority), () => togglePriority(priority), `priority:${priority}`)
                  ))}
                </View>
              </>
            ) : null}

            {showEnergyLevelFilters ? (
              <>
                <Text style={[styles.taskFilterSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText(t, 'taskEdit.energyLevel', 'Energy level')}
                </Text>
                <View style={styles.taskFilterChipRow}>
                  {energyLevelOptions.map((energyLevel) => (
                    renderChip(t(`energyLevel.${energyLevel}`), selectedEnergyLevels.includes(energyLevel), () => toggleEnergyLevel(energyLevel), `energy:${energyLevel}`)
                  ))}
                </View>
              </>
            ) : null}

            {showTimeEstimateFilters ? (
              <>
                <Text style={[styles.taskFilterSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText(t, 'filters.timeEstimate', 'Time estimate')}
                </Text>
                <View style={styles.taskFilterChipRow}>
                  {timeEstimateOptions.map((estimate) => (
                    renderChip(formatTimeEstimateChipLabel(estimate), selectedTimeEstimates.includes(estimate), () => toggleTimeEstimate(estimate), `time:${estimate}`)
                  ))}
                </View>
              </>
            ) : null}

            {showLocationFilter ? (
              <>
                <Text style={[styles.taskFilterSectionLabel, { color: themeColors.secondaryText }]}>
                  {resolveText(t, 'taskEdit.locationLabel', 'Location')}
                </Text>
                <TextInput
                  accessibilityLabel={resolveText(t, 'taskEdit.locationLabel', 'Location')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={onChangeLocationQuery}
                  placeholder={resolveText(t, 'taskEdit.locationPlaceholder', 'e.g. Office')}
                  placeholderTextColor={themeColors.secondaryText}
                  returnKeyType="done"
                  style={[styles.taskFilterInput, { backgroundColor: themeColors.bg, borderColor: themeColors.border, color: themeColors.text }]}
                  value={locationQuery}
                />
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
