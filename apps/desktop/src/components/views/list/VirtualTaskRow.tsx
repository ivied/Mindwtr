import React, { useLayoutEffect, useRef } from 'react';
import { useTaskById } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { StoreTaskItem } from './StoreTaskItem';

type VirtualTaskRowProps = {
    taskId: string;
    index: number;
    top: number;
    isSelected?: boolean;
    selectionMode?: boolean;
    isMultiSelected?: boolean;
    onSelectIndex?: (index: number) => void;
    onToggleSelectId: (id: string) => void;
    onMeasure: (id: string, height: number) => void;
    showQuickDone?: boolean;
    readOnly?: boolean;
    compactMetaEnabled?: boolean;
    dense?: boolean;
    showProjectBadgeInActions?: boolean;
    gapClassName?: string;
    showDivider?: boolean;
};

export const VirtualTaskRow = React.memo(function VirtualTaskRow({
    taskId,
    index,
    top,
    isSelected,
    selectionMode = false,
    isMultiSelected = false,
    onSelectIndex,
    onToggleSelectId,
    onMeasure,
    showQuickDone = true,
    readOnly = false,
    compactMetaEnabled = true,
    dense = false,
    showProjectBadgeInActions = true,
    gapClassName,
    showDivider = true,
}: VirtualTaskRowProps) {
    const task = useTaskById(taskId);
    const rowRef = useRef<HTMLDivElement | null>(null);

    useLayoutEffect(() => {
        const node = rowRef.current;
        if (!node || !task) return undefined;
        // `useTaskById` preserves task object identity for unchanged rows, so `[task]`
        // re-measures only when this row's task actually changes.
        const measure = () => {
            const nextHeight = Math.ceil(node.getBoundingClientRect().height);
            onMeasure(task.id, nextHeight);
        };
        measure();
    }, [task, onMeasure]);

    if (!task) return null;

    return (
        <div ref={rowRef} style={{ position: 'absolute', top, left: 0, right: 0 }}>
            <div className={cn(gapClassName ?? (dense ? "pb-1" : "pb-1.5"))}>
                <StoreTaskItem
                    taskId={taskId}
                    isSelected={isSelected}
                    index={index}
                    onSelectIndex={onSelectIndex}
                    selectionMode={selectionMode}
                    isMultiSelected={isMultiSelected}
                    onToggleSelectId={onToggleSelectId}
                    showQuickDone={showQuickDone}
                    readOnly={readOnly}
                    compactMetaEnabled={compactMetaEnabled}
                    showProjectBadgeInActions={showProjectBadgeInActions}
                />
                {showDivider ? <div className="mx-3 mt-1 h-px bg-border/30" /> : null}
            </div>
        </div>
    );
});
