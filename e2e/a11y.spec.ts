import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const axeSource = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

test('desktop app has no browser color contrast violations', async ({ page }) => {
    await page.goto('/');
    await page.addScriptTag({ content: axeSource });

    const violations = await page.evaluate(async () => {
        const results = await (window as unknown as {
            axe: {
                run: (
                    context: Document,
                    options: { runOnly: { type: 'rule'; values: string[] } }
                ) => Promise<{
                    violations: Array<{
                        id: string;
                        impact: string | null;
                        description: string;
                        nodes: Array<{
                            target: string[];
                            failureSummary?: string;
                        }>;
                    }>;
                }>;
            };
        }).axe.run(document, {
            runOnly: {
                type: 'rule',
                values: ['color-contrast'],
            },
        });

        return results.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            description: violation.description,
            nodes: violation.nodes.map((node) => ({
                target: node.target,
                failureSummary: node.failureSummary,
            })),
        }));
    });

    expect(violations).toEqual([]);
});
