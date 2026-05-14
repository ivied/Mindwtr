#!/usr/bin/env node

const fs = require('fs');

const [title, summaryPath, ...args] = process.argv.slice(2);

if (!title || !summaryPath) {
  console.error('Usage: write-coverage-summary.js <title> <coverage-summary.json> [--min-lines=<percent>] [--min-statements=<percent>] [--min-functions=<percent>] [--min-branches=<percent>]');
  process.exit(2);
}

const getArgValue = (name, fallback) => {
  const arg = args.find((candidate) => candidate.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
};

const parseThreshold = (label, raw) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(`Invalid ${label} coverage threshold: ${raw}`);
    process.exit(2);
  }
  return value;
};

const thresholds = {
  lines: parseThreshold('line', getArgValue('--min-lines', process.env.COVERAGE_MIN_LINES || '70')),
  statements: parseThreshold('statement', getArgValue('--min-statements', process.env.COVERAGE_MIN_STATEMENTS || '70')),
  functions: parseThreshold('function', getArgValue('--min-functions', process.env.COVERAGE_MIN_FUNCTIONS || '50')),
  branches: parseThreshold('branch', getArgValue('--min-branches', process.env.COVERAGE_MIN_BRANCHES || '50')),
};

if (!fs.existsSync(summaryPath)) {
  console.error(`Coverage summary missing at ${summaryPath}`);
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const total = summary.total;
const metrics = ['lines', 'statements', 'functions', 'branches'];

if (!total || metrics.some((metric) => !total[metric] || typeof total[metric].pct !== 'number')) {
  console.error(`Coverage summary at ${summaryPath} is missing total coverage metrics`);
  process.exit(1);
}

const rows = metrics.map((metric) => {
  const label = metric.charAt(0).toUpperCase() + metric.slice(1);
  const data = total[metric];
  return `| ${label} | ${data.pct}% | ${data.covered} / ${data.total} |`;
});

const lines = [
  `### ${title}`,
  '',
  '| Metric | Percent | Covered / Total |',
  '| --- | ---: | ---: |',
  ...rows,
  '',
  `Minimum coverage: lines ${thresholds.lines}%, statements ${thresholds.statements}%, functions ${thresholds.functions}%, branches ${thresholds.branches}%`,
  '',
];

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
} else {
  console.log(lines.join('\n'));
}

for (const [metric, threshold] of Object.entries(thresholds)) {
  if (total[metric].pct < threshold) {
    console.error(`${title} ${metric} coverage ${total[metric].pct}% is below required ${threshold}%`);
    process.exit(1);
  }
}
