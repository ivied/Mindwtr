import { describe, expect, it } from 'vitest';

import { resolveTaskContainerHierarchy } from './task-container-rules';

describe('resolveTaskContainerHierarchy', () => {
    it('infers the project from a valid section and clears area scope', () => {
        expect(resolveTaskContainerHierarchy({
            sectionId: 'section-1',
            areaId: 'area-1',
            sectionProjectId: 'project-1',
        })).toEqual({
            projectId: 'project-1',
            sectionId: 'section-1',
            areaId: undefined,
        });
    });

    it('drops sections that do not belong to the selected project', () => {
        expect(resolveTaskContainerHierarchy({
            projectId: 'project-1',
            sectionId: 'section-2',
            areaId: 'area-1',
            sectionProjectId: 'project-2',
        })).toEqual({
            projectId: 'project-1',
            sectionId: undefined,
            areaId: undefined,
        });
    });
});
