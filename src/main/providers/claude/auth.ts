import path from 'node:path';
import type { AuthBundle, AuthPathSpec } from '../../core/auth-bundle.js';
import { NotLoggedInError, type Identity } from '../../core/identity.js';
import { applyAuth, collectAuth, type JsonKeySpec } from '../../infra/auth-fs.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { AuthProviderOptions, ToolAuthProvider } from '../types.js';

const CREDENTIALS: AuthPathSpec = { root: 'home', relPath: '.claude/.credentials.json' };
const OAUTH_ACCOUNT: JsonKeySpec = { root: 'home', relPath: '.claude.json', key: 'oauthAccount' };
const PROFILE_PATHS: AuthPathSpec[] = ['Network', 'Local State', 'Local Storage'].map((name) => ({
  root: 'claudeDesktop',
  relPath: name,
}));
// Claude Desktop 은 로그인 상태를 %APPDATA%\Claude\config.json 에 보관한다 (.credentials.json 은 갱신하지 않음)
const DESKTOP_LAST_KNOWN_ACCOUNT: JsonKeySpec = { root: 'claudeDesktop', relPath: 'config.json', key: 'lastKnownAccountUuid' };
const DESKTOP_CONFIG_KEYS: JsonKeySpec[] = [
  { root: 'claudeDesktop', relPath: 'config.json', key: 'oauth:tokenCache' },
  { root: 'claudeDesktop', relPath: 'config.json', key: 'oauth:tokenCacheV2' },
  DESKTOP_LAST_KNOWN_ACCOUNT,
];

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function claudeAuthProvider(paths: PathProvider, opts: AuthProviderOptions = {}): ToolAuthProvider {
  const specs = opts.withAppProfile ? [CREDENTIALS, ...PROFILE_PATHS] : [CREDENTIALS];
  return {
    id: 'claude',
    app: {
      aumid: 'Claude_pzs8sxrjxfjjc!Claude',
      packageDirMarker: `\\WindowsApps\\Claude_`,
      // Desktop 이 띄운 Claude Code 는 MSIX 가상화 때문에 실제 위치(패키지 폴더)가 아니라 가상 경로
      // (%APPDATA%\Claude\claude-code)로 보고된다 — 둘 다 앱 소속으로 본다.
      managedDirs: [...new Set([path.join(paths.claudeDesktop, 'claude-code'), path.join(paths.appData, 'Claude', 'claude-code')])],
      cliNames: ['claude'],
      cliCommandMarkers: ['@anthropic-ai/claude-code'],
    },
    readCurrentAuth: () => collectAuth(paths, 'claude', specs, [OAUTH_ACCOUNT, ...DESKTOP_CONFIG_KEYS]),
    identityOf(bundle: AuthBundle): Identity {
      const entry = bundle.jsonKeys.find((k) => k.root === OAUTH_ACCOUNT.root && k.relPath === OAUTH_ACCOUNT.relPath && k.key === OAUTH_ACCOUNT.key);
      const acc = entry?.value as Record<string, unknown> | null | undefined;
      const accountId = str(acc?.accountUuid);
      if (!acc || !accountId) throw new NotLoggedInError('claude: oauthAccount 없음 (로그인 안 됨)');
      const lastKnown = bundle.jsonKeys.find(
        (k) => k.root === DESKTOP_LAST_KNOWN_ACCOUNT.root && k.relPath === DESKTOP_LAST_KNOWN_ACCOUNT.relPath && k.key === DESKTOP_LAST_KNOWN_ACCOUNT.key,
      );
      const lastKnownId = str(lastKnown?.value);
      if (lastKnownId && lastKnownId !== accountId) {
        throw new Error(
          'claude: 계정 정보 불일치 — ~/.claude.json 과 Claude Desktop(config.json)의 계정이 다릅니다. Desktop 의 Code 탭을 한 번 열어 동기화한 뒤 다시 시도하세요',
        );
      }
      return {
        tool: 'claude',
        accountId,
        orgId: str(acc.organizationUuid),
        email: str(acc.emailAddress),
        displayName: str(acc.displayName),
      };
    },
    writeAuth: (bundle) => applyAuth(paths, bundle),
  };
}
