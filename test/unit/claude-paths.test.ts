import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemPaths } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { claudeDesktopDir } from '../../src/main/providers/claude/paths.js';
import { writeClaudeAuth } from '../helpers/fake-auth.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

const pkgClaude = (localAppData: string, pkg: string) => path.join(localAppData, 'Packages', pkg, 'LocalCache', 'Roaming', 'Claude');

describe('claudeDesktopDir', () => {
  it('falls back to %APPDATA%\Claude when no package folder exists', async () => {
    const p = await tmpPaths();
    expect(claudeDesktopDir(p)).toBe(path.join(p.appData, 'Claude'));
  });

  it('prefers the pzs8sxrjxfjjc package folder even when %APPDATA%\Claude exists', async () => {
    const p = await tmpPaths();
    await fs.mkdir(path.join(p.appData, 'Claude'), { recursive: true });
    const dir = pkgClaude(p.localAppData, 'Claude_pzs8sxrjxfjjc');
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(pkgClaude(p.localAppData, 'Claude_other'), { recursive: true });
    expect(claudeDesktopDir(p)).toBe(dir);
  });

  // Claude 2.42304.2 (2026-10-19) 는 데이터를 %LOCALAPPDATA%\Claude-Data\claude_<family> 로 옮기고 패키지 폴더에는
  // .user-data-left.<…> 표시 파일만 남긴다.
  it('prefers %LOCALAPPDATA%\\Claude-Data\\claude_pzs8sxrjxfjjc over the package folder it moved out of', async () => {
    const p = await tmpPaths();
    const left = pkgClaude(p.localAppData, 'Claude_pzs8sxrjxfjjc');
    await writeFile(path.join(left, '.user-data-left.claude_pzs8sxrjxfjjc'), '');
    const moved = path.join(p.localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
    await fs.mkdir(path.join(moved, 'claude-code-sessions'), { recursive: true });
    expect(claudeDesktopDir(p)).toBe(moved);
  });

  it('accepts another family under Claude-Data, choosing the newest claude-code-sessions', async () => {
    const p = await tmpPaths();
    const oldDir = path.join(p.localAppData, 'Claude-Data', 'claude_old');
    const newDir = path.join(p.localAppData, 'Claude-Data', 'claude_new');
    await fs.mkdir(path.join(oldDir, 'claude-code-sessions'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'claude-code-sessions'), { recursive: true });
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(path.join(oldDir, 'claude-code-sessions'), past, past);
    await fs.mkdir(pkgClaude(p.localAppData, 'Claude_pzs8sxrjxfjjc'), { recursive: true }); // 옛 자리는 무시
    expect(claudeDesktopDir(p)).toBe(newDir);
  });

  it('accepts another Claude_* family, choosing the newest claude-code-sessions', async () => {
    const p = await tmpPaths();
    const oldDir = pkgClaude(p.localAppData, 'Claude_old');
    const newDir = pkgClaude(p.localAppData, 'Claude_new');
    await fs.mkdir(path.join(oldDir, 'claude-code-sessions'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'claude-code-sessions'), { recursive: true });
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(path.join(oldDir, 'claude-code-sessions'), past, past);
    // Claude_ 로 시작하지 않거나 Roaming\Claude 가 없는 폴더는 무시
    await fs.mkdir(pkgClaude(p.localAppData, 'Other_pkg'), { recursive: true });
    await fs.mkdir(path.join(p.localAppData, 'Packages', 'Claude_empty'), { recursive: true });
    expect(claudeDesktopDir(p)).toBe(newDir);
  });

  it('is what systemPaths reports as claudeDesktop', async () => {
    const p = await tmpPaths();
    const dir = pkgClaude(p.localAppData, 'Claude_pzs8sxrjxfjjc');
    await fs.mkdir(dir, { recursive: true });
    const sp = systemPaths({ USERPROFILE: p.home, APPDATA: p.appData, LOCALAPPDATA: p.localAppData });
    expect(sp.claudeDesktop).toBe(dir);
    expect(sp.appDataDir).toBe(path.join(p.home, '.ai-account-bridge'));
  });
});

describe('claudeAuthProvider with the package folder', () => {
  it('reads and writes Claude Desktop config.json / profile under claudeDesktop, not appData', async () => {
    const base = await tmpPaths();
    const claudeDesktop = pkgClaude(base.localAppData, 'Claude_pzs8sxrjxfjjc');
    const p = { ...base, claudeDesktop };
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com', 'rA');
    await writeFile(path.join(claudeDesktop, 'Network', 'Cookies'), 'cookieA');
    await writeFile(path.join(base.appData, 'Claude', 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acc-DECOY' }));

    const prov = claudeAuthProvider(p, { withAppProfile: true });
    const bundle = await prov.readCurrentAuth();
    // 실제 %APPDATA%\Claude 의 (다른 계정) config.json 은 무시되므로 신원 불일치 오류가 나지 않는다
    expect(prov.identityOf(bundle).accountId).toBe('acc-A');
    expect(bundle.files.some((f) => f.root === 'claudeDesktop' && f.relPath === 'Network/Cookies')).toBe(true);
    expect(bundle.jsonKeys.filter((k) => k.root === 'claudeDesktop').map((k) => k.key)).toEqual(
      expect.arrayContaining(['oauth:tokenCache', 'oauth:tokenCacheV2', 'lastKnownAccountUuid']),
    );
    expect(prov.app.managedDirs).toContain(path.join(claudeDesktop, 'claude-code'));

    // 다른 계정으로 바꿨다가 되돌려 쓰면 패키지 폴더의 config.json 이 복원된다
    await writeClaudeAuth(p, 'acc-B', 'org-B', 'b@x.com', 'rB');
    await prov.writeAuth(bundle);
    const cfg = JSON.parse(await fs.readFile(path.join(claudeDesktop, 'config.json'), 'utf8'));
    expect(cfg.lastKnownAccountUuid).toBe('acc-A');
    expect(cfg['oauth:tokenCache']).toBe('tc-rA');
    expect(await fs.readFile(path.join(claudeDesktop, 'Network', 'Cookies'), 'utf8')).toBe('cookieA');
  });
});
