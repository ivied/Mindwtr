import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, TextInput, TouchableOpacity, Alert, FlatList, Dimensions, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AREA_PRESET_COLORS, Attachment, DEFAULT_PROJECT_COLOR, Project, shallow, Task, type Section, type TaskSortBy, useTaskStore } from '@mindwtr/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react-native';

import {
  DEFAULT_PROJECT_LIST_VIEW_STATE,
  PROJECT_LIST_VIEW_STATE_STORAGE_KEY,
  type ProjectListViewState,
  compactCollapsedAreas,
  readProjectListViewState,
  serializeProjectListViewState,
} from '@/lib/view-state/project-list-view-state';
import { projectsScreenStyles as styles } from '@/components/projects-screen/projects-screen.styles';
import {
  buildProjectQuickCaptureReturnTo,
  formatProjectDate,
  normalizeProjectTag,
  resolveAttachmentValidationMessage,
} from '@/components/projects-screen/projects-screen.utils';
import { openProjectAreaPicker, openProjectTagPicker } from '@/components/projects-screen/project-meta-pickers';
import { ProjectAreaModals } from '@/components/projects-screen/ProjectAreaModals';
import { ProjectDetailModal } from '@/components/projects-screen/ProjectDetailModal';
import { ProjectImagePreviewModal, ProjectLinkModal, ProjectTagPickerModal } from '@/components/projects-screen/ProjectOverlayModals';
import { ProjectRow } from '@/components/projects-screen/ProjectRow';
import {
  buildProjectListRows,
  type ProjectListRow,
} from '@/components/projects-screen/project-list-model';
import { useProjectAttachments } from '@/components/projects-screen/use-project-attachments';
import { useProjectNotesEditor } from '@/components/projects-screen/use-project-notes-editor';
import { TaskEditModal } from '@/components/task-edit-modal';
import type { TaskEditTab } from '@/components/task-edit/use-task-edit-state';
import { useProjectFiltering } from '@/hooks/use-project-filtering';
import { useMobileAreaFilter } from '@/hooks/use-mobile-area-filter';
import { useQuickCapture } from '../../contexts/quick-capture-context';
import { useLanguage } from '../../contexts/language-context';
import { useToast } from '../../contexts/toast-context';
import { useThemeColors } from '@/hooks/use-theme-colors';
import { useFilledButtonColors } from '@/hooks/use-filled-button-colors';
import { ListSectionHeader, defaultListContentStyle } from '@/components/list-layout';
import { logError, logWarn } from '../../lib/app-log';
import { AREA_FILTER_ALL, AREA_FILTER_NONE } from '@mindwtr/core';
import { openContextsScreen, openProjectScreen } from '@/lib/task-meta-navigation';
import { CompactText, CompactTextInput } from '@/components/compact-text';

type ProjectTaskSortBy = TaskSortBy;
const EMPTY_PROJECT_TASKS: Task[] = [];
function resolveTaskRouteTab(value?: string | string[]): TaskEditTab {
  const routeValue = Array.isArray(value) ? value[0] : value;
  return routeValue === 'task' ? 'task' : 'view';
}

