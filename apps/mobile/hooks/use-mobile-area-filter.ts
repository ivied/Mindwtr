import { useCallback, useEffect, useMemo } from 'react';
import { type FilterSettings, useTaskStore } from '@mindwtr/core';

import { AREA_FILTER_ALL, AREA_FILTER_NONE, resolveAreaFilter, type AreaFilterValue } from '../lib/area-filter';

let staleAreaFilterResetInFlight: string | null = null;

export function useMobileAreaFilter() {
  const areas = useTaskStore((state) => state.areas);
  const settings = useTaskStore((state) => state.settings);
  const updateSettings = useTaskStore((state) => state.updateSettings);
  const filterSettings: FilterSettings | undefined = settings?.filters;

  const sortedAreas = useMemo(() => (
    [...areas]
      .filter((area) => !area.deletedAt)
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return a.name.localeCompare(b.name);
      })
  ), [areas]);

  const areaById = useMemo(
    () => new Map(sortedAreas.map((area) => [area.id, area])),
    [sortedAreas],
  );

  const resolvedAreaFilter = useMemo(
    () => resolveAreaFilter(filterSettings?.areaId, sortedAreas),
    [filterSettings?.areaId, sortedAreas],
  );
  const didResetDeletedAreaFilter = useMemo(() => {
    const savedAreaFilter = filterSettings?.areaId;
    if (!savedAreaFilter || savedAreaFilter === AREA_FILTER_ALL || savedAreaFilter === AREA_FILTER_NONE) {
      return false;
    }
    return !sortedAreas.some((area) => area.id === savedAreaFilter);
  }, [filterSettings?.areaId, sortedAreas]);

  useEffect(() => {
    const staleAreaFilter = filterSettings?.areaId;
    if (!didResetDeletedAreaFilter || !staleAreaFilter) return;
    if (staleAreaFilterResetInFlight === staleAreaFilter) return;
    staleAreaFilterResetInFlight = staleAreaFilter;
    void updateSettings({
      filters: {
        ...(filterSettings ?? {}),
        areaId: AREA_FILTER_ALL,
      },
    }).finally(() => {
      if (staleAreaFilterResetInFlight === staleAreaFilter) {
        staleAreaFilterResetInFlight = null;
      }
    });
  }, [didResetDeletedAreaFilter, filterSettings, updateSettings]);

  const setAreaFilter = useCallback((value: AreaFilterValue) => {
    void updateSettings({
      filters: {
        ...(filterSettings ?? {}),
        areaId: value,
      },
    });
  }, [filterSettings, updateSettings]);

  const selectedAreaIdForNewTasks = useMemo(() => (
    resolvedAreaFilter !== AREA_FILTER_ALL && resolvedAreaFilter !== AREA_FILTER_NONE
      ? resolvedAreaFilter
      : undefined
  ), [resolvedAreaFilter]);

  return {
    areaById,
    didResetDeletedAreaFilter,
    resolvedAreaFilter,
    selectedAreaIdForNewTasks,
    setAreaFilter,
    sortedAreas,
  };
}
