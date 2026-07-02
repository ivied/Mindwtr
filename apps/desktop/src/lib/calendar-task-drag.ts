export const CALENDAR_TASK_DRAG_MIME = 'application/x-mindwtr-task-id';
export const CALENDAR_TASK_DRAG_KIND_MIME = 'application/x-mindwtr-calendar-item-kind';

const CALENDAR_TASK_DRAG_TEXT_PREFIX = 'mindwtr-task:';
const CALENDAR_TASK_DRAG_PREVIEW_CLASS = 'mindwtr-calendar-drag-preview';

type CalendarTaskDragDataTransfer = Pick<DataTransfer, 'getData' | 'setData'> & {
    dropEffect?: DataTransfer['dropEffect'];
    effectAllowed?: DataTransfer['effectAllowed'];
    setDragImage?: DataTransfer['setDragImage'];
    types?: readonly string[];
};

type CalendarTaskDragOptions = {
    itemKind?: 'scheduled' | 'deadline';
    variant?: 'calendar-block' | 'compact';
};

const normalizeTaskId = (value: string): string | null => {
    const taskId = value.trim();
    return taskId.length > 0 ? taskId : null;
};

export const setCalendarTaskDragData = (
    dataTransfer: CalendarTaskDragDataTransfer,
    taskId: string,
    options: CalendarTaskDragOptions = {},
): void => {
    const normalizedTaskId = normalizeTaskId(taskId);
    if (!normalizedTaskId) return;

    dataTransfer.effectAllowed = 'move';
    dataTransfer.setData(CALENDAR_TASK_DRAG_MIME, normalizedTaskId);
    if (options.itemKind) {
        dataTransfer.setData(CALENDAR_TASK_DRAG_KIND_MIME, options.itemKind);
    }
    dataTransfer.setData('text/plain', `${CALENDAR_TASK_DRAG_TEXT_PREFIX}${normalizedTaskId}`);

    if (!dataTransfer.setDragImage || typeof document === 'undefined') return;

    document.querySelectorAll(`.${CALENDAR_TASK_DRAG_PREVIEW_CLASS}`).forEach((element) => element.remove());

    const isCalendarBlock = options.variant === 'calendar-block';
    const preview = document.createElement('div');
    preview.className = CALENDAR_TASK_DRAG_PREVIEW_CLASS;
    preview.textContent = '';
    preview.style.position = 'fixed';
    preview.style.top = '-1000px';
    preview.style.left = '-1000px';
    preview.style.boxSizing = 'border-box';
    preview.style.width = isCalendarBlock ? '96px' : '56px';
    preview.style.height = isCalendarBlock ? '28px' : '24px';
    preview.style.margin = '0';
    preview.style.transform = 'none';
    preview.style.border = '1px solid hsl(var(--primary))';
    preview.style.borderRadius = '5px';
    preview.style.background = 'hsl(var(--primary))';
    preview.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.22)';
    preview.style.opacity = '0.92';
    preview.style.pointerEvents = 'none';
    preview.style.zIndex = '2147483647';

    if (isCalendarBlock) {
        const titleLine = document.createElement('div');
        titleLine.style.width = '64px';
        titleLine.style.height = '5px';
        titleLine.style.margin = '6px 0 0 7px';
        titleLine.style.borderRadius = '999px';
        titleLine.style.background = 'rgba(255, 255, 255, 0.75)';
        preview.appendChild(titleLine);

        const timeLine = document.createElement('div');
        timeLine.style.width = '44px';
        timeLine.style.height = '4px';
        timeLine.style.margin = '5px 0 0 7px';
        timeLine.style.borderRadius = '999px';
        timeLine.style.background = 'rgba(255, 255, 255, 0.55)';
        preview.appendChild(timeLine);
    }

    document.body.appendChild(preview);
    dataTransfer.setDragImage(preview, 12, 12);
    window.addEventListener('dragend', () => preview.remove(), { once: true });
};

export const getCalendarTaskDragTaskId = (
    dataTransfer: Pick<DataTransfer, 'getData'> | null,
): string | null => {
    if (!dataTransfer) return null;

    const taskId = normalizeTaskId(dataTransfer.getData(CALENDAR_TASK_DRAG_MIME));
    if (taskId) return taskId;

    const textValue = dataTransfer.getData('text/plain').trim();
    if (!textValue.startsWith(CALENDAR_TASK_DRAG_TEXT_PREFIX)) return null;

    return normalizeTaskId(textValue.slice(CALENDAR_TASK_DRAG_TEXT_PREFIX.length));
};

export const getCalendarTaskDragItemKind = (
    dataTransfer: Pick<DataTransfer, 'getData'> | null,
): 'scheduled' | 'deadline' | null => {
    if (!dataTransfer) return null;
    const kind = dataTransfer.getData(CALENDAR_TASK_DRAG_KIND_MIME).trim();
    return kind === 'scheduled' || kind === 'deadline' ? kind : null;
};

export const hasCalendarTaskDragData = (
    dataTransfer: Pick<DataTransfer, 'getData'> & { types?: readonly string[] } | null,
): boolean => {
    if (!dataTransfer) return false;
    if (dataTransfer.types?.includes(CALENDAR_TASK_DRAG_MIME)) return true;
    return getCalendarTaskDragTaskId(dataTransfer) !== null;
};
