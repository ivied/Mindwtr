import { describe, expect, it } from 'vitest';

import {
  buildTaskListMeasuredHeightKey,
  buildTaskListItemLayouts,
  buildTaskListVirtualizedItemKey,
  ESTIMATED_SECTION_HEIGHT,
  ESTIMATED_TASK_HEIGHT,
  LIST_CONTENT_VERTICAL_PADDING,
} from './task-list-layout';

describe('task-list-layout', () => {
  it('accumulates offsets with mixed section and task row estimates', () => {
    const layouts = buildTaskListItemLayouts([
      { type: 'section' },
      { type: 'task' },
      { type: 'task' },
      { type: 'section' },
      { type: 'task' },
    ]);

    expect(layouts).toEqual([
      { length: ESTIMATED_SECTION_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING },
      { length: ESTIMATED_TASK_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING + ESTIMATED_SECTION_HEIGHT },
      { length: ESTIMATED_TASK_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING + ESTIMATED_SECTION_HEIGHT + ESTIMATED_TASK_HEIGHT },
      { length: ESTIMATED_SECTION_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING + ESTIMATED_SECTION_HEIGHT + (ESTIMATED_TASK_HEIGHT * 2) },
      { length: ESTIMATED_TASK_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING + (ESTIMATED_SECTION_HEIGHT * 2) + (ESTIMATED_TASK_HEIGHT * 2) },
    ]);
  });

  it('uses measured row heights while preserving mixed offsets', () => {
    const layouts = buildTaskListItemLayouts(
      [
        { id: 'today', type: 'section' },
        { id: 'a', type: 'task' },
        { id: 'b', type: 'task' },
      ],
      {
        getItemKey: (item) => item.id,
        measuredHeights: { a: 104 },
      },
    );

    expect(layouts).toEqual([
      { length: ESTIMATED_SECTION_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING },
      { length: 104, offset: LIST_CONTENT_VERTICAL_PADDING + ESTIMATED_SECTION_HEIGHT },
      { length: ESTIMATED_TASK_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING + ESTIMATED_SECTION_HEIGHT + 104 },
    ]);
  });

  it('keeps virtualization keys stable when a surviving row moves', () => {
    expect(buildTaskListVirtualizedItemKey('task-a', 8)).toBe(
      buildTaskListVirtualizedItemKey('task-a', 0),
    );
  });

  it('does not reuse measured heights across task layout revisions', () => {
    const staleHeightKey = buildTaskListMeasuredHeightKey('task-a', 1);
    const refreshedHeightKey = buildTaskListMeasuredHeightKey('task-a', 2);

    const layouts = buildTaskListItemLayouts(
      [{ type: 'task', key: refreshedHeightKey }],
      {
        getItemKey: (item) => item.key,
        measuredHeights: { [staleHeightKey]: 180 },
      },
    );

    expect(layouts).toEqual([
      { length: ESTIMATED_TASK_HEIGHT, offset: LIST_CONTENT_VERTICAL_PADDING },
    ]);
  });
});
