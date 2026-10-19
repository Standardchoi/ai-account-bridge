import path from 'node:path';
import type { AuthBundle, AuthPathSpec } from '../../core/auth-bundle.js';
import { decodeJwtPayload, NotLoggedInError, type Identity } from '../../core/identity.js';
import { applyAuth, collectAuth } from '../../infra/auth-fs.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { AuthProviderOptions, ToolAuthProvider } from '../types.js';

const PACKAGE = 'OpenAI.Codex_2p2nqsd0c76g0';
const AUTH_FILE: AuthPathSpec = { root: 'home', relPath: '.codex/auth.json' };
const PROFILE_DIR = `Packages/${PACKAGE}/LocalCache/Roaming/Codex`;
// 라이브 Codex 웹 프로필(Chromium) 위치 — 루트 바로 아래 Network/Local State/Local Storage 는
// 4월 이후로 갱신되지 않는다. 실제 로그인 세션은 web/Codex 아래의 프로필에 있다.
const PROFILE_PATHS: AuthPathSpec[] = ['web/Codex/Local State', 'web/Codex/Default/Network', 'web/Codex/Default/Local Storage'].map(
  (rel) => ({ root: 'localAppData', relPath: `${PROFILE_DIR}/${rel}` }),
);

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function codexAuthProvider(paths: PathProvider, opts: AuthProviderOptions = {}): ToolAuthProvider {
  const specs = opts.withAppProfile ? [AUTH_FILE, ...PROFILE_PATHS] : [AUTH_FILE];
  return {
    id: 'codex',
    app: {
      aumid: `${PACKAGE}!App`,
      packageDirMarker: `\\WindowsApps\\OpenAI.Codex_`,
      managedDirs: [path.join(paths.localAppData, 'OpenAI', 'Codex')],
      cliNames: ['codex'],
      cliCommandMarkers: ['@openai/codex'],
    },
    readCurrentAuth: () => collectAuth(paths, 'codex', specs),
    identityOf(bundle: AuthBundle): Identity {
      const file = bundle.files.find((f) => f.root === AUTH_FILE.root && f.relPath === AUTH_FILE.relPath);
      if (!file?.data) throw new NotLoggedInError('codex: auth.json 없음 (로그인 안 됨)');
      let auth;
      try {
        auth = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'));
      } catch {
        throw new NotLoggedInError('codex: auth.json 손상됨 (로그인 안 됨)');
      }
      const accountId = str(auth?.tokens?.account_id);
      if (!accountId) throw new NotLoggedInError('codex: tokens.account_id 없음 (로그인 안 됨)');
      const idToken = str(auth.tokens.id_token);
      // id_token 은 표시용(이메일/이름)일 뿐이므로 디코드 실패가 신원 확인을 막지 않는다.
      let claims: Record<string, unknown> = {};
      if (idToken) {
        try {
          claims = decodeJwtPayload(idToken);
        } catch {
          claims = {};
        }
      }
      return { tool: 'codex', accountId, email: str(claims.email), displayName: str(claims.name) };
    },
    writeAuth: (bundle) => applyAuth(paths, bundle),
  };
}
