export const getBulkActionFailureMessage = (error: unknown, fallback: string): string => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = message.trim();
    return trimmed || fallback;
};

export type ProjectTaskReorderListItem<T> =
    | { type: 'section'; id: string; muted?: boolean; title?: string }
    | { type: 'task'; reorderSectionId?: string | null; task: T };

export type ProjectTaskReorderGroup<T> = {
    id: string;
    muted?: boolean;
    sectionId?: string | null;
    tasks: T[];
    title?: string;
};

export function buildProjectTaskReorderGroups<T>(
    items: ProjectTaskReorderListItem<T>[],
    options: { includeEmptySections?: boolean } = {},
): ProjectTaskReorderGroup<T>[] {
    const groups: ProjectTaskReorderGroup<T>[] = [];
    let currentGroup: ProjectTaskReorderGroup<T> | null = null;

    items.forEach((item) => {
        if (item.type === 'section') {
            currentGroup = {
                id: item.id,
                muted: item.muted,
                sectionId: item.id === 'no-section' ? null : item.id,
                tasks: [],
                title: item.title,
            };
            groups.push(currentGroup);
            return;
        }

        if (!currentGroup) {
            currentGroup = {
                id: 'project',
                sectionId: item.reorderSectionId,
                tasks: [],
            };
            groups.push(currentGroup);
        }
        currentGroup.tasks.push(item.task);
    });

    return options.includeEmptySections
        ? groups
        : groups.filter((group) => group.tasks.length > 0);
}

export function sortProjectTasksByOrder<T extends { createdAt: string; order?: number; orderNum?: number }>(tasks: T[]): T[] {
  const sorted = [...tasks];
  const hasOrder = sorted.some((task) => Number.isFinite(task.order) || Number.isFinite(task.orderNum));
    return sorted.sort((a, b) => {
        if (hasOrder) {
            const aOrder = Number.isFinite(a.order)
                ? (a.order as number)
                : Number.isFinite(a.orderNum)
                    ? (a.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            const bOrder = Number.isFinite(b.order)
                ? (b.order as number)
                : Number.isFinite(b.orderNum)
                    ? (b.orderNum as number)
                    : Number.POSITIVE_INFINITY;
            if (aOrder !== bOrder) return aOrder - bOrder;
        }

        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

export type StaticListVirtualWindow<T> = {
  bottomSpacerHeight: number;
  items: T[];
  startIndex: number;
  topSpacerHeight: number;
};

export function resolveStaticListViewportHeight(viewportHeight: number, fallbackHeight: number): number {
  if (Number.isFinite(viewportHeight) && viewportHeight > 0) {
    return viewportHeight;
  }
  if (Number.isFinite(fallbackHeight) && fallbackHeight > 0) {
    return fallbackHeight;
  }
  return 0;
}

export function buildStaticListVirtualWindow<T>(
  items: T[],
  options: {
    listOffsetY: number;
    overscan: number;
    rowEstimate: number;
    scrollOffsetY: number;
    viewportHeight: number;
  },
): StaticListVirtualWindow<T> {
  const relativeScrollY = Math.max(0, options.scrollOffsetY - options.listOffsetY);
  const startIndex = Math.max(
    0,
    Math.floor(relativeScrollY / options.rowEstimate) - options.overscan,
  );
  const visibleCount = Math.ceil(options.viewportHeight / options.rowEstimate) + options.overscan * 2;
  const endIndex = Math.min(items.length, startIndex + visibleCount);

  return {
    bottomSpacerHeight: Math.max(0, (items.length - endIndex) * options.rowEstimate),
    items: items.slice(startIndex, endIndex),
    startIndex,
    topSpacerHeight: startIndex * options.rowEstimate,
  };
}
