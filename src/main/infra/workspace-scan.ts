import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoInfo, WorkspaceScan } from '../core/repo-status.js';

const INSTRUCTION_NAMES = new Set(['agents.md', 'claude.md', 'gemini.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'venv', '__pycache__']);
const MAX_DIRS = 500; // 아주 큰 폴더여도 훑기가 길어지지 않게

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// HEAD 에서 브랜치 이름을 읽는다(git 을 실행하지 않음). .git 이 파일이면(worktree·submodule) 'gitdir:' 이 가리키는 곳을 본다.
export async function readBranch(gitPath: string): Promise<string | undefined> {
  try {
    let gitDir = gitPath;
    if ((await fs.stat(gitPath)).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(gitPath, 'utf8'));
      if (!m) return undefined;
      gitDir = path.resolve(path.dirname(gitPath), m[1]!.trim());
    }
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return /^[0-9a-f]{7,}$/i.test(head) ? `분리된 HEAD ${head.slice(0, 7)}` : undefined;
  } catch {
    return undefined;
  }
}

// 작업 폴더와 그 아래 maxDepth 단계까지에서 git 저장소와 지침 파일(AGENTS.md·CLAUDE.md·GEMINI.md)을 찾는다.
// 하위 저장소를 여럿 모은 폴더(예: multi-repo)도 다루기 위해서다. 숨김 폴더(.git 포함)·의존성·빌드 폴더와 링크는 들어가지 않는다.
export async function scanWorkspace(root: string, maxDepth = 2): Promise<WorkspaceScan> {
  const repos: RepoInfo[] = [];
  const instructionFiles: string[] = [];
  let visited = 0;
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (visited++ >= MAX_DIRS) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const relOf = (name: string) => (rel === '' ? name : `${rel}/${name}`);
    if (entries.some((e) => e.name === '.git')) {
      const branch = await readBranch(path.join(dir, '.git'));
      repos.push({ rel, ...(branch ? { branch } : {}) });
    }
    for (const e of entries) if (e.isFile() && INSTRUCTION_NAMES.has(e.name.toLowerCase())) instructionFiles.push(relOf(e.name));
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      await walk(path.join(dir, e.name), relOf(e.name), depth + 1);
    }
  }
  await walk(root, '', 0);
  return { repos: repos.sort((a, b) => byCodeUnit(a.rel, b.rel)), instructionFiles: instructionFiles.sort(byCodeUnit) };
}

// 커밋하지 않은 변경('M a.ts', '?? b/' …). git 이 없거나 저장소가 아니거나 실패하면 undefined.
// --no-optional-locks: 열려 있는 편집기·앱의 git 작업과 인덱스 잠금으로 부딪히지 않게. core.quotePath=false: 한글 파일 이름을 그대로.
export function gitStatusLines(dir: string, timeoutMs = 15_000): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', dir, 'status', '--porcelain=v1', '--untracked-files=normal'],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? undefined : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)),
    );
  });
}
