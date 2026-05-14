import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@mindwtr/core';

vi.mock('@react-native-community/datetimepicker', () => ({
    __esModule: true,
    default: () => null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => null,
}));

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: any) => children,
}));

vi.mock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: ({ children }: any) => children,
}));

vi.mock('react-native-draggable-flatlist', () => ({
    NestableScrollContainer: ({ children }: any) => children,
}));

vi.mock('../../components/keyboard-accessory-host', () => ({
    KeyboardAccessoryHost: ({ children }: any) => children,
}));

vi.mock('../../components/expanded-markdown-editor', () => ({
    ExpandedMarkdownEditor: () => null,
}));

vi.mock('../../components/markdown-format-toolbar', () => ({
    MarkdownFormatToolbar: () => null,
}));

vi.mock('../../components/markdown-reference-autocomplete', () => ({
    MarkdownReferenceAutocomplete: () => null,
}));

vi.mock('../../components/markdown-text', () => ({
    MarkdownText: () => null,
}));

vi.mock('../../components/task-list', () => ({
    TaskList: () => null,
}));

vi.mock('../../components/AttachmentProgressIndicator', () => ({
    AttachmentProgressIndicator: () => null,
}));

import { getProjectDetailModalSafeAreaEdges, getProjectDetailTaskListOptions } from './ProjectDetailModal';

const project = (status: Project['status']): Project => ({
    id: 'project-1',
    title: 'Launch',
    status,
    color: '#3b82f6',
    order: 0,
    tagIds: [],
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
});

describe('ProjectDetailModal safe area handling', () => {
    it('reserves the top inset for Android full-screen release modals', () => {
        expect(getProjectDetailModalSafeAreaEdges('fullScreen')).toEqual(['top', 'left', 'right', 'bottom']);
    });

    it('preserves the existing page-sheet header spacing path', () => {
        expect(getProjectDetailModalSafeAreaEdges('pageSheet')).toEqual(['left', 'right', 'bottom']);
    });
});

describe('ProjectDetailModal archived projects', () => {
    it('shows archived task data without quick-add or reorder controls', () => {
        expect(getProjectDetailTaskListOptions(project('archived'))).toEqual({
            allowAdd: false,
            enableProjectReorder: false,
            includeArchived: true,
        });
    });

    it('keeps normal task controls for non-archived projects', () => {
        expect(getProjectDetailTaskListOptions(project('active'))).toEqual({
            allowAdd: true,
            enableProjectReorder: true,
            includeArchived: false,
        });
    });
});
