import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { ExpandedMarkdownEditor } from './ExpandedMarkdownEditor';

describe('ExpandedMarkdownEditor', () => {
    it('renders GFM tables in preview mode', () => {
        const { container, getByRole, getByText } = render(
            <div style={{ transform: 'translateY(50px)' }}>
                <ExpandedMarkdownEditor
                    isOpen
                    onClose={vi.fn()}
                    value={[
                        '## Browsers to test',
                        '',
                        '| Browser | Version |',
                        '| ------- | ------- |',
                        '| Chrome | 124+ |',
                        '| Safari | 17+ |',
                    ].join('\n')}
                    onChange={vi.fn()}
                    title="Description"
                    placeholder="Description"
                    t={(key) => key}
                    initialMode="preview"
                    selection={{ start: 0, end: 0 }}
                    canUndo={false}
                    onUndo={() => undefined}
                    onApplyAction={() => undefined}
                    onSelectionChange={vi.fn()}
                />
            </div>,
        );

        expect(container.querySelector('[role="dialog"]')).toBeNull();
        expect(getByRole('dialog')).toBeInTheDocument();
        expect(getByRole('table')).toBeInTheDocument();
        expect(getByText('Chrome')).toBeInTheDocument();
        expect(getByText('124+')).toBeInTheDocument();
    });
});
