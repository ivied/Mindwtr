import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./csv-to-quickadd-text.mjs', import.meta.url));

function runScript(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

describe('csv-to-quickadd-text', () => {
  it('converts common CSV columns into Mindwtr quick-add lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mindwtr-csv-quickadd-'));
    const input = join(dir, 'tasks.csv');
    const output = join(dir, 'tasks.txt');
    await writeFile(input, [
      'Title,Project,Tags,Contexts,Due,Note',
      '"Email Bob","Work","followup,client","computer","2026-06-20","Ask about Q3"',
      '"Buy milk","","errands","home","",""',
      '',
    ].join('\n'));

    await runScript([
      input,
      '--output',
      output,
      '--title',
      'Title',
      '--project',
      'Project',
      '--tags',
      'Tags',
      '--contexts',
      'Contexts',
      '--due',
      'Due',
      '--note',
      'Note',
    ]);

    await assert.doesNotReject(readFile(output, 'utf8'));
    assert.equal(await readFile(output, 'utf8'), [
      'Email Bob +Work #followup #client @computer /due:2026-06-20 /note:Ask about Q3',
      'Buy milk #errands @home',
      '',
    ].join('\n'));
  });

  it('escapes quick-add tokens that appear in the source title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mindwtr-csv-quickadd-'));
    const input = join(dir, 'tasks.csv');
    await writeFile(input, [
      'Title,Project,Due',
      '"Email +Work #client @computer /due:tomorrow !Area","Work","2026-06-20"',
      '',
    ].join('\n'));

    const { stdout } = await runScript([input]);

    assert.equal(stdout, 'Email \\+Work \\#client \\@computer \\/due:tomorrow \\!Area +Work /due:2026-06-20\n');
  });

  it('reports missing required columns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mindwtr-csv-quickadd-'));
    const input = join(dir, 'tasks.csv');
    await writeFile(input, 'Name\nTask one\n');

    await assert.rejects(
      () => runScript([input, '--title', 'Title']),
      (error) => {
        assert.match(error.stderr, /Missing required title column: Title/);
        return true;
      },
    );
  });
});
