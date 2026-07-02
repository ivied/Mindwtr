export type ProjectListViewState = {
  collapsedAreas: Record<string, boolean>;
  showArchivedProjects: boolean;
  showDeferredProjects: boolean;
};

export const PROJECT_LIST_VIEW_STATE_STORAGE_KEY = 'mindwtr:view:projects:v1';

export const DEFAULT_PROJECT_LIST_VIEW_STATE: ProjectListViewState = {
  collapsedAreas: {},
  showArchivedProjects: false,
  showDeferredProjects: false,
};

export function compactCollapsedAreas(collapsedAreas: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(collapsedAreas).filter(([areaId, collapsed]) => (
      areaId.trim().length > 0 && collapsed === true
    )),
  );
}

export function readProjectListViewState(raw: string | null): ProjectListViewState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectListViewState>;
    const collapsedAreas = parsed.collapsedAreas && typeof parsed.collapsedAreas === 'object' && !Array.isArray(parsed.collapsedAreas)
      ? Object.fromEntries(
        Object.entries(parsed.collapsedAreas).filter(([areaId, collapsed]) => (
          typeof areaId === 'string' && areaId.trim().length > 0 && collapsed === true
        )),
      )
      : {};
    return {
      collapsedAreas,
      showArchivedProjects: typeof parsed.showArchivedProjects === 'boolean'
        ? parsed.showArchivedProjects
        : DEFAULT_PROJECT_LIST_VIEW_STATE.showArchivedProjects,
      showDeferredProjects: typeof parsed.showDeferredProjects === 'boolean'
        ? parsed.showDeferredProjects
        : DEFAULT_PROJECT_LIST_VIEW_STATE.showDeferredProjects,
    };
  } catch {
    return null;
  }
}

export function serializeProjectListViewState(state: ProjectListViewState): string {
  return JSON.stringify({
    collapsedAreas: compactCollapsedAreas(state.collapsedAreas),
    showArchivedProjects: state.showArchivedProjects,
    showDeferredProjects: state.showDeferredProjects,
  });
}
