import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeMarkdownInternalLinks } from '@mindwtr/core';

import { cn } from '../lib/utils';
import { InternalMarkdownLink } from './InternalMarkdownLink';

function transformMarkdownUrl(url: string) {
    const normalized = url.trim().toLowerCase();
    if (
        normalized.startsWith('mindwtr://')
        || normalized.startsWith('http://')
        || normalized.startsWith('https://')
        || normalized.startsWith('mailto:')
        || normalized.startsWith('tel:')
        || normalized.startsWith('#')
    ) {
        return url;
    }
    return '';
}

export function RichMarkdown({ markdown }: { markdown: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            disallowedElements={['img']}
            urlTransform={transformMarkdownUrl}
            components={{
                a: ({ className, ...props }: any) => (
                    <InternalMarkdownLink
                        href={props.href}
                        className={cn('text-primary underline hover:text-primary/80', className)}
                    >
                        {props.children}
                    </InternalMarkdownLink>
                ),
                ul: ({ className, ...props }: any) => (
                    <ul className={cn('list-disc pl-4 py-1 space-y-0.5', className)} {...props} />
                ),
                ol: ({ className, ...props }: any) => (
                    <ol className={cn('list-decimal pl-4 py-1 space-y-0.5', className)} {...props} />
                ),
                li: ({ className, ...props }: any) => (
                    <li className={cn('pl-1', className)} {...props} />
                ),
                p: ({ className, children, ...props }: any) => (
                    <p className={cn('mb-1 last:mb-0 leading-relaxed', className)} {...props}>
                        {children}
                    </p>
                ),
                code: ({ className, ...props }: any) => (
                    <code className={cn('bg-muted px-1 py-0.5 rounded text-[0.9em] font-mono', className)} {...props} />
                ),
                pre: ({ className, ...props }: any) => (
                    <pre className={cn('bg-muted p-2 rounded-md overflow-x-auto my-1', className)} {...props} />
                ),
                blockquote: ({ className, ...props }: any) => (
                    <blockquote className={cn('border-l-2 border-primary/50 pl-3 italic my-1 text-muted-foreground/80', className)} {...props} />
                ),
                table: ({ className, ...props }: any) => (
                    <div className="overflow-x-auto my-2">
                        <table className={cn('min-w-full divide-y divide-border', className)} {...props} />
                    </div>
                ),
                th: ({ className, ...props }: any) => (
                    <th className={cn('px-2 py-1 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/50', className)} {...props} />
                ),
                td: ({ className, ...props }: any) => (
                    <td className={cn('px-2 py-1 text-sm border-b border-border/50', className)} {...props} />
                ),
                input: ({ type, ...props }: any) => {
                    if (type === 'checkbox') {
                        return <input type="checkbox" className="mr-2 accent-primary" {...props} />;
                    }
                    return <input type={type} {...props} />;
                },
            }}
        >
            {normalizeMarkdownInternalLinks(markdown || '')}
        </ReactMarkdown>
    );
}
