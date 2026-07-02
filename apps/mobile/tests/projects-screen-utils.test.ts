import { describe, expect, it } from 'vitest';

import { buildProjectQuickCaptureReturnTo } from '@/components/projects-screen/projects-screen.utils';

describe('project screen utilities', () => {
  it('builds an encoded return route for project quick capture', () => {
    expect(buildProjectQuickCaptureReturnTo('project one/alpha?x'))
      .toBe('/projects-screen?projectId=project%20one%2Falpha%3Fx');
  });
});
