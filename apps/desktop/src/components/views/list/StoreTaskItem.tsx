import { memo, useCallback, type ComponentProps } from 'react';
import { type RangeSelectionOptions, type Task, useProjectById, useTaskById } from '@mindwtr/core';
import { TaskItem } from '../../TaskItem';

type TaskItemProps = ComponentProps<typeof TaskItem>;
type FocusToggle = TaskItemProps['focusToggle'];

export type StoreTaskItemProps = Omit<TaskItemProps, 'task' | 'project' | 'focusToggle' | 'onSelect' | 'onToggleSelect'> & {
    taskId: string;
    index?: number;
    onSelectIndex?: (index: number) => void;
    onToggleSelectId?: (id: string, options?: RangeSelectionOptions) => void;
    buildFocusToggle?: (task: Task) => FocusToggle;
    projectDeadlineLabel?: string;
};

export const StoreTaskItem = memo(function StoreTaskItem({
    taskId,
    index,
    onSelectIndex,
    onToggleSelectId,
    buildFocusToggle,
    ...taskItemProps
}: StoreTaskItemProps) {
    const task = useTaskById(taskId);
    const project = useProjectById(task?.projectId);
    const handleSelect = useCallback(() => {
        if (typeof index === 'number') {
            onSelectIndex?.(index);
        }
    }, [index, onSelectIndex]);
    const handleToggleSelect = useCallback((options?: RangeSelectionOptions) => {
        onToggleSelectId?.(taskId, options);
    }, [onToggleSelectId, taskId]);

    if (!task) return null;

    return (
        <TaskItem
            {...taskItemProps}
            task={task}
            project={project}
            onSelect={typeof index === 'number' && onSelectIndex ? handleSelect : undefined}
            onToggleSelect={onToggleSelectId ? handleToggleSelect : undefined}
            focusToggle={buildFocusToggle ? buildFocusToggle(task) : undefined}
        />
    );
});
