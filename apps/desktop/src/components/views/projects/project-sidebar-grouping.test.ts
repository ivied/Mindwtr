import type { Project } from '@mindwtr/core';
import { describe, expect, it } from 'vitest';

import { splitProjectsForSidebar } from './project-sidebar-grouping';

const now = '2026-04-04T00:00:00.000Z';

const buildProject = (id: string, status: Project['status']): Project => ({
    id,
    title: id,
    status,
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    createdAt: now,
    updatedAt: now,
});

describe('splitProjectsForSidebar', () => {
    it('keeps archived projects out of the deferred section', () => {
        const { active, deferred, archived } = splitProjectsForSidebar([
            buildProject('active', 'active'),
            buildProject('waiting', 'waiting'),
            buildProject('someday', 'someday'),
            buildProject('archived', 'archived'),
        ]);

        expect(active.map((project) => project.id)).toEqual(['active']);
        expect(deferred.map((project) => project.id)).toEqual(['waiting', 'someday']);
        expect(archived.map((project) => project.id)).toEqual(['archived']);
    });
});
