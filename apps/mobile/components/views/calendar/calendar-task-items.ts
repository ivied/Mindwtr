import { hasTimeComponent, safeParseDate, type Task } from '@mindwtr/core';

export const calendarDateKey = (date: Date): string => (
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
);

export const addCalendarMapItem = <T,>(map: Map<string, T[]>, date: Date, item: T) => {
  const key = calendarDateKey(date);
  const items = map.get(key);
  if (items) {
    items.push(item);
    return;
  }
  map.set(key, [item]);
};

export const isTimedScheduledTask = (task: Pick<Task, 'startTime'>): boolean => (
  hasTimeComponent(task.startTime)
);

export const isAllDayScheduledTask = (task: Pick<Task, 'startTime'>): boolean => (
  Boolean(task.startTime) && !hasTimeComponent(task.startTime)
);

export type CalendarTimedLayoutInput = {
  id: string;
  startMinutes: number;
  endMinutes: number;
};

export type CalendarTimedLayout = {
  columnCount: number;
  columnIndex: number;
  leftPercent: number;
  widthPercent: number;
};

type TimedLayoutItem = CalendarTimedLayoutInput & {
  index: number;
};

type TimedLayoutWorkingItem = TimedLayoutItem & {
  columnIndex: number;
};

export const buildTimedCalendarLayouts = (
  items: readonly CalendarTimedLayoutInput[]
): Map<string, CalendarTimedLayout> => {
  const layouts = new Map<string, CalendarTimedLayout>();
  const normalizedItems = items
    .map<TimedLayoutItem | null>((item, index) => {
      if (!Number.isFinite(item.startMinutes) || !Number.isFinite(item.endMinutes)) return null;
      const startMinutes = Math.min(item.startMinutes, item.endMinutes);
      const endMinutes = Math.max(item.startMinutes, item.endMinutes);
      if (endMinutes <= startMinutes) return null;
      return { ...item, startMinutes, endMinutes, index };
    })
    .filter((item): item is TimedLayoutItem => Boolean(item))
    .sort((a, b) =>
      a.startMinutes - b.startMinutes
      || a.endMinutes - b.endMinutes
      || a.index - b.index
    );

  let activeItems: TimedLayoutWorkingItem[] = [];
  let groupItems: TimedLayoutWorkingItem[] = [];

  const flushGroup = () => {
    if (groupItems.length === 0) return;
    const columnCount = Math.max(1, ...groupItems.map((item) => item.columnIndex + 1));
    const widthPercent = 100 / columnCount;
    for (const item of groupItems) {
      layouts.set(item.id, {
        columnCount,
        columnIndex: item.columnIndex,
        leftPercent: item.columnIndex * widthPercent,
        widthPercent,
      });
    }
    groupItems = [];
  };

  for (const item of normalizedItems) {
    activeItems = activeItems.filter((active) => active.endMinutes > item.startMinutes);
    if (activeItems.length === 0) {
      flushGroup();
    }

    const occupiedColumns = new Set(activeItems.map((active) => active.columnIndex));
    let columnIndex = 0;
    while (occupiedColumns.has(columnIndex)) columnIndex += 1;

    const workingItem = { ...item, columnIndex };
    activeItems.push(workingItem);
    groupItems.push(workingItem);
  }

  flushGroup();

  return layouts;
};

export const buildScheduledTasksByDate = (tasks: readonly Task[]): Map<string, Task[]> => {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.startTime) continue;
    const startTime = safeParseDate(task.startTime);
    if (startTime) addCalendarMapItem(map, startTime, task);
  }
  return map;
};
