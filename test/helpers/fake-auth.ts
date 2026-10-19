import fs from 'node:fs/promises';
import path from 'node:path';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { writeFile } from './tmp-paths.js';

export function fakeJwt(payload: object): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'none' })}.${b(payload)}.sig`;
}

export async function writeCodexAuth(p: PathProvider, accountId: string, email: string, refresh = 'r1'): Promise<void> {
  await writeFile(
    path.join(p.home, '.codex', 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { id_token: fakeJwt({ email, name: email }), access_token: 'a', refresh_token: refresh, account_id: accountId },
      last_refresh: '2026-09-23T00:00:00Z',
    }),
  );
}

export async function writeClaudeAuth(p: PathProvider, accountUuid: string, orgUuid: string, email: string, refresh = 'r1'): Promise<void> {
  await writeFile(
    path.join(p.home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: refresh }, organizationUuid: orgUuid }),
  );
  const cfgPath = path.join(p.home, '.claude.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8').catch(() => '{}')) as Record<string, unknown>;
  cfg.oauthAccount = { accountUuid, organizationUuid: orgUuid, emailAddress: email, displayName: email };
  await writeFile(cfgPath, JSON.stringify(cfg));

  // Claude Desktop 은 로그인 상태를 %APPDATA%\Claude\config.json 에 보관한다 (.credentials.json 은 갱신하지 않음)
  const desktopCfgPath = path.join(p.claudeDesktop, 'config.json');
  const desktopCfg = JSON.parse(await fs.readFile(desktopCfgPath, 'utf8').catch(() => '{}')) as Record<string, unknown>;
  desktopCfg['oauth:tokenCache'] = `tc-${refresh}`;
  desktopCfg['oauth:tokenCacheV2'] = `tc2-${refresh}`;
  desktopCfg.lastKnownAccountUuid = accountUuid;
  await writeFile(desktopCfgPath, JSON.stringify(desktopCfg));
}
