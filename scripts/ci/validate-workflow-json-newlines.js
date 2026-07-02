#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const roots = process.argv.slice(2);
const scanRoots = roots.length ? roots : ['.github/workflows'];
const suspicious = [];

const walk = (entry) => {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry).sort()) {
      walk(path.join(entry, child));
    }
    return;
  }
  if (!/\.(ya?ml|mjs|cjs|js|ts|tsx|sh)$/u.test(entry)) return;
  const text = fs.readFileSync(entry, 'utf8');
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (line.includes('JSON.stringify') && line.includes('\\\\n')) {
      suspicious.push(`${entry}:${index + 1}: ${line.trim()}`);
    }
  });
};

for (const root of scanRoots) walk(root);

if (suspicious.length) {
  console.error('Found JSON rewrites that append a literal \\\\n instead of a newline escape:');
  for (const item of suspicious) console.error(`- ${item}`);
  process.exit(1);
}

console.log('Workflow JSON newline rewrites look valid.');
