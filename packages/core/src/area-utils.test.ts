import { describe, expect, it } from 'vitest';

import { dedupeLiveAreasByName } from './area-utils';
import type { Area } from './types';

const NOW = '2026-01-01T00:00:00.000Z';

const area = (overrides: Partial<Area>): Area => ({
    id: overrides.id ?? 'area',
    name: overrides.name ?? 'Work',
    order: overrides.order ?? 0,
    createdAt: overrides.createdAt ?? '2025-12-31T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2025-12-31T00:00:00.000Z',
    ...overrides,
});

describe('dedupeLiveAreasByName', () => {
    it('chooses the same canonical area regardless of input order', () => {
        const laterId = area({ id: 'area-z', name: 'Work', rev: 2 });
        const earlierId = area({ id: 'area-a', name: ' work ', rev: 4 });

        const forward = dedupeLiveAreasByName([laterId, earlierId], { nowIso: NOW, revBy: 'sync-repair' });
        const reverse = dedupeLiveAreasByName([earlierId, laterId], { nowIso: NOW, revBy: 'sync-repair' });

        expect(forward.areaIdRemap.get('area-z')).toBe('area-a');
        expect(reverse.areaIdRemap.get('area-z')).toBe('area-a');
        expect(forward.areas.find((item) => item.id === 'area-a')?.deletedAt).toBeUndefined();
        expect(reverse.areas.find((item) => item.id === 'area-a')?.deletedAt).toBeUndefined();
        expect(forward.areas.find((item) => item.id === 'area-z')).toMatchObject({
            deletedAt: NOW,
            updatedAt: NOW,
            rev: 3,
            revBy: 'sync-repair',
        });
        expect(reverse.areas.find((item) => item.id === 'area-z')).toMatchObject({
            deletedAt: NOW,
            updatedAt: NOW,
            rev: 3,
            revBy: 'sync-repair',
        });
    });
});
