import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownText } from './markdown-text';

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const mockState = {
    _allTasks: [],
    projects: [],
  };
  const useTaskStore = ((selector?: (state: typeof mockState) => unknown) => (
    typeof selector === 'function' ? selector(mockState) : mockState
  )) as typeof actual.useTaskStore;

  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openProjectScreen: vi.fn(),
  openTaskScreen: vi.fn(),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

const flattenText = (
  value: renderer.ReactTestRendererNode | renderer.ReactTestRendererNode[] | null,
): string => {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
  return flattenText(value.children);
};

describe('MarkdownText', () => {
  it('renders fenced code blocks without stalling on the opening fence', () => {
    const markdown = [
      '## Setup commands',
      '```bash',
      'npx create-next-app@latest client-site --typescript',
      'cd client-site',
      'npm install tailwindcss @shadcn/ui',
      '```',
      '',
      '## Folder structure',
      '```',
      'src/',
      '  app/',
      '    page.tsx',
      '    layout.tsx',
      '  components/',
      '    ui/',
      '    sections/',
      '```',
    ].join('\n');

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <MarkdownText
          markdown={markdown}
          tc={{
            text: '#fff',
            secondaryText: '#aaa',
            tint: '#3b82f6',
            border: '#334155',
            filterBg: '#111827',
          } as any}
          direction="ltr"
        />
      );
    });

    const rendered = flattenText(tree.toJSON());
    expect(rendered).toContain('Setup commands');
    expect(rendered).toContain('npx create-next-app@latest client-site --typescript');
    expect(rendered).toContain('Folder structure');
    expect(rendered).toContain('page.tsx');
  });
});
