import { shallow, useTaskStore } from '@mindwtr/core';

export const useProjectsViewStore = () =>
    useTaskStore(
        (state) => ({
            projects: state.projects,
            tasks: state.tasks,
            sections: state.sections,
            areas: state.areas,
            addArea: state.addArea,
            updateArea: state.updateArea,
            deleteArea: state.deleteArea,
            reorderAreas: state.reorderAreas,
            reorderProjects: state.reorderProjects,
            reorderSections: state.reorderSections,
            reorderProjectTasks: state.reorderProjectTasks,
            addProject: state.addProject,
            updateProject: state.updateProject,
            deleteProject: state.deleteProject,
            restoreProject: state.restoreProject,
            duplicateProject: state.duplicateProject,
            updateTask: state.updateTask,
            batchMoveTasks: state.batchMoveTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            batchUpdateTasks: state.batchUpdateTasks,
            addSection: state.addSection,
            updateSection: state.updateSection,
            deleteSection: state.deleteSection,
            toggleProjectFocus: state.toggleProjectFocus,
            allTasks: state._allTasks,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
            settings: state.settings,
            getDerivedState: state.getDerivedState,
            focusedProjectCount: state.getDerivedState().focusedProjectCount,
        }),
        shallow
    );
