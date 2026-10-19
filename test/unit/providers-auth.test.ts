import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { writeClaudeAuth, writeCodexAuth } from '../helpers/fake-auth.js';
import { readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
beforeEach(async () => { p = await tmpPaths(); });

describe('codexAuthProvider', () => {
  it('extracts identity from auth.json', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const prov = codexAuthProvider(p);
    const id = prov.identityOf(await prov.readCurrentAuth());
    expect(id).toEqual({ tool: 'codex', accountId: 'acct-A', email: 'a@x.com', displayName: 'a@x.com' });
  });

  it('throws when not logged in', async () => {
    const prov = codexAuthProvider(p);
    expect(() => prov.identityOf({ tool: 'codex', files: [], replaceDirs: [], jsonKeys: [] })).toThrow('로그인');
    const bundle = await prov.readCurrentAuth();
    expect(() => prov.identityOf(bundle)).toThrow('로그인');
  });

  it('swaps accounts via writeAuth', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const prov = codexAuthProvider(p);
    const a = await prov.readCurrentAuth();
    await writeCodexAuth(p, 'acct-B', 'b@x.com');
    await prov.writeAuth(a);
    expect(prov.identityOf(await prov.readCurrentAuth()).accountId).toBe('acct-A');
  });

  it('throws a clear error when auth.json is corrupted (not valid JSON)', async () => {
    await writeFile(path.join(p.home, '.codex', 'auth.json'), '{bad');
    const prov = codexAuthProvider(p);
    const bundle = await prov.readCurrentAuth();
    expect(() => prov.identityOf(bundle)).toThrow('손상됨');
  });

  it.each(['not-a-jwt', 'a.%%%.c', 'a.bm90anNvbg.c'])('still yields an identity from account_id when id_token is undecodable (%s)', async (idToken) => {
    await writeFile(
      path.join(p.home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: idToken, access_token: 'a', refresh_token: 'r', account_id: 'acct-A' } }),
    );
    const prov = codexAuthProvider(p);
    expect(prov.identityOf(await prov.readCurrentAuth())).toEqual({ tool: 'codex', accountId: 'acct-A' });
  });

  it('includes the Electron profile only when withAppProfile is set', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const profile = path.join(p.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex');
    await writeFile(path.join(profile, 'web', 'Codex', 'Default', 'Network', 'Cookies'), 'cookieA');
    expect((await codexAuthProvider(p).readCurrentAuth()).files).toHaveLength(1);
    const withProfile = await codexAuthProvider(p, { withAppProfile: true }).readCurrentAuth();
    expect(withProfile.files.map((f) => f.relPath)).toContain(
      'Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming/Codex/web/Codex/Default/Network/Cookies',
    );
  });
});

describe('claudeAuthProvider', () => {
  it('extracts identity from ~/.claude.json oauthAccount', async () => {
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com');
    const prov = claudeAuthProvider(p);
    expect(prov.identityOf(await prov.readCurrentAuth())).toEqual({
      tool: 'claude', accountId: 'acc-A', orgId: 'org-A', email: 'a@x.com', displayName: 'a@x.com',
    });
  });

  it('swaps credentials and oauthAccount but keeps other ~/.claude.json keys', async () => {
    await writeFile(path.join(p.home, '.claude.json'), JSON.stringify({ numStartups: 7 }));
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com', 'rA');
    const prov = claudeAuthProvider(p);
    const a = await prov.readCurrentAuth();
    await writeClaudeAuth(p, 'acc-B', 'org-B', 'b@x.com', 'rB');
    await prov.writeAuth(a);
    const cfg = JSON.parse(await readText(path.join(p.home, '.claude.json')));
    expect(cfg.numStartups).toBe(7);
    expect(cfg.oauthAccount.accountUuid).toBe('acc-A');
    const cred = JSON.parse(await readText(path.join(p.home, '.claude', '.credentials.json')));
    expect(cred.claudeAiOauth.refreshToken).toBe('rA');
  });

  it('throws when oauthAccount is missing', async () => {
    const prov = claudeAuthProvider(p);
    expect(() => prov.identityOf({ tool: 'claude', files: [], replaceDirs: [], jsonKeys: [] })).toThrow('로그인');
  });

  it('does not throw when Claude Desktop config.json is missing', async () => {
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com');
    await fs.rm(path.join(p.appData, 'Claude', 'config.json'), { force: true });
    const prov = claudeAuthProvider(p);
    const id = prov.identityOf(await prov.readCurrentAuth());
    expect(id.accountId).toBe('acc-A');
  });

  it('throws when Claude Desktop config.json account differs from ~/.claude.json', async () => {
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com');
    await writeFile(path.join(p.appData, 'Claude', 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'acc-OTHER' }));
    const prov = claudeAuthProvider(p);
    const bundle = await prov.readCurrentAuth();
    expect(() => prov.identityOf(bundle)).toThrow('계정 정보 불일치');
  });
});

describe('claudeAuthProvider app process classification (MSIX)', () => {
  it('treats Desktop-spawned Claude Code at the virtual %APPDATA% path as part of the app when Desktop data lives in the package folder', async () => {
    const { classifyProcesses } = await import('../../src/main/services/app-processes.js');
    const pkg = path.join(p.localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
    const prov = claudeAuthProvider({ ...p, claudeDesktop: pkg });
    const child = { pid: 1, name: 'claude', path: path.join(p.appData, 'Claude', 'claude-code', '2.1.284', 'claude.exe') };
    const stray = { pid: 2, name: 'claude', path: path.join(p.home, '.local', 'bin', 'claude.exe') };
    const { appProcs, strayCli } = classifyProcesses([child, stray], prov.app);
    expect(appProcs.map((x) => x.pid)).toEqual([1]);
    expect(strayCli.map((x) => x.pid)).toEqual([2]);
  });
});
