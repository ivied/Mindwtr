import type { AppSettings, Area, DefaultTaskAreaMode } from './types';
import { nextRevision } from './sync-revision';

export const normalizeAreaNameKey = (name: unknown): string => (
    typeof name === 'string' ? name.trim().toLowerCase() : ''
);

export const getDefaultTaskAreaMode = (
    settings: AppSettings | undefined
): DefaultTaskAreaMode => {
    const mode = settings?.gtd?.defaultAreaMode;
    if (mode === 'none' || mode === 'fixed' || mode === 'active') return mode;
    return settings?.gtd?.defaultAreaId ? 'fixed' : 'none';
};

export const resolveDefaultNewTaskAreaId = (
    settings: AppSettings | undefined,
    areas: readonly Area[]
): string | undefined => {
    if (getDefaultTaskAreaMode(settings) !== 'fixed') return undefined;
    const configuredAreaId = settings?.gtd?.defaultAreaId;
    if (typeof configuredAreaId !== 'string') return undefined;
    const areaId = configuredAreaId.trim();
    if (!areaId) return undefined;
    return areas.some((area) => area.id === areaId && !area.deletedAt) ? areaId : undefined;
};

const compareAreaDedupeWinner = (left: Area, right: Area): number => {
    const createdAtCompare = left.createdAt.localeCompare(right.createdAt);
    if (createdAtCompare !== 0) return createdAtCompare;
    return left.id.localeCompare(right.id);
};

export const dedupeLiveAreasByName = (
    areas: readonly Area[],
    options: { nowIso: string; revBy?: string }
): { areas: Area[]; areaIdRemap: Map<string, string>; changed: boolean } => {
    const areaByName = new Map<string, Area>();
    const areaIdRemap = new Map<string, string>();
    let changed = false;

    for (const area of areas) {
        if (area.deletedAt) continue;
        const nameKey = normalizeAreaNameKey(area.name);
        if (!nameKey) continue;

        const existing = areaByName.get(nameKey);
        if (!existing || compareAreaDedupeWinner(area, existing) < 0) {
            areaByName.set(nameKey, area);
        }
    }

    const nextAreas = areas.map((area) => {
        if (area.deletedAt) return area;
        const nameKey = normalizeAreaNameKey(area.name);
        if (!nameKey) return area;

        const canonicalArea = areaByName.get(nameKey);
        if (!canonicalArea || canonicalArea.id === area.id) {
            return area;
        }

        changed = true;
        areaIdRemap.set(area.id, canonicalArea.id);
        return {
            ...area,
            deletedAt: options.nowIso,
            updatedAt: options.nowIso,
            rev: nextRevision(area.rev),
            ...(options.revBy ? { revBy: options.revBy } : {}),
        };
    });

    return { areas: nextAreas, areaIdRemap, changed };
};
