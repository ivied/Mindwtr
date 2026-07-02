import React from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';

import { styles } from '../inbox-processing-modal.styles';
import type { ThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';

type Area = { id: string; name: string; color?: string };
type Project = { id: string; title: string; areaId?: string };

type Props = {
  t: (key: string) => string;
  tc: ThemeColors;
  show: boolean;
  showProjectField: boolean;
  showAreaField: boolean;
  currentProject?: Project | null;
  currentArea?: Area | null;
  selectedProjectId?: string | null;
  selectedAreaId?: string | null;
  setSelectedAreaId: (v: string | null) => void;
  projectSearch: string;
  setProjectSearch: (v: string) => void;
  convertToProject: boolean;
  projectTitleDraft: string;
  setProjectTitleDraft: (v: string) => void;
  nextActionDraft: string;
  setNextActionDraft: (v: string) => void;
  filteredProjects: Project[];
  areaById: Map<string, Area>;
  hasExactProjectMatch: boolean;
  handleCreateProjectEarly: () => void;
  handleConvertToProject: () => void;
  handleProjectConversionCancel: () => void;
  handleProjectConversionStart: () => void;
  selectProjectEarly: (id: string | null) => void;
};

export function InboxProjectSection({
  t,
  tc,
  show,
  showProjectField,
  showAreaField,
  currentProject,
  currentArea,
  selectedProjectId,
  selectedAreaId,
  setSelectedAreaId,
  projectSearch,
  setProjectSearch,
  convertToProject,
  projectTitleDraft,
  setProjectTitleDraft,
  nextActionDraft,
  setNextActionDraft,
  filteredProjects,
  areaById,
  hasExactProjectMatch,
  handleCreateProjectEarly,
  handleConvertToProject,
  handleProjectConversionCancel,
  handleProjectConversionStart,
  selectProjectEarly,
}: Props) {
  const filledButton = useFilledButtonColors();
  if (!show) return null;

  const areaOptions = Array.from(areaById.values());

  const renderAreaPicker = () => {
    if (!showAreaField || selectedProjectId) return null;
    const noAreaSelected = !selectedAreaId;

    return (
      <View style={styles.projectFieldGroup}>
        <Text style={[styles.projectFieldLabel, { color: tc.secondaryText }]}>
          {t('taskEdit.areaLabel')}
        </Text>
        {currentArea && (
          <TouchableOpacity
            style={[styles.projectChip, { backgroundColor: currentArea.color || tc.tint }]}
            onPress={() => setSelectedAreaId(currentArea.id)}
            accessibilityState={{ selected: selectedAreaId === currentArea.id }}
          >
            <Text style={styles.projectChipText}>✓ {currentArea.name}</Text>
          </TouchableOpacity>
        )}
        <View style={styles.projectListContainer}>
          <TouchableOpacity
            style={[
              styles.projectChip,
              noAreaSelected
                ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
            ]}
            onPress={() => setSelectedAreaId(null)}
            accessibilityState={{ selected: noAreaSelected }}
          >
            <Text style={[styles.projectChipText, { color: tc.text }]}>
              {noAreaSelected ? '✓ ' : ''}{t('projects.noArea')}
            </Text>
          </TouchableOpacity>
          {areaOptions.map((area) => {
            const isSelected = selectedAreaId === area.id;
            return (
              <TouchableOpacity
                key={area.id}
                style={[
                  styles.projectChip,
                  isSelected
                    ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                    : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                ]}
                onPress={() => setSelectedAreaId(area.id)}
                accessibilityState={{ selected: isSelected }}
              >
                <View style={[styles.projectDot, { backgroundColor: area.color || tc.secondaryText }]} />
                <Text style={[styles.projectChipText, { color: tc.text }]}>{area.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  };

  const renderProjectPicker = () => {
    const noProjectSelected = !selectedProjectId;
    return (
      <>
      {showProjectField && currentProject && (
        <TouchableOpacity
          style={[styles.projectChip, { backgroundColor: tc.tint }]}
          onPress={() => selectProjectEarly(currentProject.id)}
          accessibilityState={{ selected: selectedProjectId === currentProject.id }}
        >
          <Text style={styles.projectChipText}>✓ {currentProject.title}</Text>
        </TouchableOpacity>
      )}
      {renderAreaPicker()}
      {showProjectField && (
        <>
          <View style={styles.projectSearchRow}>
            <TextInput
              value={projectSearch}
              onChangeText={setProjectSearch}
              placeholder={t('projects.addPlaceholder')}
              placeholderTextColor={tc.secondaryText}
              style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
              onSubmitEditing={handleCreateProjectEarly}
              returnKeyType="done"
            />
            {!hasExactProjectMatch && projectSearch.trim() && (
              <TouchableOpacity
                style={[styles.createProjectButton, { backgroundColor: filledButton.backgroundColor }]}
                onPress={handleCreateProjectEarly}
              >
                <Text style={[styles.createProjectButtonText, filledButton.textColor ? { color: filledButton.textColor } : null]}>{t('projects.create')}</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.projectListContainer}>
            <TouchableOpacity
              style={[
                styles.projectChip,
                noProjectSelected
                  ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                  : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
              ]}
              onPress={() => selectProjectEarly(null)}
              accessibilityState={{ selected: noProjectSelected }}
            >
              <Text style={[styles.projectChipText, { color: tc.text }]}>
                {noProjectSelected ? '✓ ' : ''}{t('inbox.noProject')}
              </Text>
            </TouchableOpacity>
            {filteredProjects.map((project) => {
              const projectColor = project.areaId ? areaById.get(project.areaId)?.color : undefined;
              const isSelected = selectedProjectId === project.id;
              return (
                <TouchableOpacity
                  key={project.id}
                  style={[
                    styles.projectChip,
                    isSelected
                      ? { backgroundColor: tc.filterBg, borderWidth: 1, borderColor: tc.tint }
                      : { backgroundColor: tc.cardBg, borderWidth: 1, borderColor: tc.border },
                  ]}
                  onPress={() => selectProjectEarly(project.id)}
                  accessibilityState={{ selected: isSelected }}
                >
                  <View style={[styles.projectDot, { backgroundColor: projectColor || tc.secondaryText }]} />
                  <Text style={[styles.projectChipText, { color: tc.text }]}>{project.title}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </>
      )}
      </>
    );
  };

  const renderProjectConversion = () => (
    <>
      {renderAreaPicker()}
      <View style={styles.projectConversionCard}>
        <View style={styles.projectFieldGroup}>
          <Text style={[styles.projectFieldLabel, { color: tc.secondaryText }]}>
            {t('projects.title')}
          </Text>
          <TextInput
            value={projectTitleDraft}
            onChangeText={setProjectTitleDraft}
            placeholder={t('projects.title')}
            placeholderTextColor={tc.secondaryText}
            accessibilityLabel={t('projects.title')}
            style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            returnKeyType="next"
          />
        </View>
        <View style={styles.projectFieldGroup}>
          <Text style={[styles.projectFieldLabel, { color: tc.secondaryText }]}>
            {t('process.nextAction')}
          </Text>
          <TextInput
            value={nextActionDraft}
            onChangeText={setNextActionDraft}
            placeholder={t('taskEdit.titleLabel')}
            placeholderTextColor={tc.secondaryText}
            accessibilityLabel={t('process.nextAction')}
            style={[styles.projectSearchInput, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
            onSubmitEditing={handleConvertToProject}
            returnKeyType="done"
          />
        </View>
        <TouchableOpacity
          style={[styles.createProjectButton, styles.projectConversionSubmit, { backgroundColor: filledButton.backgroundColor }]}
          onPress={handleConvertToProject}
        >
          <Text style={[styles.createProjectButtonText, filledButton.textColor ? { color: filledButton.textColor } : null]}>{t('process.createProject')}</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  return (
    <View style={[styles.singleSection, { borderBottomColor: tc.border }]}>
      <Text style={[styles.stepQuestion, { color: tc.text }]}>
        📁 {showProjectField ? t('process.moreThanOneStep') : t('inbox.assignProjectQuestion')}
      </Text>
      {showProjectField && (
        <>
          <Text style={[styles.stepHint, { color: tc.secondaryText }]}>
            {t('process.moreThanOneStepDesc')}
          </Text>
          <View style={styles.projectDecisionRow}>
            <TouchableOpacity
              style={[
                styles.projectDecisionButton,
                convertToProject
                  ? { backgroundColor: tc.tint, borderColor: tc.tint }
                  : { backgroundColor: tc.cardBg, borderColor: tc.border },
              ]}
              onPress={handleProjectConversionStart}
            >
              <Text
                style={[
                  styles.projectDecisionText,
                  { color: convertToProject ? tc.onTint : tc.text },
                ]}
              >
                {t('process.moreThanOneStepYes')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.projectDecisionButton,
                !convertToProject
                  ? { backgroundColor: tc.filterBg, borderColor: tc.tint }
                  : { backgroundColor: tc.cardBg, borderColor: tc.border },
              ]}
              onPress={handleProjectConversionCancel}
            >
              <Text
                style={[
                  styles.projectDecisionText,
                  { color: !convertToProject ? tc.text : tc.secondaryText },
                ]}
              >
                {t('process.moreThanOneStepNo')}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}
      {showProjectField && convertToProject ? renderProjectConversion() : renderProjectPicker()}
    </View>
  );
}
