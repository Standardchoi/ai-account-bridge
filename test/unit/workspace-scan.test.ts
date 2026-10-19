import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitStatusLines, readBranch, scanWorkspace } from '../../src/main/infra/workspace-scan.js';
import { pendingTmpRoots, writeFile } from '../helpers/tmp-paths.js';

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-ws-'));
  pendingTmpRoots.push(d);
  return d;
}

describe('scanWorkspace', () => {
  it('finds nested repos with branches and instruction files (multi-repo layout)', async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, 'app-agent', '.git', 'HEAD'), 'ref: refs/heads/master\n');
    await writeFile(path.join(root, 'app-agent', 'AGENTS.md'), '# rules');
    await writeFile(path.join(root, 'app-backend', '.git', 'HEAD'), 'ref: refs/heads/feat/new-api\n');
    await writeFile(path.join(root, 'design.md'), 'x');
    expect(await scanWorkspace(root)).toEqual({
      repos: [{ rel: 'app-agent', branch: 'master' }, { rel: 'app-backend', branch: 'feat/new-api' }],
      instructionFiles: ['app-agent/AGENTS.md'],
    });
  });

  it('counts the folder itself and skips hidden, dependency and too-deep folders', async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(root, 'CLAUDE.md'), 'x');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'AGENTS.md'), 'x');
    await writeFile(path.join(root, '.cache', 'AGENTS.md'), 'x');
    await writeFile(path.join(root, 'a', 'b', 'GEMINI.md'), 'x');
    await writeFile(path.join(root, 'a', 'b', 'c', 'AGENTS.md'), 'x');
    expect(await scanWorkspace(root)).toEqual({ repos: [{ rel: '', branch: 'main' }], instructionFiles: ['CLAUDE.md', 'a/b/GEMINI.md'] });
  });

  it('returns nothing for a folder that does not exist', async () => {
    const root = await tmpDir();
    expect(await scanWorkspace(path.join(root, 'missing'))).toEqual({ repos: [], instructionFiles: [] });
  });
});

describe('readBranch', () => {
  it('follows a gitdir file and reports a detached HEAD', async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, 'real', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    await writeFile(path.join(root, 'wt', '.git'), `gitdir: ${path.join(root, 'real')}\n`);
    expect(await readBranch(path.join(root, 'wt', '.git'))).toBe('분리된 HEAD 0123456');
  });

  it('returns undefined when HEAD cannot be read', async () => {
    const root = await tmpDir();
    expect(await readBranch(path.join(root, 'missing', '.git'))).toBeUndefined();
  });
});

describe('gitStatusLines (git 필요)', () => {
  it('lists uncommitted changes, keeping non-ASCII file names readable', async () => {
    const root = await tmpDir();
    execFileSync('git', ['init', '-q', root]);
    await writeFile(path.join(root, '보고서.md'), 'x');
    expect(await gitStatusLines(root)).toEqual(['?? 보고서.md']);
  });

  it('returns undefined outside a repository', async () => {
    const root = await tmpDir();
    expect(await gitStatusLines(root)).toBeUndefined();
  });
});
