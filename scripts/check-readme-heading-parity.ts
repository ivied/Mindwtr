import { readFileSync } from 'fs';

type Heading = {
    level: number;
    text: string;
    line: number;
};

const readHeadings = (path: string): Heading[] => {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const headings: Heading[] = [];
    let inFence = false;

    lines.forEach((line, index) => {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            return;
        }
        if (inFence) return;
        const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
        if (!match) return;
        headings.push({
            level: match[1].length,
            text: match[2],
            line: index + 1,
        });
    });

    return headings;
};

const formatHeading = (heading: Heading | undefined): string => {
    if (!heading) return '(missing)';
    return `${'#'.repeat(heading.level)} ${heading.text} (line ${heading.line})`;
};

const main = () => {
    const english = readHeadings('README.md');
    const chinese = readHeadings('README_zh.md');
    const maxLength = Math.max(english.length, chinese.length);
    const mismatches: string[] = [];

    for (let index = 0; index < maxLength; index += 1) {
        const left = english[index];
        const right = chinese[index];
        if (!left || !right || left.level !== right.level) {
            mismatches.push(
                `heading ${index + 1}: README.md=${formatHeading(left)} README_zh.md=${formatHeading(right)}`
            );
        }
    }

    if (mismatches.length > 0) {
        console.error('README heading parity check failed. Keep README.md and README_zh.md section structure aligned.');
        for (const mismatch of mismatches) {
            console.error(`- ${mismatch}`);
        }
        process.exit(1);
    }
};

main();
