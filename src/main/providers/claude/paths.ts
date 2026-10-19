import fs from 'node:fs';
import path from 'node:path';
import type { PathProvider } from '../../infra/path-provider.js';

const PREFERRED_FAMILY = 'Claude_pzs8sxrjxfjjc';

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const mtimeOrZero = (p: string) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

// 같은 뿌리 아래 후보 폴더 중 claude-code-sessions 가 가장 최근에 바뀐 것.
function newestBySessions(dirs: string[]): string | undefined {
  return dirs
    .filter(isDir)
    .map((dir) => ({ dir, mtime: mtimeOrZero(path.join(dir, 'claude-code-sessions')) }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.dir;
}

// Claude Desktop 데이터 위치:
// 1) 2.42304.2 (2026-10-19) 부터 %LOCALAPPDATA%\Claude-Data\claude_<family> — 패키지 폴더의 데이터를 이리로 옮기고
//    옛 자리에는 .user-data-left.<…> 표시 파일만 남긴다.
// 2) 그 전에는 MSIX 가상화로 %LOCALAPPDATA%\Packages\Claude_<family>\LocalCache\Roaming\Claude (일반 프로세스는
//    %APPDATA%\Claude 를 봐도 이 데이터를 못 본다).
// 3) 둘 다 없을 때만 %APPDATA%\Claude.
export function claudeDesktopDir(paths: Pick<PathProvider, 'appData' | 'localAppData'>): string {
  const dataRoot = path.join(paths.localAppData, 'Claude-Data');
  const moved = path.join(dataRoot, PREFERRED_FAMILY.toLowerCase());
  if (isDir(moved)) return moved;
  let dataDirs: string[] = [];
  try {
    dataDirs = fs.readdirSync(dataRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && /^claude_/i.test(d.name)).map((d) => path.join(dataRoot, d.name));
  } catch {
    /* Claude-Data 폴더 없음 */
  }
  const movedOther = newestBySessions(dataDirs);
  if (movedOther) return movedOther;

  const pkgRoot = path.join(paths.localAppData, 'Packages');
  const inPackage = (pkg: string) => path.join(pkgRoot, pkg, 'LocalCache', 'Roaming', 'Claude');

  const preferred = inPackage(PREFERRED_FAMILY);
  if (isDir(preferred)) return preferred;

  let pkgs: string[] = [];
  try {
    pkgs = fs.readdirSync(pkgRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('Claude_')).map((d) => d.name);
  } catch {
    /* Packages 폴더 없음 */
  }
  return newestBySessions(pkgs.map((pkg) => inPackage(pkg))) ?? path.join(paths.appData, 'Claude');
}
