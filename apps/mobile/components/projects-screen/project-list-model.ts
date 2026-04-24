import type { Area, Project } from '@mindwtr/core';

import type { ProjectSection } from '@/hooks/use-project-filtering';

export type ProjectListRow =
  | { type: 'section-label'; key: string; title: string }
  | { type: 'section-toggle'; key: string; title: string; expanded: boolean; sectionKind: 'deferred' | 'archived' }
  | {
      type: 'area-header';
      key: string;
      title: string;
      areaId: string;
      collapsed: boolean;
      sectionKind: 'active' | 'deferred' | 'archived';
      color?: string;
      icon?: string;
    }
  | { type: 'project'; key: string; project: Project; sectionKind: 'active' | 'deferred' | 'archived' };

type BuildProjectListRowsParams = {
  areaById: Map<string, Area>;
  collapsedAreas: Record<string, boolean>;
  groupedActiveProjects: ProjectSection[];
  groupedArchivedProjects: ProjectSection[];
  groupedDeferredProjects: ProjectSection[];
  showArchivedProjects: boolean;
  showDeferredProjects: boolean;
  t: (key: string) => string;
};

function buildAreaRows(
  sectionKind: 'active' | 'deferred' | 'archived',
  groups: ProjectSection[],
  areaById: Map<string, Area>,
  collapsedAreas: Record<string, boolean>,
): ProjectListRow[] {
  const rows: ProjectListRow[] = [];

  groups.forEach((group) => {
    const area = group.areaId !== 'no-area' ? areaById.get(group.areaId) : undefined;
    const collapsed = collapsedAreas[group.areaId] ?? false;

    rows.push({
      type: 'area-header',
      key: `${sectionKind}-area-${group.areaId}`,
      title: group.title,
      areaId: group.areaId,
      collapsed,
      sectionKind,
      color: area?.color,
      icon: area?.icon,
    });

    if (collapsed) return;

    group.data.forEach(({ data: project }) => {
      rows.push({
        type: 'project',
        key: `${sectionKind}-project-${project.id}`,
        project,
        sectionKind,
      });
    });
  });

  return rows;
}

export function buildProjectListRows({
  areaById,
  collapsedAreas,
  groupedActiveProjects,
  groupedArchivedProjects,
  groupedDeferredProjects,
  showArchivedProjects,
  showDeferredProjects,
  t,
}: BuildProjectListRowsParams): ProjectListRow[] {
  const rows: ProjectListRow[] = [];

  if (groupedActiveProjects.length > 0) {
    rows.push({
      type: 'section-label',
      key: 'active-projects',
      title: t('projects.activeSection'),
    });
    rows.push(...buildAreaRows('active', groupedActiveProjects, areaById, collapsedAreas));
  }

  if (groupedDeferredProjects.length > 0) {
    rows.push({
      type: 'section-toggle',
      key: 'deferred-projects',
      title: t('projects.deferredSection'),
      expanded: showDeferredProjects,
      sectionKind: 'deferred',
    });
    if (showDeferredProjects) {
      rows.push(...buildAreaRows('deferred', groupedDeferredProjects, areaById, collapsedAreas));
    }
  }

  if (groupedArchivedProjects.length > 0) {
    rows.push({
      type: 'section-toggle',
      key: 'archived-projects',
      title: t('status.archived'),
      expanded: showArchivedProjects,
      sectionKind: 'archived',
    });
    if (showArchivedProjects) {
      rows.push(...buildAreaRows('archived', groupedArchivedProjects, areaById, collapsedAreas));
    }
  }

  return rows;
}
