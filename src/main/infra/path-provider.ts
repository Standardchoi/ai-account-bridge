import os from 'node:os';
import path from 'node:path';
import type { RootKey } from '../core/auth-bundle.js';
import { claudeDesktopDir } from '../providers/claude/paths.js';

export interface PathProvider {
  home: string;
  appData: string;
  localAppData: string;
  claudeDesktop: string; // Claude Desktop 데이터 (MSIX 패키지 폴더 또는 %APPDATA%\Claude)
  appDataDir: string; // 본 앱 저장소 (%USERPROFILE%\.ai-account-bridge — MSIX 가상화를 받지 않는 위치)
}

export function systemPaths(env: NodeJS.ProcessEnv = process.env): PathProvider {
  const home = env.USERPROFILE ?? os.homedir();
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  return { home, appData, localAppData, claudeDesktop: claudeDesktopDir({ appData, localAppData }), appDataDir: path.join(home, '.ai-account-bridge') };
}

export function resolveRoot(paths: PathProvider, root: RootKey, relPath: string): string {
  return path.join(paths[root], ...relPath.split('/'));
}

// 사용자에게 보여줄 경로 — 홈 폴더 아래면 ~ 로 줄인다.
export function displayPath(p: string, home: string): string {
  const rel = path.relative(home, p);
  if (rel === '') return '~';
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : path.join('~', rel);
}
