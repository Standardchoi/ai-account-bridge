import fs from 'node:fs/promises';
import path from 'node:path';
import { runPowerShell } from './powershell.js';

// 설치된 MSIX 앱(ChatGPT, Claude Desktop)의 아이콘을 data URI 로 읽는다 — GUI 가 도구를 실제 앱 아이콘으로 보여 준다.
// 밝은 배경용(lightunplated) 64px 변형을 우선 쓰고, 없으면 가까운 크기·배율 순으로 고른다.
const VARIANTS = [
  '.targetsize-64_altform-lightunplated.png',
  '.targetsize-64_altform-unplated.png',
  '.targetsize-64.png',
  '.targetsize-48_altform-lightunplated.png',
  '.targetsize-48.png',
  '.scale-200.png',
  '.png',
];

export type LocatePackage = (familyName: string) => Promise<string | null>;

export const locateInstalledPackage: LocatePackage = async (familyName) => {
  if (!/^[\w.-]+$/.test(familyName)) return null;
  const out = await runPowerShell(
    `(Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '${familyName}' } | Select-Object -First 1).InstallLocation`,
  );
  return out.trim() || null;
};

export async function readAppIcon(familyName: string, locate: LocatePackage = locateInstalledPackage): Promise<string | null> {
  const dir = await locate(familyName).catch(() => null);
  if (!dir) return null;
  const manifest = await fs.readFile(path.join(dir, 'AppxManifest.xml'), 'utf8').catch(() => '');
  const logo = /Square44x44Logo="([^"]+)"/.exec(manifest)?.[1];
  if (!logo) return null;
  const base = path.join(dir, logo.replace(/[\\/]/g, path.sep).replace(/\.png$/i, ''));
  for (const suffix of VARIANTS) {
    const data = await fs.readFile(base + suffix).catch(() => null);
    if (data) return `data:image/png;base64,${data.toString('base64')}`;
  }
  return null;
}
