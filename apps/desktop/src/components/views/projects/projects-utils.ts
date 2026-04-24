import { DEFAULT_AREA_COLOR as CORE_DEFAULT_AREA_COLOR, safeFormatDate, safeParseDate, type Area, type Project } from '@mindwtr/core';

export const DEFAULT_AREA_COLOR = CORE_DEFAULT_AREA_COLOR;

export function toDateTimeLocalValue(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const parsed = safeParseDate(dateStr);
    if (!parsed) return dateStr;
    return safeFormatDate(parsed, "yyyy-MM-dd'T'HH:mm", dateStr);
}

export function toDateInputValue(dateStr: string | undefined): string {
    if (!dateStr) return '';
    const parsed = safeParseDate(dateStr);
    if (!parsed) return dateStr;
    return safeFormatDate(parsed, 'yyyy-MM-dd', dateStr);
}

export function normalizeTag(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

export function parseTagInput(input: string): string[] {
    const values = input
        .split(',')
        .map((tag) => normalizeTag(tag))
        .filter(Boolean);
    return Array.from(new Set(values));
}

export function getProjectColor(project: Project, areaById: Map<string, Area>, fallback = DEFAULT_AREA_COLOR): string {
    if (project.areaId) {
        const area = areaById.get(project.areaId);
        if (area?.color) return area.color;
    }
    return fallback;
}

export function sortAreasByName(areas: Area[]): string[] {
    return [...areas]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((area) => area.id);
}

export function sortAreasByColor(areas: Area[]): string[] {
    return [...areas]
        .sort((a, b) => {
            const colorA = (a.color || '').toLowerCase();
            const colorB = (b.color || '').toLowerCase();
            if (colorA && colorB && colorA !== colorB) return colorA.localeCompare(colorB);
            if (colorA && !colorB) return -1;
            if (!colorA && colorB) return 1;
            return a.name.localeCompare(b.name);
        })
        .map((area) => area.id);
}
