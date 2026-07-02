#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_COLUMNS = {
  title: 'Title',
  project: 'Project',
  tags: 'Tags',
  contexts: 'Contexts',
  due: 'Due',
  note: 'Note',
};

function usage() {
  return [
    'Usage: node scripts/migration/csv-to-quickadd-text.mjs <tasks.csv> [options]',
    '',
    'Converts a simple CSV export into one Mindwtr quick-add task per line.',
    '',
    'Options:',
    '  --output <file>     Write lines to a .txt file instead of stdout',
    '  --title <column>    Required task title column (default: Title)',
    '  --project <column>  Optional project column (default: Project)',
    '  --tags <column>     Optional comma/semicolon tag column (default: Tags)',
    '  --contexts <column> Optional comma/semicolon context column (default: Contexts)',
    '  --due <column>      Optional due-date column (default: Due)',
    '  --note <column>     Optional note column (default: Note)',
    '  --help              Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { ...DEFAULT_COLUMNS, output: '' };
  let input = '';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { help: true, input, options };
    }
    if (!arg.startsWith('--')) {
      if (input) throw new Error(`Unexpected argument: ${arg}`);
      input = arg;
      continue;
    }

    const key = arg.slice(2);
    if (!(key in options)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[key] = value;
    index += 1;
  }

  return { help: false, input, options };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  row.push(field);
  rows.push(row);
  return rows.filter((candidate) => candidate.some((value) => value.trim()));
}

function normalizeHeader(value) {
  return value.trim().replace(/^\uFEFF/u, '').toLowerCase();
}

function buildHeaderIndex(header) {
  const index = new Map();
  header.forEach((value, columnIndex) => {
    const key = normalizeHeader(value);
    if (key && !index.has(key)) index.set(key, columnIndex);
  });
  return index;
}

function columnValue(row, headerIndex, name) {
  const column = headerIndex.get(normalizeHeader(name));
  if (column === undefined) return '';
  return (row[column] ?? '').replace(/\s+/g, ' ').trim();
}

function splitTokens(value) {
  return value
    .split(/[;,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function quoteQuickAddToken(token, prefix) {
  const normalized = token.startsWith(prefix) ? token.slice(prefix.length) : token;
  const clean = normalized.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (/^[\p{L}\p{N}_-]+$/u.test(clean)) return `${prefix}${clean}`;
  return `${prefix}"${clean.replace(/(["\\])/g, '\\$1')}"`;
}

function escapeQuickAddLiteral(value) {
  return value.replace(/([@#+/!])/gu, '\\$1');
}

function buildLine(row, headerIndex, options) {
  const title = columnValue(row, headerIndex, options.title);
  if (!title) return '';

  const parts = [escapeQuickAddLiteral(title)];
  const project = columnValue(row, headerIndex, options.project);
  if (project) parts.push(`+${project}`);

  for (const tag of splitTokens(columnValue(row, headerIndex, options.tags))) {
    const token = quoteQuickAddToken(tag, '#');
    if (token) parts.push(token);
  }

  for (const context of splitTokens(columnValue(row, headerIndex, options.contexts))) {
    const token = quoteQuickAddToken(context, '@');
    if (token) parts.push(token);
  }

  const due = columnValue(row, headerIndex, options.due);
  if (due) parts.push(`/due:${due}`);

  const note = columnValue(row, headerIndex, options.note);
  if (note) parts.push(`/note:${escapeQuickAddLiteral(note)}`);

  return parts.join(' ');
}

async function main() {
  const { help, input, options } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(usage());
    return;
  }
  if (!input) throw new Error('Missing input CSV file');

  const rows = parseCsv(await readFile(input, 'utf8'));
  if (rows.length === 0) throw new Error('CSV file is empty');

  const [header, ...dataRows] = rows;
  const headerIndex = buildHeaderIndex(header);
  if (!headerIndex.has(normalizeHeader(options.title))) {
    throw new Error(`Missing required title column: ${options.title}`);
  }

  const lines = dataRows
    .map((row) => buildLine(row, headerIndex, options))
    .filter(Boolean);
  const output = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;

  if (options.output) {
    await writeFile(options.output, output);
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
