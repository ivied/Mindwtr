import { formatTimeEstimateLabel as formatCoreTimeEstimateLabel, timeEstimateToFilterBucket, type Task, type TimeEstimate } from '@mindwtr/core';

export const MOBILE_TIME_ESTIMATE_OPTIONS: TimeEstimate[] = [
    '5min',
    '10min',
    '15min',
    '30min',
    '1hr',
    '2hr',
    '3hr',
    '4hr',
    '4hr+',
];

export const formatTimeEstimateChipLabel = formatCoreTimeEstimateLabel;

export const matchesSelectedTimeEstimates = (
    task: Pick<Task, 'timeEstimate'>,
    selectedTimeEstimates: TimeEstimate[]
): boolean => {
    if (selectedTimeEstimates.length === 0) return true;
    const bucket = timeEstimateToFilterBucket(task.timeEstimate);
    return Boolean(bucket && selectedTimeEstimates.includes(bucket));
};
