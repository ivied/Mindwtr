import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ArrowUpDown, Folder, SlidersHorizontal, X } from 'lucide-react-native';

import { styles } from './task-list.styles';

type ThemeColors = {
  border: string;
  cardBg: string;
  filterBg: string;
  onTint: string;
  secondaryText: string;
  text: string;
  tint: string;
};

export type TaskListActiveFilterChip = {
  id: string;
  label: string;
  onPress: () => void;
};

type TaskListHeaderProps = {
  activeFilterChips: TaskListActiveFilterChip[];
  count: number;
  headerAccessory?: React.ReactNode;
  filterActiveCount: number;
  groupByLabel?: string;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onOpenFilters: () => void;
  onOpenGroup?: () => void;
  onOpenSort: () => void;
  showHeader: boolean;
  showFilterButton?: boolean;
  showSort: boolean;
  sortByLabel: string;
  t: (key: string) => string;
  themeColors: ThemeColors;
  title: string;
};

export function TaskListHeader({
  activeFilterChips,
  count,
  headerAccessory,
  filterActiveCount,
  groupByLabel,
  hasActiveFilters,
  onClearFilters,
  onOpenFilters,
  onOpenGroup,
  onOpenSort,
  showHeader,
  showFilterButton = true,
  showSort,
  sortByLabel,
  t,
  themeColors,
  title,
}: TaskListHeaderProps) {
  const filtersLabel = t('filters.label') === 'filters.label' ? 'Filters' : t('filters.label');
  const groupLabel = t('list.groupBy') === 'list.groupBy' ? 'Group' : t('list.groupBy');
  const clearLabel = t('filters.clear') === 'filters.clear' ? t('common.clear') : t('filters.clear');
  const removeFilterLabel = t('filters.remove') === 'filters.remove' ? 'Remove filter' : t('filters.remove');
  const sortControl = showSort ? (
    <TouchableOpacity
      onPress={onOpenSort}
      style={[
        styles.sortButton,
        { borderColor: themeColors.border, backgroundColor: themeColors.filterBg },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${t('sort.label')}: ${sortByLabel}`}
      hitSlop={8}
    >
      <ArrowUpDown size={16} color={themeColors.secondaryText} strokeWidth={2} />
    </TouchableOpacity>
  ) : null;
  const filterControl = showFilterButton ? (
    <TouchableOpacity
      onPress={onOpenFilters}
      style={[
        styles.sortButton,
        {
          borderColor: hasActiveFilters ? themeColors.tint : themeColors.border,
          backgroundColor: themeColors.filterBg,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={filterActiveCount > 0 ? `${filtersLabel}: ${filterActiveCount}` : filtersLabel}
      hitSlop={8}
    >
      <SlidersHorizontal size={16} color={hasActiveFilters ? themeColors.tint : themeColors.secondaryText} strokeWidth={2} />
      {filterActiveCount > 0 ? (
        <View style={[styles.filterBadge, { backgroundColor: themeColors.tint }]}>
          <Text style={[styles.filterBadgeText, { color: themeColors.onTint }]}>
            {filterActiveCount}
          </Text>
        </View>
      ) : null}
    </TouchableOpacity>
  ) : null;
  const groupControl = onOpenGroup ? (
    <TouchableOpacity
      onPress={onOpenGroup}
      style={[
        styles.sortButton,
        { borderColor: themeColors.border, backgroundColor: themeColors.filterBg },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${groupLabel}: ${groupByLabel ?? ''}`}
      hitSlop={8}
    >
      <Folder size={16} color={themeColors.secondaryText} strokeWidth={2} />
    </TouchableOpacity>
  ) : null;
  return (
    <>
      {showHeader ? (
        <View style={[styles.header, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <View style={styles.headerTopRow}>
            <Text style={[styles.title, { color: themeColors.text }]} accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            <Text style={[styles.count, { color: themeColors.secondaryText }]} accessibilityLabel={`${count} tasks`}>
              {count} {t('common.tasks')}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {sortControl}
            {groupControl}
            {filterControl}
            {headerAccessory}
          </View>
        </View>
      ) : sortControl || groupControl || filterControl || headerAccessory ? (
        <View style={styles.headerAccessoryRow}>
          <View style={styles.headerAccessoryLeft}>
            <View style={styles.headerAccessoryControls}>
              {sortControl}
              {groupControl}
              {filterControl}
            </View>
          </View>
          <View style={styles.headerAccessoryRight}>
            {headerAccessory}
          </View>
        </View>
      ) : null}

      {activeFilterChips.length > 0 ? (
        <View style={[styles.filterSection, { borderBottomColor: themeColors.border, backgroundColor: themeColors.cardBg }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterChips}>
            {activeFilterChips.map((chip) => (
              <TouchableOpacity
                key={chip.id}
                accessibilityRole="button"
                accessibilityLabel={`${removeFilterLabel}: ${chip.label}`}
                onPress={chip.onPress}
                style={[
                  styles.filterChip,
                  {
                    borderColor: themeColors.tint,
                    backgroundColor: themeColors.filterBg,
                  },
                ]}
              >
                <Text style={[styles.filterChipText, { color: themeColors.tint }]}>{chip.label}</Text>
                <X size={14} color={themeColors.tint} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={clearLabel}
              onPress={onClearFilters}
              style={[styles.filterChip, { borderColor: themeColors.border, backgroundColor: themeColors.filterBg }]}
            >
              <Text style={[styles.filterChipText, { color: themeColors.secondaryText }]}>
                {clearLabel}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      ) : null}
    </>
  );
}