export default function ProjectsScreen() {
  const {
    projects,
    tasks,
    sections,
    addProject,
    updateProject,
    deleteProject,
    restoreProject,
    duplicateProject,
    addSection,
    updateSection,
    deleteSection,
    reorderSections,
    toggleProjectFocus,
    addArea,
    updateArea,
    deleteArea,
    reorderAreas,
    updateTask,
    setHighlightTask,
    settings,
    getDerivedState,
  } = useTaskStore((state) => ({
    projects: state.projects,
    tasks: state.tasks,
    sections: state.sections,
    addProject: state.addProject,
    updateProject: state.updateProject,
    deleteProject: state.deleteProject,
    restoreProject: state.restoreProject,
    duplicateProject: state.duplicateProject,
    addSection: state.addSection,
    updateSection: state.updateSection,
    deleteSection: state.deleteSection,
    reorderSections: state.reorderSections,
    toggleProjectFocus: state.toggleProjectFocus,
    addArea: state.addArea,
    updateArea: state.updateArea,
    deleteArea: state.deleteArea,
    reorderAreas: state.reorderAreas,
    updateTask: state.updateTask,
    setHighlightTask: state.setHighlightTask,
    settings: state.settings,
    getDerivedState: state.getDerivedState,
  }), shallow);
  const { t, language } = useLanguage();
  const { showToast } = useToast();
  const { openQuickCapture } = useQuickCapture();
  const tc = useThemeColors();
  const filledButton = useFilledButtonColors();
  const {
    focusedProjectCount,
    projectTaskSummaryById,
    tasksByProjectId,
  } = getDerivedState();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const statusPalette: Record<Project['status'], { text: string; bg: string; border: string }> = {
    active: { text: tc.tint, bg: `${tc.tint}22`, border: tc.tint },
    waiting: { text: '#F59E0B', bg: '#F59E0B22', border: '#F59E0B' },
    someday: { text: '#A855F7', bg: '#A855F722', border: '#A855F7' },
    archived: { text: tc.secondaryText, bg: tc.filterBg, border: tc.border },
  };
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projectTaskSortBy, setProjectTaskSortBy] = useState<ProjectTaskSortBy>('default');
  const [showProjectMeta, setShowProjectMeta] = useState(false);
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [showReviewPicker, setShowReviewPicker] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [taskModalDefaultTab, setTaskModalDefaultTab] = useState<TaskEditTab>('view');
  const [taskModalOpenKey, setTaskModalOpenKey] = useState('manual');
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [showAreaManager, setShowAreaManager] = useState(false);
  const [newAreaName, setNewAreaName] = useState('');
  const [newAreaColor, setNewAreaColor] = useState('#3b82f6');
  const [expandedAreaColorId, setExpandedAreaColorId] = useState<string | null>(null);
  const { projectId, taskId, openToken, taskTab } = useLocalSearchParams<{ projectId?: string; taskId?: string; openToken?: string; taskTab?: string }>();
  const lastOpenedTaskKeyRef = useRef<string | null>(null);
  const ALL_TAGS = '__all__';
  const NO_TAGS = '__none__';
  const ALL_AREAS = AREA_FILTER_ALL;
  const NO_AREA = AREA_FILTER_NONE;
  const [selectedTagFilter, setSelectedTagFilter] = useState(ALL_TAGS);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [collapsedAreas, setCollapsedAreas] = useState<Record<string, boolean>>({});
  const [projectListViewStateHydrated, setProjectListViewStateHydrated] = useState(false);
  const [showDeferredProjects, setShowDeferredProjects] = useState(false);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [showCompletedProjectTasks, setShowCompletedProjectTasks] = useState(false);
  const projectListViewStateRef = useRef<ProjectListViewState>(DEFAULT_PROJECT_LIST_VIEW_STATE);
  const projectListViewStateTouchedRef = useRef(false);
  const {
    areaById,
    resolvedAreaFilter: selectedAreaFilter,
    sortedAreas,
  } = useMobileAreaFilter();

  const logProjectError = useCallback((message: string, error?: unknown) => {
    if (!error) return;
    void logError(error, { scope: 'project', extra: { message } });
  }, []);
  const applyProjectListViewState = useCallback((nextState: ProjectListViewState) => {
    const compactState = {
      ...nextState,
      collapsedAreas: compactCollapsedAreas(nextState.collapsedAreas),
    };
    projectListViewStateRef.current = compactState;
    setCollapsedAreas(compactState.collapsedAreas);
    setShowArchivedProjects(compactState.showArchivedProjects);
    setShowDeferredProjects(compactState.showDeferredProjects);
  }, []);
  const persistProjectListViewState = useCallback((nextState: ProjectListViewState) => {
    const compactState = {
      ...nextState,
      collapsedAreas: compactCollapsedAreas(nextState.collapsedAreas),
    };
    projectListViewStateRef.current = compactState;
    AsyncStorage.setItem(PROJECT_LIST_VIEW_STATE_STORAGE_KEY, serializeProjectListViewState(compactState))
      .catch(() => undefined);
  }, []);
  const resolveText = useCallback((key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  }, [t]);
  const undoNotificationsEnabled = settings?.undoNotificationsEnabled !== false;
  const [showTagFilter, setShowTagFilter] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const windowHeight = Dimensions.get('window').height;
  const pickerCardMaxHeight = Math.min(windowHeight * 0.8, 560);
  const areaListMaxHeight = Math.min(windowHeight * 0.4, 280);
  const areaManagerListMaxHeight = Math.min(windowHeight * 0.45, 320);
  const overlayModalPresentation = 'overFullScreen' as const;

  const colors = AREA_PRESET_COLORS;
  const colorDisplayByHex: Record<string, { nameKey: string; swatch: string }> = {
    '#3b82f6': { nameKey: 'projects.colorBlue', swatch: '🔵' },
    '#10b981': { nameKey: 'projects.colorGreen', swatch: '🟢' },
    '#f59e0b': { nameKey: 'projects.colorAmber', swatch: '🟠' },
    '#ef4444': { nameKey: 'projects.colorRed', swatch: '🔴' },
    '#8b5cf6': { nameKey: 'projects.colorPurple', swatch: '🟣' },
    '#ec4899': { nameKey: 'projects.colorPink', swatch: '🩷' },
  };
  const {
    areaUsage,
    focusedCount,
    groupedActiveProjects,
    groupedDeferredProjects,
    groupedArchivedProjects,
    projectTagOptions,
    tagFilterOptions,
  } = useProjectFiltering({
    projects,
    tasks,
    sortedAreas,
    areaById,
    selectedTagFilter,
    selectedAreaFilter,
    allTagsValue: ALL_TAGS,
    noTagsValue: NO_TAGS,
    focusedProjectCount,
    t,
  });
  const {
    notesExpanded,
    setNotesExpanded,
    showNotesPreview,
    setShowNotesPreview,
    notesFullscreen,
    setNotesFullscreen,
    selectedProjectNotes,
    selectedProjectNotesDirection,
    selectedProjectNotesTextDirectionStyle,
    selectedProjectNotesInputRef,
    selectedProjectNotesUndoDepth,
    isSelectedProjectNotesFocused,
    setIsSelectedProjectNotesFocused,
    selectedProjectNotesSelection,
    commitSelectedProjectNotes,
    handleSelectedProjectNotesApplyAction,
    handleSelectedProjectNotesApplyAutocomplete,
    handleSelectedProjectNotesChange,
    handleSelectedProjectNotesSelectionChange,
    handleSelectedProjectNotesUndo,
    resetProjectNotesUi,
  } = useProjectNotesEditor({
    selectedProject,
    setSelectedProject,
    updateProject,
    language,
  });

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(PROJECT_LIST_VIEW_STATE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (!projectListViewStateTouchedRef.current) {
          const persisted = readProjectListViewState(raw);
          if (persisted) {
            applyProjectListViewState(persisted);
          }
        }
        setProjectListViewStateHydrated(true);
      })
      .catch(() => {
        if (active) {
          setProjectListViewStateHydrated(true);
        }
      });
    return () => {
      active = false;
    };
  }, [applyProjectListViewState]);
  const {
    linkModalVisible,
    setLinkModalVisible,
    imagePreviewAttachment,
    setImagePreviewAttachment,
    linkInput,
    setLinkInput,
    openAttachment,
    downloadAttachment,
    addProjectFileAttachment,
    confirmAddProjectLink,
    removeProjectAttachment,
    resetProjectAttachmentUi,
  } = useProjectAttachments({
    selectedProject,
    setSelectedProject,
    updateProject,
    t,
    logProjectError,
  });

  const projectListRows = useMemo(() => {
    if (!projectListViewStateHydrated) return [];
    return buildProjectListRows({
      areaById,
      collapsedAreas,
      groupedActiveProjects,
      groupedArchivedProjects,
      groupedDeferredProjects,
      showArchivedProjects,
      showDeferredProjects,
      t,
    });
  }, [
    areaById,
    collapsedAreas,
    groupedActiveProjects,
    groupedArchivedProjects,
    groupedDeferredProjects,
    projectListViewStateHydrated,
    showArchivedProjects,
    showDeferredProjects,
    t,
  ]);
  const projectListEmptyLabel = projectListViewStateHydrated
    ? t('projects.empty')
    : resolveText('common.loading', 'Loading...');

  const selectedProjectTasks = useMemo(
    () => (selectedProject ? tasksByProjectId.get(selectedProject.id) ?? EMPTY_PROJECT_TASKS : EMPTY_PROJECT_TASKS),
    [tasksByProjectId, selectedProject?.id]
  );
  const selectedProjectSections = useMemo<Section[]>(() => {
    if (!selectedProject) return [];
    return sections
      .filter((section) => section.projectId === selectedProject.id && !section.deletedAt)
      .sort((a, b) => {
        const aOrder = Number.isFinite(a.order) ? a.order : 0;
        const bOrder = Number.isFinite(b.order) ? b.order : 0;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.title.localeCompare(b.title);
      });
  }, [sections, selectedProject?.id]);

  const openProject = useCallback((project: Project) => {
    setSelectedProject(project);
    setProjectTaskSortBy('default');
    resetProjectNotesUi();
    setShowProjectMeta(false);
    setShowDueDatePicker(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    resetProjectAttachmentUi();
  }, [resetProjectAttachmentUi, resetProjectNotesUi]);

  const openProjectQuickAdd = useCallback((projectToAddTo: Project) => {
    openQuickCapture({
      initialProps: {
        projectId: projectToAddTo.id,
        status: 'next',
      },
      returnTo: buildProjectQuickCaptureReturnTo(projectToAddTo.id),
    });
  }, [openQuickCapture]);

  useEffect(() => {
    if (!projectId || typeof projectId !== 'string') return;
    const project = projects.find((item) => item.id === projectId && !item.deletedAt);
    if (project) {
      openProject(project);
    }
  }, [projectId, projects, openProject]);

  useEffect(() => {
    if (!taskId || typeof taskId !== 'string') return;
    if (!selectedProject || selectedProject.id !== projectId) return;
    const nextTaskTab = resolveTaskRouteTab(taskTab);
    const openKey = `${taskId}:${typeof openToken === 'string' ? openToken : ''}:${nextTaskTab}`;
    if (lastOpenedTaskKeyRef.current === openKey) return;
    const task = tasks.find((item) => item.id === taskId && !item.deletedAt);
    if (!task || task.projectId !== selectedProject.id) return;
    lastOpenedTaskKeyRef.current = openKey;
    setHighlightTask(task.id);
    setTaskModalDefaultTab(nextTaskTab);
    setTaskModalOpenKey(`route:${openKey}`);
    setEditingTask(task);
  }, [openToken, taskId, projectId, selectedProject, taskTab, tasks, setHighlightTask]);

  const sortAreasByName = () => {
    const reordered = [...sortedAreas]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((area) => area.id);
    reorderAreas(reordered);
  };

  const sortAreasByColor = () => {
    const reordered = [...sortedAreas]
      .sort((a, b) => {
        const colorA = (a.color || '').toLowerCase();
        const colorB = (b.color || '').toLowerCase();
        if (colorA && colorB && colorA !== colorB) return colorA.localeCompare(colorB);
        if (colorA && !colorB) return -1;
        if (!colorA && colorB) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((area) => area.id);
    reorderAreas(reordered);
  };

  const toggleProjectTag = (tag: string) => {
    if (!selectedProject) return;
    const normalized = normalizeProjectTag(tag);
    if (!normalized) return;
    const current = selectedProject.tagIds || [];
    const exists = current.includes(normalized);
    const next = exists ? current.filter((t) => t !== normalized) : [...current, normalized];
    updateProject(selectedProject.id, { tagIds: next });
    setSelectedProject({ ...selectedProject, tagIds: next });
  };

  const handleDeleteProject = useCallback((projectIdToDelete: string) => {
    void Promise.resolve(deleteProject(projectIdToDelete))
      .then(() => {
        if (selectedProject?.id === projectIdToDelete) {
          setSelectedProject(null);
        }
        if (!undoNotificationsEnabled) return;
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.deleted', 'Project moved to Trash'),
          tone: 'info',
          actionLabel: resolveText('common.undo', 'Undo'),
          onAction: () => {
            void Promise.resolve(restoreProject(projectIdToDelete))
              .catch((error) => {
                logProjectError('Failed to restore project', error);
                showToast({
                  title: resolveText('common.notice', 'Notice'),
                  message: resolveText('projects.restoreFailed', 'Failed to restore project'),
                  tone: 'error',
                });
              });
          },
          durationMs: 5200,
        });
      })
      .catch((error) => {
        logProjectError('Failed to delete project', error);
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.deleteFailed', 'Failed to delete project'),
          tone: 'error',
        });
      });
  }, [
    deleteProject,
    logProjectError,
    resolveText,
    restoreProject,
    selectedProject?.id,
    showToast,
    undoNotificationsEnabled,
  ]);

  const handleDuplicateProject = useCallback((projectIdToDuplicate: string) => {
    void Promise.resolve(duplicateProject(projectIdToDuplicate))
      .then((createdProject) => {
        if (!createdProject) {
          showToast({
            title: resolveText('common.notice', 'Notice'),
            message: resolveText('projects.duplicateFailed', 'Failed to duplicate project'),
            tone: 'error',
          });
          return;
        }
        setSelectedProject(createdProject);
        showToast({
          title: resolveText('common.done', 'Done'),
          message: resolveText('projects.duplicated', 'Project duplicated'),
          tone: 'success',
        });
      })
      .catch((error) => {
        logProjectError('Failed to duplicate project', error);
        showToast({
          title: resolveText('common.notice', 'Notice'),
          message: resolveText('projects.duplicateFailed', 'Failed to duplicate project'),
          tone: 'error',
        });
      });
  }, [duplicateProject, logProjectError, resolveText, showToast]);

  const renderProjectItem = (project: Project) => {
    return (
      <ProjectRow
        project={project}
        taskSummary={projectTaskSummaryById.get(project.id)}
        tc={tc}
        focusedCount={focusedCount}
        statusPalette={statusPalette}
        t={t}
        onDeleteProject={handleDeleteProject}
        onDuplicateProject={handleDuplicateProject}
        onOpenProject={openProject}
        onToggleProjectFocus={toggleProjectFocus}
      />
    );
  };

  const toggleAreaCollapse = useCallback((areaId: string) => {
    projectListViewStateTouchedRef.current = true;
    const current = projectListViewStateRef.current;
    const collapsedAreas = { ...current.collapsedAreas };
    if (collapsedAreas[areaId]) {
      delete collapsedAreas[areaId];
    } else {
      collapsedAreas[areaId] = true;
    }
    const nextState = {
      ...current,
      collapsedAreas,
    };
    setCollapsedAreas(compactCollapsedAreas(collapsedAreas));
    persistProjectListViewState(nextState);
  }, [persistProjectListViewState]);

  const toggleProjectSection = useCallback((sectionKind: Extract<ProjectListRow, { type: 'section-toggle' }>['sectionKind']) => {
    projectListViewStateTouchedRef.current = true;
    const current = projectListViewStateRef.current;
    if (sectionKind === 'deferred') {
      const nextState = {
        ...current,
        showDeferredProjects: !current.showDeferredProjects,
      };
      setShowDeferredProjects(nextState.showDeferredProjects);
      persistProjectListViewState(nextState);
      return;
    }
    const nextState = {
      ...current,
      showArchivedProjects: !current.showArchivedProjects,
    };
    setShowArchivedProjects(nextState.showArchivedProjects);
    persistProjectListViewState(nextState);
  }, [persistProjectListViewState]);

  const renderProjectListRow = ({ item, index }: { item: ProjectListRow; index: number }) => {
    if (item.type === 'section-label') {
      return <ListSectionHeader title={item.title} tc={tc} />;
    }

    if (item.type === 'section-toggle') {
      const showTopBorder = index > 0;
      return (
        <TouchableOpacity
          onPress={() => {
            toggleProjectSection(item.sectionKind);
          }}
          style={[
            styles.collapsibleSectionToggle,
            showTopBorder && { borderTopWidth: 1, borderTopColor: tc.border },
          ]}
        >
          <Text style={[styles.collapsibleSectionToggleText, { color: tc.secondaryText }]}>
            {item.title}
          </Text>
          {item.expanded
            ? <ChevronDown size={16} color={tc.secondaryText} strokeWidth={2.2} />
            : <ChevronRight size={16} color={tc.secondaryText} strokeWidth={2.2} />}
        </TouchableOpacity>
      );
    }

    if (item.type === 'area-header') {
      return (
        <TouchableOpacity
          onPress={() => toggleAreaCollapse(item.areaId)}
          style={styles.collapsibleAreaHeader}
        >
          <View style={styles.collapsibleAreaHeaderContent}>
            {item.color ? (
              <View
                style={[
                  styles.collapsibleAreaDot,
                  { backgroundColor: item.color, borderColor: tc.border },
                ]}
              />
            ) : null}
            {item.icon ? (
              <Text style={[styles.collapsibleAreaIcon, { color: tc.secondaryText }]}>{item.icon}</Text>
            ) : null}
            <Text style={[styles.collapsibleAreaHeaderText, { color: tc.secondaryText }]} numberOfLines={1}>
              {item.title}
            </Text>
          </View>
          {item.collapsed
            ? <ChevronRight size={16} color={tc.secondaryText} strokeWidth={2.2} />
            : <ChevronDown size={16} color={tc.secondaryText} strokeWidth={2.2} />}
        </TouchableOpacity>
      );
    }

    return renderProjectItem(item.project);
  };

  const selectedProjectAreaName = selectedProject?.areaId && areaById.has(selectedProject.areaId)
    ? areaById.get(selectedProject.areaId)?.name || t('projects.noArea')
    : t('projects.noArea');

  const handleAddProject = () => {
    if (newProjectTitle.trim()) {
      const inferredAreaId =
        selectedAreaFilter !== ALL_AREAS && selectedAreaFilter !== NO_AREA && areaById.has(selectedAreaFilter)
          ? selectedAreaFilter
          : undefined;
      const areaColor = inferredAreaId ? areaById.get(inferredAreaId)?.color : undefined;
      addProject(newProjectTitle, areaColor || DEFAULT_PROJECT_COLOR, {
        areaId: inferredAreaId,
      });
      setNewProjectTitle('');
    }
  };

  const persistSelectedProjectEdits = (project: Project | null) => {
    if (!project) return;
    const original = projects.find((p) => p.id === project.id);
    if (!original) return;

    const nextTitle = project.title.trim();
    const nextArea = project.areaId || undefined;
    const prevArea = original.areaId || undefined;

    const updates: Partial<Project> = {};
    if (nextTitle && nextTitle !== original.title) updates.title = nextTitle;
    if (nextArea !== prevArea) updates.areaId = nextArea;
    if ((project.tagIds || []).join('|') !== (original.tagIds || []).join('|')) {
      updates.tagIds = project.tagIds || [];
    }

    if (Object.keys(updates).length > 0) {
      updateProject(project.id, updates);
    }
  };

  const closeProjectDetail = () => {
    commitSelectedProjectNotes();
    persistSelectedProjectEdits(selectedProject);
    setSelectedProject(null);
    resetProjectNotesUi();
    setShowProjectMeta(false);
    setShowReviewPicker(false);
    setShowStatusMenu(false);
    resetProjectAttachmentUi();
    setShowAreaPicker(false);
    setShowTagPicker(false);
    if (projectId && router.canGoBack()) {
      router.back();
    }
  };

  const handleSetProjectStatus = (status: Project['status']) => {
    if (!selectedProject) return;
    updateProject(selectedProject.id, { status });
    setSelectedProject({ ...selectedProject, status });
    setShowStatusMenu(false);
  };

  const handleArchiveSelectedProject = () => {
    if (!selectedProject) return;
    Alert.alert(
      t('projects.title'),
      t('projects.archiveConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('projects.archive'),
          style: 'destructive',
          onPress: () => {
            updateProject(selectedProject.id, { status: 'archived' });
            setSelectedProject({ ...selectedProject, status: 'archived' });
          }
        }
      ]
    );
  };

  const openAreaPicker = () => {
    openProjectAreaPicker({
      addArea,
      areaUsage,
      colorDisplayByHex,
      colors,
      deleteArea,
      logProjectError,
      selectedProject,
      setSelectedProject,
      setShowAreaPicker,
      setShowStatusMenu,
      showToast,
      sortAreasByColor,
      sortAreasByName,
      sortedAreas,
      t,
      updateArea,
      updateProject,
    });
  };

  const openTagPicker = () => {
    openProjectTagPicker({
      projectTagOptions,
      selectedProject,
      setSelectedProject,
      setShowStatusMenu,
      setShowTagPicker,
      setTagDraft,
      t,
      toggleProjectTag,
      updateProject,
    });
  };

  const updateAttachmentStatus = (
    attachments: Attachment[],
    id: string,
    status: Attachment['localStatus']
  ): Attachment[] =>
    attachments.map((item): Attachment =>
      item.id === id ? { ...item, localStatus: status } : item
    );

  const isImageAttachment = useCallback((attachment: Attachment) => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('image/')) return true;
    return /\.(png|jpg|jpeg|gif|webp|heic|heif)$/i.test(attachment.uri);
  }, []);

  const modalHeaderStyle = [styles.modalHeader, {
    borderBottomColor: tc.border,
    backgroundColor: tc.cardBg,
    paddingTop: Platform.OS === 'ios' ? Math.max(insets.top, 10) : 10,
    paddingBottom: 8,
  }];

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.inputContainer, { borderBottomColor: tc.border }]}>
        <View style={styles.addProjectRow}>
          <CompactTextInput
            style={[styles.input, styles.addProjectInput, { borderColor: tc.border, backgroundColor: tc.inputBg, color: tc.text }]}
            placeholder={t('projects.addPlaceholder')}
            placeholderTextColor={tc.secondaryText}
            value={newProjectTitle}
            onChangeText={setNewProjectTitle}
            onSubmitEditing={handleAddProject}
            returnKeyType="done"
            accessibilityLabel={t('projects.addPlaceholder')}
          />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('projects.add')}
            onPress={handleAddProject}
            style={[
              styles.addIconButton,
              { backgroundColor: filledButton.backgroundColor },
              !newProjectTitle.trim() && styles.addButtonDisabled,
            ]}
            disabled={!newProjectTitle.trim()}
          >
            <Plus size={22} color={filledButton.textColor ?? tc.onTint} strokeWidth={2.4} />
          </TouchableOpacity>
        </View>
        <View style={styles.filterSection}>
          <TouchableOpacity
            style={styles.filterHeader}
            onPress={() => setShowTagFilter((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={`${t('projects.tagFilter')}: ${showTagFilter ? t('filters.hide') : t('filters.show')}`}
            accessibilityState={{ expanded: showTagFilter }}
          >
            <CompactText
              style={[styles.tagFilterLabel, { color: tc.text }]}
              numberOfLines={1}
            >
              {t('projects.tagFilter')}
            </CompactText>
            <CompactText
              style={[styles.filterToggleText, { color: tc.secondaryText }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.78}
            >
              {showTagFilter ? t('filters.hide') : t('filters.show')}
            </CompactText>
          </TouchableOpacity>
          {showTagFilter && (
            <View style={styles.tagFilterChips}>
              <TouchableOpacity
                style={[
                  styles.tagFilterChip,
                  selectedTagFilter === ALL_TAGS
                    ? { borderColor: tc.tint, backgroundColor: tc.tint }
                    : { borderColor: tc.border, backgroundColor: tc.cardBg },
                ]}
                onPress={() => setSelectedTagFilter(ALL_TAGS)}
                accessibilityRole="button"
                accessibilityLabel={t('projects.allTags')}
                accessibilityState={{ selected: selectedTagFilter === ALL_TAGS }}
              >
                <Text
                  style={[
                    styles.tagFilterText,
                    { color: selectedTagFilter === ALL_TAGS ? tc.onTint : tc.text },
                  ]}
                >
                  {t('projects.allTags')}
                </Text>
              </TouchableOpacity>
              {tagFilterOptions.list.map((tag) => (
                <TouchableOpacity
                  key={tag}
                  style={[
                    styles.tagFilterChip,
                    selectedTagFilter === tag
                      ? { borderColor: tc.tint, backgroundColor: tc.tint }
                      : { borderColor: tc.border, backgroundColor: tc.cardBg },
                  ]}
                  onPress={() => setSelectedTagFilter(tag)}
                  accessibilityRole="button"
                  accessibilityLabel={tag}
                  accessibilityState={{ selected: selectedTagFilter === tag }}
                >
                  <Text
                    style={[
                      styles.tagFilterText,
                      { color: selectedTagFilter === tag ? tc.onTint : tc.text },
                    ]}
                  >
                    {tag}
                  </Text>
                </TouchableOpacity>
              ))}
              {tagFilterOptions.hasNoTags && (
                <TouchableOpacity
                  style={[
                    styles.tagFilterChip,
                    selectedTagFilter === NO_TAGS
                      ? { borderColor: tc.tint, backgroundColor: tc.tint }
                      : { borderColor: tc.border, backgroundColor: tc.cardBg },
                  ]}
                  onPress={() => setSelectedTagFilter(NO_TAGS)}
                  accessibilityRole="button"
                  accessibilityLabel={t('projects.noTags')}
                  accessibilityState={{ selected: selectedTagFilter === NO_TAGS }}
                >
                  <Text
                    style={[
                      styles.tagFilterText,
                      { color: selectedTagFilter === NO_TAGS ? tc.onTint : tc.text },
                    ]}
                  >
                    {t('projects.noTags')}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      </View>

      <FlatList
        data={projectListRows}
        keyExtractor={(item) => item.key}
        contentContainerStyle={defaultListContentStyle}
        style={{ flex: 1 }}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyText, { color: tc.secondaryText }]}>{projectListEmptyLabel}</Text>
          </View>
        }
        renderItem={renderProjectListRow}
        removeClippedSubviews={false}
      />

      <ProjectDetailModal
        addProjectFileAttachment={addProjectFileAttachment}
        addSection={addSection}
        closeProjectDetail={closeProjectDetail}
        commitSelectedProjectNotes={commitSelectedProjectNotes}
        formatProjectDate={formatProjectDate}
        handleArchiveSelectedProject={handleArchiveSelectedProject}
        handleSelectedProjectNotesApplyAction={handleSelectedProjectNotesApplyAction}
        handleSelectedProjectNotesApplyAutocomplete={handleSelectedProjectNotesApplyAutocomplete}
        handleSelectedProjectNotesChange={handleSelectedProjectNotesChange}
        handleSelectedProjectNotesSelectionChange={handleSelectedProjectNotesSelectionChange}
        handleSelectedProjectNotesUndo={handleSelectedProjectNotesUndo}
        handleSetProjectStatus={handleSetProjectStatus}
        isSelectedProjectNotesFocused={isSelectedProjectNotesFocused}
        modalHeaderStyle={modalHeaderStyle as Record<string, unknown>[]}
        notesExpanded={notesExpanded}
        notesFullscreen={notesFullscreen}
        onCloseNotesFullscreen={() => setNotesFullscreen(false)}
        onDuplicateProject={handleDuplicateProject}
        onDownloadAttachment={downloadAttachment}
        onOpenAreaPicker={openAreaPicker}
        onOpenAttachment={openAttachment}
        onOpenProjectQuickAdd={openProjectQuickAdd}
        onOpenTagPicker={openTagPicker}
        onRemoveProjectAttachment={removeProjectAttachment}
        deleteSection={deleteSection}
        reorderSections={reorderSections}
        onSetLinkInput={setLinkInput}
        onSetLinkModalVisible={setLinkModalVisible}
        onSetNotesExpanded={setNotesExpanded}
        onSetSelectedProject={setSelectedProject}
        onSetSelectedProjectNotesFocused={setIsSelectedProjectNotesFocused}
        onSetShowDueDatePicker={setShowDueDatePicker}
        onSetShowNotesFullscreen={setNotesFullscreen}
        onSetShowNotesPreview={setShowNotesPreview}
        onSetShowProjectMeta={setShowProjectMeta}
        onSetShowReviewPicker={setShowReviewPicker}
        onSetShowStatusMenu={setShowStatusMenu}
        onProjectTaskSortByChange={setProjectTaskSortBy}
        onToggleShowCompletedTasks={() => setShowCompletedProjectTasks((current) => !current)}
        overlayVisible={!!selectedProject}
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        projectTaskSortBy={projectTaskSortBy}
        selectedProject={selectedProject}
        selectedProjectSections={selectedProjectSections}
        selectedProjectTasks={selectedProjectTasks}
        selectedProjectAreaName={selectedProjectAreaName}
        selectedProjectNotes={selectedProjectNotes}
        selectedProjectNotesDirection={selectedProjectNotesDirection}
        selectedProjectNotesInputRef={selectedProjectNotesInputRef}
        selectedProjectNotesSelection={selectedProjectNotesSelection}
        selectedProjectNotesTextDirectionStyle={selectedProjectNotesTextDirectionStyle}
        selectedProjectNotesUndoDepth={selectedProjectNotesUndoDepth}
        showDueDatePicker={showDueDatePicker}
        showNotesPreview={showNotesPreview}
        showProjectMeta={showProjectMeta}
        showReviewPicker={showReviewPicker}
        showStatusMenu={showStatusMenu}
        showCompletedTasks={showCompletedProjectTasks}
        statusPalette={statusPalette}
        t={t}
        tc={tc}
        updateProject={updateProject}
        updateSection={updateSection}
      />

      <TaskEditModal
        key={taskModalOpenKey}
        visible={editingTask !== null}
        task={editingTask}
        onClose={() => setEditingTask(null)}
        onSave={(taskId, updates) => updateTask(taskId, updates)}
        defaultTab={taskModalDefaultTab}
        onProjectNavigate={(projectId) => {
          if (!selectedProject || selectedProject.id !== projectId) {
            openProjectScreen(projectId);
          }
        }}
        onContextNavigate={openContextsScreen}
        onTagNavigate={openContextsScreen}
      />

      <ProjectLinkModal
        visible={linkModalVisible}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        linkInput={linkInput}
        onChangeLinkInput={setLinkInput}
        onClose={() => {
          setLinkModalVisible(false);
          setLinkInput('');
        }}
        onSave={confirmAddProjectLink}
      />
      <ProjectImagePreviewModal
        visible={Boolean(imagePreviewAttachment)}
        attachment={imagePreviewAttachment}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        onClose={() => setImagePreviewAttachment(null)}
      />
      <ProjectAreaModals
        addArea={addArea}
        areaListMaxHeight={areaListMaxHeight}
        areaManagerListMaxHeight={areaManagerListMaxHeight}
        areaUsage={areaUsage}
        colors={colors}
        expandedAreaColorId={expandedAreaColorId}
        newAreaColor={newAreaColor}
        newAreaName={newAreaName}
        onCloseAreaManager={() => {
          setShowAreaManager(false);
          setExpandedAreaColorId(null);
        }}
        onDeleteArea={deleteArea}
        onSetExpandedAreaColorId={setExpandedAreaColorId}
        onSetNewAreaColor={setNewAreaColor}
        onSetNewAreaName={setNewAreaName}
        onSetSelectedProject={setSelectedProject}
        onSetShowAreaManager={setShowAreaManager}
        onSetShowAreaPicker={setShowAreaPicker}
        onShowToast={showToast}
        overlayModalPresentation={overlayModalPresentation}
        pickerCardMaxHeight={pickerCardMaxHeight}
        selectedProject={selectedProject}
        showAreaManager={showAreaManager}
        showAreaPicker={showAreaPicker}
        sortedAreas={sortedAreas}
        sortAreasByColor={sortAreasByColor}
        sortAreasByName={sortAreasByName}
        t={t}
        tc={tc}
        updateArea={updateArea}
        updateProject={updateProject}
      />
      <ProjectTagPickerModal
        visible={showTagPicker}
        presentationStyle={overlayModalPresentation}
        tc={tc}
        t={t}
        tagDraft={tagDraft}
        projectTagOptions={projectTagOptions}
        selectedTags={selectedProject?.tagIds || []}
        onChangeTagDraft={setTagDraft}
        onAddTag={() => {
          const nextTag = normalizeProjectTag(tagDraft);
          if (!nextTag) return;
          toggleProjectTag(nextTag);
          setTagDraft('');
        }}
        onClose={() => setShowTagPicker(false)}
        onToggleTag={toggleProjectTag}
      />
      </View>
    </GestureHandlerRootView>
  );
}
