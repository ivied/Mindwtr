import { memo, useCallback, type ComponentProps } from 'react';
import { type Task, useProjectById, useTaskById } from '@mindwtr/core';
import { TaskItem } from '../../TaskItem';

type TaskItemProps = ComponentProps<typeof TaskItem>;
type FocusToggle = TaskItemProps['focusToggle'];

export type StoreTaskItemProps = Omit<TaskItemProps, 'task' | 'project' | 'focusToggle' | 'onSelect' | 'onToggleSelect'> & {
    taskId: string;
    index?: number;
    onSelectIndex?: (index: number) => void;
    onToggleSelectId?: (id: string) => void;
    buildFocusToggle?: (task: Task) => FocusToggle;
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
    const handleToggleSelect = useCallback(() => {
        onToggleSelectId?.(taskId);
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
