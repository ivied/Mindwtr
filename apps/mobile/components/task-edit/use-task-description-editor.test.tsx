import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';

import { useTaskDescriptionEditor, type TaskDescriptionEditor } from './use-task-description-editor';

type HarnessApi = {
  draft: string;
  editor: TaskDescriptionEditor;
};

const task: Task = {
  id: 'task-1',
  title: 'Task',
  status: 'inbox',
  tags: [],
  contexts: [],
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
};

function DescriptionEditorHarness({
  expose,
}: {
  expose: React.MutableRefObject<HarnessApi | null>;
}) {
  const [descriptionDraft, setDescriptionDraft] = React.useState('');
  const descriptionDraftRef = React.useRef(descriptionDraft);
  const descriptionDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const editor = useTaskDescriptionEditor({
    task,
    descriptionDraft,
    descriptionDraftRef,
    setDescriptionDraft,
    descriptionDebounceRef,
    setEditedTask: vi.fn(),
    resetCopilotDraft: vi.fn(),
    onMarkdownOverlayVisibilityChange: vi.fn(),
    onInputFocusTracked: vi.fn(),
  });

  expose.current = {
    draft: descriptionDraft,
    editor,
  };

  return null;
}

describe('useTaskDescriptionEditor', () => {
  afterEach(() => {
    useTaskStore.setState({ settings: {} });
  });

  it('keeps inline Android description pairs through repeated stale native changes', () => {
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    const preventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '(' },
        preventDefault,
      } as any);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(expose.current!.draft).toBe('()');

    act(() => {
      expose.current!.editor.handleDescriptionChange('(');
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      expose.current!.editor.handleDescriptionChange('(())');
    });

    expect(expose.current!.draft).toBe('()');

    act(() => {
      tree.unmount();
    });
  });

  it('ignores duplicate Android key press echoes before stale native changes arrive', () => {
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    const firstPreventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '[' },
        preventDefault: firstPreventDefault,
      } as any);
    });

    expect(firstPreventDefault).toHaveBeenCalled();
    expect(expose.current!.draft).toBe('[]');

    const duplicatePreventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '[' },
        preventDefault: duplicatePreventDefault,
      } as any);
    });

    expect(duplicatePreventDefault).toHaveBeenCalled();
    expect(expose.current!.draft).toBe('[]');

    act(() => {
      expose.current!.editor.handleDescriptionChange('[[]]');
    });

    expect(expose.current!.draft).toBe('[]');

    act(() => {
      tree.unmount();
    });
  });

  it('types plain text without auto-pairing when editor assist is disabled', () => {
    useTaskStore.setState({ settings: { markdownEditorAssist: false } });
    const expose = React.createRef<HarnessApi | null>();
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<DescriptionEditorHarness expose={expose} />);
    });

    const preventDefault = vi.fn();
    act(() => {
      expose.current!.editor.handleDescriptionKeyPress({
        nativeEvent: { key: '(' },
        preventDefault,
      } as any);
    });

    // No auto-pair: the key press is left to the native input, nothing injected.
    expect(preventDefault).not.toHaveBeenCalled();

    act(() => {
      expose.current!.editor.handleDescriptionChange('(');
    });

    expect(expose.current!.draft).toBe('(');

    act(() => {
      tree.unmount();
    });
  });
});
