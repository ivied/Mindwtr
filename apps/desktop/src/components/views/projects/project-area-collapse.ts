export type ProjectAreaSection = 'active' | 'deferred' | 'archived';

export type CollapsedProjectAreas = Record<string, boolean>;

export function getProjectAreaCollapseKey(section: ProjectAreaSection, areaId: string) {
    return `${section}:${areaId}`;
}

export function isProjectAreaCollapsed(
    collapsedAreas: CollapsedProjectAreas,
    section: ProjectAreaSection,
    areaId: string,
) {
    return collapsedAreas[getProjectAreaCollapseKey(section, areaId)] ?? collapsedAreas[areaId] ?? false;
}

export function toggleProjectAreaCollapse(
    collapsedAreas: CollapsedProjectAreas,
    section: ProjectAreaSection,
    areaId: string,
) {
    const key = getProjectAreaCollapseKey(section, areaId);
    return {
        ...collapsedAreas,
        [key]: !isProjectAreaCollapsed(collapsedAreas, section, areaId),
    };
}
