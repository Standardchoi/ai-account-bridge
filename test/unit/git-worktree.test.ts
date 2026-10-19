import path from 'node:path';
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { mainWorktreeRoot } from '../../src/main/infra/git-worktree.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let base: string;
beforeEach(async () => {
  base = (await tmpPaths()).home;
});

describe('mainWorktreeRoot', () => {
  it('returns the main repository root for a git worktree folder and its subfolders', async () => {
    const main = path.join(base, 'Desktop', 'base-docs');
    const wt = path.join(base, 'codex_home', 'worktrees', '31f3', 'base-docs');
    await fs.mkdir(path.join(main, '.git', 'worktrees', 'base-docs'), { recursive: true });
    await writeFile(path.join(wt, '.git'), `gitdir: ${main.replaceAll('\\', '/')}/.git/worktrees/base-docs\n`);
    await fs.mkdir(path.join(wt, 'docs', 'api'), { recursive: true });
    expect(mainWorktreeRoot(wt)).toBe(main);
    expect(mainWorktreeRoot(path.join(wt, 'docs', 'api'))).toBe(main);
  });

  it('resolves a relative gitdir against the worktree folder', async () => {
    const main = path.join(base, 'repo');
    const wt = path.join(base, 'wt');
    await writeFile(path.join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt');
    expect(mainWorktreeRoot(wt)).toBe(main);
  });

  it('returns null for a normal repository, a non-worktree .git file and a folder outside git', async () => {
    const repo = path.join(base, 'plain');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    expect(mainWorktreeRoot(repo)).toBeNull();
    expect(mainWorktreeRoot(path.join(repo, 'src'))).toBeNull();
    const sub = path.join(base, 'submodule');
    await writeFile(path.join(sub, '.git'), 'gitdir: ../plain/.git/modules/sub');
    expect(mainWorktreeRoot(sub)).toBeNull();
    expect(mainWorktreeRoot(path.join(base, 'nothing', 'here'))).toBeNull();
    expect(mainWorktreeRoot('')).toBeNull();
  });
});
