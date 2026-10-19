import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PathProvider } from '../../src/main/infra/path-provider.js';

// tmpPaths() 가 만든 임시 루트들 — 테스트가 끝나면 test/setup.ts 의 afterEach 가 cleanupTmpRoots() 로 지운다.
export const pendingTmpRoots: string[] = [];

export async function tmpPaths(): Promise<PathProvider> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-'));
  pendingTmpRoots.push(root);
  const p: PathProvider = {
    home: path.join(root, 'home'),
    appData: path.join(root, 'roaming'),
    localAppData: path.join(root, 'local'),
    claudeDesktop: path.join(root, 'roaming', 'Claude'),
    appDataDir: path.join(root, 'roaming', 'ai-account-bridge'),
  };
  for (const d of [p.home, p.appData, p.localAppData]) await fs.mkdir(d, { recursive: true });
  return p;
}

export async function cleanupTmpRoots(): Promise<void> {
  const roots = pendingTmpRoots.splice(0, pendingTmpRoots.length);
  await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })));
}

export async function writeFile(full: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

export async function readText(full: string): Promise<string> {
  return fs.readFile(full, 'utf8');
}

export async function exists(full: string): Promise<boolean> {
  return fs.stat(full).then(() => true, () => false);
}
