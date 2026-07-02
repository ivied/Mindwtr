import { describe, expect, it } from 'vitest';
import { MIND_SWEEP_GROUPS, getMindSweepGroups } from './mind-sweep';
import { en } from './i18n/locales/en';

describe('mind sweep prompt catalog', () => {
    it('has unique group ids and at least four groups per scope', () => {
        const ids = MIND_SWEEP_GROUPS.map((group) => group.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(MIND_SWEEP_GROUPS.filter((group) => group.scope === 'personal').length).toBeGreaterThanOrEqual(4);
        expect(MIND_SWEEP_GROUPS.filter((group) => group.scope === 'work').length).toBeGreaterThanOrEqual(4);
    });

    it('filters groups by scope', () => {
        expect(getMindSweepGroups('all')).toEqual(MIND_SWEEP_GROUPS);
        expect(getMindSweepGroups('personal').every((group) => group.scope === 'personal')).toBe(true);
        expect(getMindSweepGroups('work').every((group) => group.scope === 'work')).toBe(true);
        expect(getMindSweepGroups('personal').length + getMindSweepGroups('work').length)
            .toBe(MIND_SWEEP_GROUPS.length);
    });

    it('declares an English string for every title and prompt key', () => {
        for (const group of MIND_SWEEP_GROUPS) {
            expect(en[group.titleKey], group.titleKey).toBeTruthy();
            expect(group.promptKeys.length).toBeGreaterThanOrEqual(4);
            for (const promptKey of group.promptKeys) {
                expect(en[promptKey], promptKey).toBeTruthy();
            }
        }
    });
});
