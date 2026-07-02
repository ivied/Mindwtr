import React from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@mindwtr/core';

import { useProjectNotesEditor } from './use-project-notes-editor';

const makeProject = (supportNotes = ''): Project => ({
  id: 'project-1',
  title: 'Launch',
  status: 'active',
  color: '#3b82f6',
  order: 0,
  tagIds: [],
  supportNotes,
  createdAt: '2026-06-02T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
});

describe('useProjectNotesEditor', () => {
  it('commits the latest project notes draft without waiting for state persistence', () => {
    const updateProject = vi.fn();
    let editor!: ReturnType<typeof useProjectNotesEditor>;

    function Harness() {
      const [selectedProject, setSelectedProject] = React.useState<Project | null>(() => makeProject());
      editor = useProjectNotesEditor({
        selectedProject,
        setSelectedProject,
        updateProject,
        language: 'en',
      });
      return null;
    }

    act(() => {
      create(<Harness />);
    });

    act(() => {
      editor.handleSelectedProjectNotesChange('Draft notes');
      editor.commitSelectedProjectNotes();
    });

    expect(updateProject).toHaveBeenCalledTimes(1);
    expect(updateProject).toHaveBeenCalledWith('project-1', { supportNotes: 'Draft notes' });

    act(() => {
      editor.commitSelectedProjectNotes();
    });

    expect(updateProject).toHaveBeenCalledTimes(1);
  });
});
