export const LIST_CONTENT_VERTICAL_PADDING = 12;
export const ESTIMATED_SECTION_HEIGHT = 32;
export const ESTIMATED_TASK_HEIGHT = 86;

export type TaskListLayoutItem = { type: 'section' } | { type: 'task' };
export type TaskListItemLayout = { length: number; offset: number };
export type TaskListLayoutRevision = string | number | null | undefined;

export function estimateTaskListItemHeight(item: TaskListLayoutItem): number {
  return item.type === 'section' ? ESTIMATED_SECTION_HEIGHT : ESTIMATED_TASK_HEIGHT;
}

export function buildTaskListMeasuredHeightKey(
  itemKey: string,
  layoutRevision: TaskListLayoutRevision,
): string {
  if (layoutRevision === null || layoutRevision === undefined || layoutRevision === '') {
    return itemKey;
  }
  return `${itemKey}@layout:${layoutRevision}`;
}

export function buildTaskListVirtualizedItemKey(itemKey: string, index: number): string {
  void index;
  return itemKey;
}

type BuildTaskListItemLayoutsOptions<T extends TaskListLayoutItem> = {
  getItemKey?: (item: T) => string;
  initialOffset?: number;
  measuredHeights?: Readonly<Record<string, number>>;
};

export function buildTaskListItemLayouts<T extends TaskListLayoutItem>(
  items: readonly T[],
  options: BuildTaskListItemLayoutsOptions<T> = {},
): TaskListItemLayout[] {
  const {
    getItemKey,
    initialOffset = LIST_CONTENT_VERTICAL_PADDING,
    measuredHeights,
  } = options;

  let offset = initialOffset;
  return items.map((item) => {
    const measuredHeight = getItemKey ? measuredHeights?.[getItemKey(item)] : undefined;
    const length = typeof measuredHeight === 'number' && Number.isFinite(measuredHeight) && measuredHeight > 0
      ? measuredHeight
      : estimateTaskListItemHeight(item);
    const layout = { length, offset };
    offset += length;
    return layout;
  });
}
