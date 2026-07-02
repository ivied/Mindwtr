import { describe, expect, it } from 'vitest';

import {
    getProjectAreaCollapseKey,
    isProjectAreaCollapsed,
    toggleProjectAreaCollapse,
} from './project-area-collapse';

describe('project-area-collapse', () => {
    it('uses section-scoped collapse keys', () => {
        expect(getProjectAreaCollapseKey('active', 'area-1')).toBe('active:area-1');
        expect(getProjectAreaCollapseKey('deferred', 'area-1')).toBe('deferred:area-1');
    });

    it('falls back to old area-only saved collapse state', () => {
        expect(isProjectAreaCollapsed({ 'area-1': true }, 'active', 'area-1')).toBe(true);
    });

    it('lets one section override old shared state without changing the others', () => {
        const next = toggleProjectAreaCollapse({ 'area-1': true }, 'deferred', 'area-1');

        expect(next).toEqual({
            'area-1': true,
            'deferred:area-1': false,
        });
        expect(isProjectAreaCollapsed(next, 'active', 'area-1')).toBe(true);
        expect(isProjectAreaCollapsed(next, 'deferred', 'area-1')).toBe(false);
    });
});
