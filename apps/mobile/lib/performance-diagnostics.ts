import { Platform } from 'react-native';
import {
  PERFORMANCE_LOG_MESSAGE,
  PERFORMANCE_LOG_SCOPE,
  beginPerformanceLogMeasurement,
  useTaskStore,
  type PerformanceLogMeasurementFinishInput,
  type PerformanceLogMeasurementInput,
  type PerformanceOperation,
  type PerformanceRoute,
} from '@mindwtr/core';

import { logInfo } from './app-log';

type StoreCounts = {
  taskCount?: number;
  projectCount?: number;
  areaCount?: number;
  sectionCount?: number;
};

type MobilePerformanceInput = {
  operation: PerformanceOperation;
  route: PerformanceRoute;
  listItemCount?: number;
  visibleItemCount?: number;
  filterCount?: number;
};

type MobilePerformanceMeasurement = ReturnType<typeof beginPerformanceLogMeasurement>;

const countArray = (value: unknown): number | undefined => (
  Array.isArray(value) ? value.length : undefined
);

function getStoreCounts(): StoreCounts {
  const state = useTaskStore.getState() as unknown as Record<string, unknown>;
  return {
    taskCount: countArray(state._allTasks) ?? countArray(state.tasks),
    projectCount: countArray(state.projects),
    areaCount: countArray(state.areas),
    sectionCount: countArray(state.sections),
  };
}

function diagnosticsLoggingEnabled(): boolean {
  const state = useTaskStore.getState() as { settings?: { diagnostics?: { loggingEnabled?: boolean } } };
  return state.settings?.diagnostics?.loggingEnabled === true;
}

function mobilePlatform(): 'android' | 'ios' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

export function resolveMobilePerformanceRoute({
  projectId,
  statusFilter,
}: {
  projectId?: string;
  statusFilter?: string;
}): PerformanceRoute {
  if (projectId) return 'project';
  if (statusFilter === 'inbox' || statusFilter === 'next') return statusFilter;
  if (statusFilter === 'focus' || statusFilter === 'review' || statusFilter === 'search') return statusFilter;
  return 'unknown';
}

export function beginMobilePerformanceDiagnostic(input: MobilePerformanceInput): MobilePerformanceMeasurement {
  const counts = getStoreCounts();
  const measurementInput: PerformanceLogMeasurementInput = {
    ...input,
    ...counts,
    platform: mobilePlatform(),
  };
  return beginPerformanceLogMeasurement(measurementInput, {
    diagnosticsEnabled: diagnosticsLoggingEnabled(),
  });
}

export async function finishMobilePerformanceDiagnostic(
  measurement: MobilePerformanceMeasurement,
  finishInput?: PerformanceLogMeasurementFinishInput,
): Promise<string | null> {
  if (!measurement) return null;
  const context = measurement.finish(finishInput);
  try {
    return await logInfo(PERFORMANCE_LOG_MESSAGE, {
      scope: PERFORMANCE_LOG_SCOPE,
      extra: context,
    });
  } catch {
    return null;
  }
}
