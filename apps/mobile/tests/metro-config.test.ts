import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const metroConfig = require('../metro.config.js');

function isMetroBlocked(filePath: string): boolean {
  const blockList = metroConfig.resolver.blockList;
  const blockPatterns = Array.isArray(blockList) ? blockList : [blockList];
  const normalizedPath = filePath.split(path.sep).join('/');
  return blockPatterns.some((pattern: RegExp) => pattern.test(normalizedPath));
}

describe('metro config', () => {
  it('blocks nested git worktrees from the Metro watcher', () => {
    const worktreeDependencyPath = path.resolve(
      process.cwd(),
      '../../.worktrees/issue-753-add-task-shortcut/node_modules/@types/babel__generator/node_modules/@babel/types/node_modules/@babel/helper-string-parser',
    );

    expect(isMetroBlocked(worktreeDependencyPath)).toBe(true);
  });
});
