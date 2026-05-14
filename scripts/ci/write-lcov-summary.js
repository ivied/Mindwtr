#!/usr/bin/env node

const fs = require('fs');

const [title, lcovPath, ...args] = process.argv.slice(2);

if (!title || !lcovPath) {
  console.error('Usage: write-lcov-summary.js <title> <lcov.info> [--min-lines=<percent>] [--min-statements=<percent>] [--min-functions=<percent>] [--min-branches=<percent>] [--include-prefix=<prefix>]');
  process.exit(2);
}

const getArgValue = (name, fallback) => {
  const arg = args.find((candidate) => candidate.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : fallback;
};

const minLinesRaw = getArgValue('--min-lines', process.env.COVERAGE_MIN_LINES || '70');
const minStatementsRaw = getArgValue('--min-statements', process.env.COVERAGE_MIN_STATEMENTS || '');
const minFunctionsRaw = getArgValue('--min-functions', process.env.COVERAGE_MIN_FUNCTIONS || '50');
const minBranchesRaw = getArgValue('--min-branches', process.env.COVERAGE_MIN_BRANCHES || '');
const includePrefix = getArgValue('--include-prefix', '');
const parseThreshold = (label, raw) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(`Invalid ${label} coverage threshold: ${raw}`);
    process.exit(2);
  }
  return value;
};

const minLines = parseThreshold('line', minLinesRaw);
const minStatements = minStatementsRaw === '' ? null : parseThreshold('statement', minStatementsRaw);
const minFunctions = parseThreshold('function', minFunctionsRaw);
const minBranches = minBranchesRaw === '' ? null : parseThreshold('branch', minBranchesRaw);

if (!fs.existsSync(lcovPath)) {
  console.error(`LCOV report missing at ${lcovPath}`);
  process.exit(1);
}

const normalizePath = (value) => value.replaceAll('\\', '/');
const shouldIncludeFile = (filePath) => {
  if (!includePrefix) return true;
  return normalizePath(filePath).startsWith(normalizePath(includePrefix));
};

const records = fs.readFileSync(lcovPath, 'utf8').split('end_of_record');
let coveredLines = 0;
let totalLines = 0;
let coveredFunctions = 0;
let totalFunctions = 0;
let coveredBranches = 0;
let totalBranches = 0;
let includedFiles = 0;

for (const record of records) {
  const lines = record.split(/\r?\n/);
  const sourceLine = lines.find((line) => line.startsWith('SF:'));
  if (!sourceLine) continue;

  const sourcePath = sourceLine.slice('SF:'.length);
  if (!shouldIncludeFile(sourcePath)) continue;

  let fileLineTotal = 0;
  let fileLineCovered = 0;
  for (const line of lines) {
    if (!line.startsWith('DA:')) continue;
    const [, hitCountRaw] = line.slice('DA:'.length).split(',');
    fileLineTotal += 1;
    if (Number(hitCountRaw) > 0) {
      fileLineCovered += 1;
    }
  }

  if (fileLineTotal > 0) {
    includedFiles += 1;
    totalLines += fileLineTotal;
    coveredLines += fileLineCovered;
  }

  for (const line of lines) {
    if (line.startsWith('FNF:')) totalFunctions += Number(line.slice('FNF:'.length)) || 0;
    if (line.startsWith('FNH:')) coveredFunctions += Number(line.slice('FNH:'.length)) || 0;
    if (line.startsWith('BRF:')) totalBranches += Number(line.slice('BRF:'.length)) || 0;
    if (line.startsWith('BRH:')) coveredBranches += Number(line.slice('BRH:'.length)) || 0;
  }
}

if (totalLines === 0) {
  console.error(`LCOV report at ${lcovPath} did not include any matching lines`);
  process.exit(1);
}

const linePct = Number(((coveredLines / totalLines) * 100).toFixed(2));
const statementPct = linePct;
const functionPct = totalFunctions === 0 ? 100 : Number(((coveredFunctions / totalFunctions) * 100).toFixed(2));
const branchPct = totalBranches === 0 ? 100 : Number(((coveredBranches / totalBranches) * 100).toFixed(2));
const lines = [
  `### ${title}`,
  '',
  '| Metric | Percent | Covered / Total |',
  '| --- | ---: | ---: |',
  `| Lines | ${linePct}% | ${coveredLines} / ${totalLines} |`,
  ...(minStatements == null ? [] : [`| Statements (LCOV line proxy) | ${statementPct}% | ${coveredLines} / ${totalLines} |`]),
  `| Functions | ${functionPct}% | ${coveredFunctions} / ${totalFunctions} |`,
  ...(minBranches == null ? [] : [`| Branches | ${branchPct}% | ${coveredBranches} / ${totalBranches} |`]),
  `| Files | ${includedFiles} | ${includedFiles} |`,
  '',
  `Minimum coverage: lines ${minLines}%${minStatements == null ? '' : `, statements ${minStatements}% (LCOV line proxy)`}, functions ${minFunctions}%${minBranches == null ? '' : `, branches ${minBranches}%`}`,
  '',
];

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
} else {
  console.log(lines.join('\n'));
}

if (linePct < minLines) {
  console.error(`${title} line coverage ${linePct}% is below required ${minLines}%`);
  process.exit(1);
}

if (minStatements != null && statementPct < minStatements) {
  console.error(`${title} statement coverage ${statementPct}% is below required ${minStatements}% (LCOV line proxy)`);
  process.exit(1);
}

if (functionPct < minFunctions) {
  console.error(`${title} function coverage ${functionPct}% is below required ${minFunctions}%`);
  process.exit(1);
}

if (minBranches != null && totalBranches === 0) {
  console.error(`${title} branch coverage threshold was requested, but ${lcovPath} does not include branch data`);
  process.exit(1);
}

if (minBranches != null && branchPct < minBranches) {
  console.error(`${title} branch coverage ${branchPct}% is below required ${minBranches}%`);
  process.exit(1);
}
