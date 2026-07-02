import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LanguageProvider } from '../contexts/language-context';
import { RichMarkdown } from './RichMarkdown';

describe('RichMarkdown', () => {
    it('renders markdown headings with desktop heading styles', () => {
        render(<RichMarkdown markdown={'# Heading\n\n## Section\n\nBody'} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toHaveClass('text-lg', 'font-semibold');
        expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toHaveClass('text-base', 'font-semibold');
        expect(screen.getByText('Body')).toBeInTheDocument();
    });

    it('preserves soft line breaks inside paragraphs', () => {
        render(<RichMarkdown markdown={'line 1\nline 2'} />);

        expect(screen.getByText(/line 1/)).toHaveClass('whitespace-pre-line');
    });

    it('preserves intentional blank lines between blocks', () => {
        const { container } = render(<RichMarkdown markdown={'line 1\n\nline 2'} />);

        expect(container.querySelectorAll('.mindwtr-markdown-blank-line')).toHaveLength(1);
    });

    it('adds an accessible copy button to fenced code blocks', () => {
        render(
            <LanguageProvider>
                <RichMarkdown markdown={'```ts\nconst value = 1;\n```'} />
            </LanguageProvider>
        );

        expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
        expect(screen.getByText('const value = 1;')).toBeInTheDocument();
    });

    it('keeps RFC 2392 message-id links clickable', () => {
        render(
            <LanguageProvider>
                <RichMarkdown markdown={'Reply from [email](mid:960830.1639@example.com).'} />
            </LanguageProvider>
        );

        expect(screen.getByRole('link', { name: 'email' })).toHaveAttribute('href', 'mid:960830.1639@example.com');
    });
});
