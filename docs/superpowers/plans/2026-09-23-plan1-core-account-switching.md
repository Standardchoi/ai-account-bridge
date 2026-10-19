# Plan 1 — 코어 + 계정 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GPT(Codex)·Claude 계정을 등록(스냅샷)하고 백업/검증/롤백을 거쳐 안전하게 전환하는 코어 라이브러리와 개발용 CLI를 만든 뒤, 실제 앱으로 Phase 0 검증 V1~V4 를 수행한다.

**Architecture:** 설계 문서의 계층 구조(`core` 순수 로직 / `infra` IO 경계 / `providers` 도구별 어댑터 / `services` 오케스트레이션)를 그대로 따른다. 모든 경로는 `PathProvider` 로 주입해 테스트는 임시 폴더에서 돈다. Electron UI 는 이후 계획에서 붙이며, 이번 계획은 `tsx` 로 실행하는 CLI 가 진입점이다.

**Tech Stack:** Node 22, TypeScript(strict, NodeNext ESM), Vitest, tsx, better-sqlite3, Windows PowerShell 5.1 (DPAPI·프로세스 제어)

**관련 문서:** [설계](../specs/2026-09-23-ai-account-bridge-design.md) · [아키텍처](../../architecture.md)

**이후 계획 (이번 범위 아님):**
- Plan 2 — 라이브러리 조회(Codex/Claude reader, IR, 계정 태그) + 검증 V5, V8, V10
- Plan 3 — 이관(writer 양방향, 인덱스 등록, 이관 이력) + 검증 V6, V7, V9
- Plan 4 — Electron UI, `safeStorage` 전환, 패키징(NSIS)

**이번 계획에서 설계 문서와 달라지는 점 (Task 13 에서 문서에 반영):**
- 스냅샷 암호화: Electron 이 아직 없으므로 `safeStorage` 대신 PowerShell 로 같은 DPAPI(`ProtectedData`, CurrentUser)를 호출. `SecretStore` 인터페이스 뒤에 두어 Plan 4 에서 교체.
- `accounts.org_id` 는 `NOT NULL DEFAULT ''` (SQLite UNIQUE 는 NULL 을 서로 다르게 취급하므로 Codex 계정 중복 방지).
- 전환 순서: 인증 교체 → **신원 검증 → 앱 실행** (실행 전에 검증해야 잘못된 계정으로 앱이 뜨지 않음).

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | 프로젝트 설정 |
| `src/main/core/auth-bundle.ts` | `ToolId`, `RootKey`, `AuthBundle` 타입 + 직렬화 |
| `src/main/core/identity.ts` | `Identity` 타입, JWT 페이로드 디코드, 신원 비교 |
| `src/main/infra/path-provider.ts` | 시스템 경로 해석, 루트+상대경로 결합 |
| `src/main/infra/auth-fs.ts` | 인증 파일 세트 수집(`collectAuth`) / 적용(`applyAuth`) |
| `src/main/infra/powershell.ts` | PowerShell 실행 헬퍼 (UTF-8 출력) |
| `src/main/infra/secret-store.ts` | `SecretStore` 인터페이스 + DPAPI 구현 |
| `src/main/infra/app-db.ts` | 자체 SQLite: `accounts`, `switch_events` |
| `src/main/infra/backup-store.ts` | 전환 직전 인증 세트 암호화 백업/복원/정리 |
| `src/main/infra/process-controller.ts` | `ProcessController` 인터페이스 + Windows 구현 |
| `src/main/providers/types.ts` | `AppInfo`, `ToolAuthProvider` 인터페이스 |
| `src/main/providers/codex/auth.ts` | Codex 인증 세트 정의 + 신원 추출 |
| `src/main/providers/claude/auth.ts` | Claude 인증 세트 정의 + 신원 추출 |
| `src/main/services/app-processes.ts` | 프로세스 목록을 앱/독립 CLI 로 분류 |
| `src/main/services/account-service.ts` | 계정 등록, 스냅샷 저장/로드 |
| `src/main/services/switch-service.ts` | 전환 오케스트레이션 + 롤백 |
| `src/cli/index.ts` | 개발용 CLI (`list`, `current`, `save`, `switch`) |
| `test/helpers/*.ts` | 임시 경로, 가짜 JWT/인증 파일, 가짜 SecretStore/ProcessController |
| `docs/verification/phase0-auth.md` | V1~V4 수동 검증 런북 + 결과 기록 |

---

### Task 1: 프로젝트 스캐폴드

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Test: `test/smoke.test.ts`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "ai-account-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "cli": "tsx src/cli/index.ts"
  }
}
```

- [ ] **Step 2: 의존성 설치**

Run:
```bash
npm install better-sqlite3
npm install -D typescript vitest tsx @types/node @types/better-sqlite3
```
Expected: 오류 없이 완료, `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 존재.

- [ ] **Step 3: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 4: vitest.config.ts 작성**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: 스모크 테스트 작성 후 실행**

`test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

describe('toolchain', () => {
  it('loads better-sqlite3 native module', () => {
    const db = new Database(':memory:');
    expect(db.prepare('select 1 as v').get()).toEqual({ v: 1 });
    db.close();
  });
});
```

Run: `npx vitest run test/smoke.test.ts`
Expected: PASS (1 test)

Run: `npx tsc --noEmit`
Expected: 출력 없음

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts test/smoke.test.ts
git commit -m "chore: scaffold TypeScript + Vitest project"
```

---

### Task 2: 코어 타입 — AuthBundle, Identity

**Files:**
- Create: `src/main/core/auth-bundle.ts`, `src/main/core/identity.ts`
- Test: `test/unit/core.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/core.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { deserializeBundle, serializeBundle, type AuthBundle } from '../../src/main/core/auth-bundle.js';
import { decodeJwtPayload, sameIdentity } from '../../src/main/core/identity.js';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('AuthBundle serialization', () => {
  it('round-trips', () => {
    const bundle: AuthBundle = {
      tool: 'claude',
      files: [{ root: 'home', relPath: '.claude/.credentials.json', data: Buffer.from('{}').toString('base64') }],
      replaceDirs: [],
      jsonKeys: [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount', value: { accountUuid: 'u1' } }],
    };
    expect(deserializeBundle(serializeBundle(bundle))).toEqual(bundle);
  });
});

describe('identity', () => {
  it('decodes JWT payload without verifying signature', () => {
    const jwt = `${b64url({ alg: 'none' })}.${b64url({ email: 'a@x.com', name: '에이' })}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual({ email: 'a@x.com', name: '에이' });
  });

  it('rejects malformed JWT', () => {
    expect(() => decodeJwtPayload('not-a-jwt')).toThrow('invalid JWT');
  });

  it('compares identities by tool, accountId and orgId', () => {
    expect(sameIdentity({ tool: 'codex', accountId: 'a' }, { tool: 'codex', accountId: 'a', email: 'x' })).toBe(true);
    expect(sameIdentity({ tool: 'claude', accountId: 'a', orgId: 'o1' }, { tool: 'claude', accountId: 'a', orgId: 'o2' })).toBe(false);
    expect(sameIdentity({ tool: 'codex', accountId: 'a' }, { tool: 'claude', accountId: 'a' })).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/core.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/core/auth-bundle.js'`

- [ ] **Step 3: 구현**

`src/main/core/auth-bundle.ts`:
```ts
export type ToolId = 'codex' | 'claude';
export type RootKey = 'home' | 'appData' | 'localAppData';

export interface AuthPathSpec {
  root: RootKey;
  relPath: string; // '/' 구분자 상대 경로
}

export interface AuthFile extends AuthPathSpec {
  data: string | null; // base64, null = 파일 없음
}

export interface JsonKeyValue extends AuthPathSpec {
  key: string;
  value: unknown; // null = 키 없음
}

export interface AuthBundle {
  tool: ToolId;
  files: AuthFile[];
  replaceDirs: AuthPathSpec[]; // 적용 시 통째로 지우고 files 로 다시 채울 폴더
  jsonKeys: JsonKeyValue[]; // JSON 파일의 특정 최상위 키만 교체
}

export function serializeBundle(bundle: AuthBundle): Buffer {
  return Buffer.from(JSON.stringify(bundle), 'utf8');
}

export function deserializeBundle(buf: Buffer): AuthBundle {
  return JSON.parse(buf.toString('utf8')) as AuthBundle;
}
```

`src/main/core/identity.ts`:
```ts
import type { ToolId } from './auth-bundle.js';

export interface Identity {
  tool: ToolId;
  accountId: string;
  orgId?: string;
  email?: string;
  displayName?: string;
}

// 표시용 디코드. 서명은 검증하지 않는다.
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('invalid JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.tool === b.tool && a.accountId === b.accountId && (a.orgId ?? '') === (b.orgId ?? '');
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/core.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/core test/unit/core.test.ts
git commit -m "feat(core): add AuthBundle and Identity types"
```

---

### Task 3: PathProvider + 테스트 헬퍼

**Files:**
- Create: `src/main/infra/path-provider.ts`, `test/helpers/tmp-paths.ts`
- Test: `test/unit/path-provider.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/path-provider.test.ts`:
```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRoot, systemPaths } from '../../src/main/infra/path-provider.js';

describe('systemPaths', () => {
  it('uses USERPROFILE / APPDATA / LOCALAPPDATA', () => {
    const p = systemPaths({ USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\R', LOCALAPPDATA: 'C:\\U\\L' });
    expect(p).toEqual({
      home: 'C:\\U',
      appData: 'C:\\U\\R',
      localAppData: 'C:\\U\\L',
      appDataDir: path.join('C:\\U\\R', 'ai-account-bridge'),
    });
  });

  it('derives AppData folders from home when env vars are missing', () => {
    const p = systemPaths({ USERPROFILE: 'C:\\U' });
    expect(p.appData).toBe(path.join('C:\\U', 'AppData', 'Roaming'));
    expect(p.localAppData).toBe(path.join('C:\\U', 'AppData', 'Local'));
  });
});

describe('resolveRoot', () => {
  it('joins a root with a slash-separated relative path', () => {
    const p = systemPaths({ USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\R', LOCALAPPDATA: 'C:\\U\\L' });
    expect(resolveRoot(p, 'home', '.codex/auth.json')).toBe(path.join('C:\\U', '.codex', 'auth.json'));
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/path-provider.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/infra/path-provider.ts`:
```ts
import os from 'node:os';
import path from 'node:path';
import type { RootKey } from '../core/auth-bundle.js';

export interface PathProvider {
  home: string;
  appData: string;
  localAppData: string;
  appDataDir: string; // 본 앱 저장소
}

export function systemPaths(env: NodeJS.ProcessEnv = process.env): PathProvider {
  const home = env.USERPROFILE ?? os.homedir();
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  return { home, appData, localAppData, appDataDir: path.join(appData, 'ai-account-bridge') };
}

export function resolveRoot(paths: PathProvider, root: RootKey, relPath: string): string {
  return path.join(paths[root], ...relPath.split('/'));
}
```

`test/helpers/tmp-paths.ts` (이후 태스크에서 공용):
```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PathProvider } from '../../src/main/infra/path-provider.js';

export async function tmpPaths(): Promise<PathProvider> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-'));
  const p: PathProvider = {
    home: path.join(root, 'home'),
    appData: path.join(root, 'roaming'),
    localAppData: path.join(root, 'local'),
    appDataDir: path.join(root, 'roaming', 'ai-account-bridge'),
  };
  for (const d of [p.home, p.appData, p.localAppData]) await fs.mkdir(d, { recursive: true });
  return p;
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/path-provider.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/path-provider.ts test/helpers/tmp-paths.ts test/unit/path-provider.test.ts
git commit -m "feat(infra): add PathProvider and temp-path test helpers"
```

---

### Task 4: 인증 파일 세트 수집/적용 (auth-fs)

**Files:**
- Create: `src/main/infra/auth-fs.ts`
- Test: `test/unit/auth-fs.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/auth-fs.test.ts`:
```ts
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAuth, collectAuth } from '../../src/main/infra/auth-fs.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
beforeEach(async () => { p = await tmpPaths(); });

describe('collectAuth / applyAuth', () => {
  it('captures a file and restores it later', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    await writeFile(f, 'A');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    await writeFile(f, 'B');
    await applyAuth(p, snap);
    expect(await readText(f)).toBe('A');
  });

  it('records a missing file as null and deletes it on apply', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    expect(snap.files[0]?.data).toBeNull();
    await writeFile(f, 'B');
    await applyAuth(p, snap);
    expect(await exists(f)).toBe(false);
  });

  it('replaces a whole directory (no stale files left behind)', async () => {
    const dir = path.join(p.appData, 'Claude', 'Local Storage');
    await writeFile(path.join(dir, 'leveldb', '000001.log'), 'A1');
    const snap = await collectAuth(p, 'claude', [{ root: 'appData', relPath: 'Claude/Local Storage' }]);
    expect(snap.replaceDirs).toEqual([{ root: 'appData', relPath: 'Claude/Local Storage' }]);
    await writeFile(path.join(dir, 'leveldb', '000002.log'), 'B-extra');
    await applyAuth(p, snap);
    expect(await readText(path.join(dir, 'leveldb', '000001.log'))).toBe('A1');
    expect(await exists(path.join(dir, 'leveldb', '000002.log'))).toBe(false);
  });

  it('swaps only one top-level JSON key and preserves the others', async () => {
    const f = path.join(p.home, '.claude.json');
    await writeFile(f, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: 'A' } }));
    const snap = await collectAuth(p, 'claude', [], [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount' }]);
    await writeFile(f, JSON.stringify({ numStartups: 9, oauthAccount: { accountUuid: 'B' } }));
    await applyAuth(p, snap);
    expect(JSON.parse(await readText(f))).toEqual({ numStartups: 9, oauthAccount: { accountUuid: 'A' } });
  });

  it('removes the JSON key when the snapshot had none', async () => {
    const f = path.join(p.home, '.claude.json');
    await writeFile(f, JSON.stringify({ numStartups: 1 }));
    const snap = await collectAuth(p, 'claude', [], [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount' }]);
    await writeFile(f, JSON.stringify({ numStartups: 1, oauthAccount: { accountUuid: 'B' } }));
    await applyAuth(p, snap);
    expect(JSON.parse(await readText(f))).toEqual({ numStartups: 1 });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/auth-fs.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/infra/auth-fs.ts`:
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AuthBundle, AuthFile, AuthPathSpec, JsonKeyValue, ToolId } from '../core/auth-bundle.js';
import { resolveRoot, type PathProvider } from './path-provider.js';

export interface JsonKeySpec extends AuthPathSpec {
  key: string;
}

async function statOrNull(full: string) {
  try {
    return await fs.stat(full);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function walk(dir: string, relBase: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function readJsonOrNull(full: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(full, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function writeAtomic(full: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.aab-tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, full);
}

export async function collectAuth(
  paths: PathProvider,
  tool: ToolId,
  fileSpecs: AuthPathSpec[],
  keySpecs: JsonKeySpec[] = [],
): Promise<AuthBundle> {
  const files: AuthFile[] = [];
  const replaceDirs: AuthPathSpec[] = [];
  for (const spec of fileSpecs) {
    const full = resolveRoot(paths, spec.root, spec.relPath);
    const st = await statOrNull(full);
    if (st?.isDirectory()) {
      replaceDirs.push({ root: spec.root, relPath: spec.relPath });
      for (const rel of await walk(full, spec.relPath)) {
        const data = await fs.readFile(resolveRoot(paths, spec.root, rel));
        files.push({ root: spec.root, relPath: rel, data: data.toString('base64') });
      }
    } else {
      const data = st ? (await fs.readFile(full)).toString('base64') : null;
      files.push({ root: spec.root, relPath: spec.relPath, data });
    }
  }
  const jsonKeys: JsonKeyValue[] = [];
  for (const spec of keySpecs) {
    const obj = await readJsonOrNull(resolveRoot(paths, spec.root, spec.relPath));
    const value = obj && spec.key in obj ? obj[spec.key] : null;
    jsonKeys.push({ root: spec.root, relPath: spec.relPath, key: spec.key, value });
  }
  return { tool, files, replaceDirs, jsonKeys };
}

export async function applyAuth(paths: PathProvider, bundle: AuthBundle): Promise<void> {
  for (const dir of bundle.replaceDirs) {
    await fs.rm(resolveRoot(paths, dir.root, dir.relPath), { recursive: true, force: true });
  }
  for (const f of bundle.files) {
    const full = resolveRoot(paths, f.root, f.relPath);
    if (f.data === null) {
      await fs.rm(full, { recursive: true, force: true });
    } else {
      await writeAtomic(full, Buffer.from(f.data, 'base64'));
    }
  }
  for (const k of bundle.jsonKeys) {
    const full = resolveRoot(paths, k.root, k.relPath);
    const obj = (await readJsonOrNull(full)) ?? {};
    if (k.value === null) delete obj[k.key];
    else obj[k.key] = k.value;
    await writeAtomic(full, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'));
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/auth-fs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/auth-fs.ts test/unit/auth-fs.test.ts
git commit -m "feat(infra): collect/apply auth file sets with dir replace and JSON key patch"
```

---

### Task 5: 도구별 인증 프로바이더 (Codex, Claude)

**Files:**
- Create: `src/main/providers/types.ts`, `src/main/providers/codex/auth.ts`, `src/main/providers/claude/auth.ts`, `test/helpers/fake-auth.ts`
- Test: `test/unit/providers-auth.test.ts`

- [ ] **Step 1: 테스트 헬퍼 작성**

`test/helpers/fake-auth.ts`:
```ts
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
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/unit/providers-auth.test.ts`:
```ts
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

  it('includes the Electron profile only when withAppProfile is set', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const profile = path.join(p.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex');
    await writeFile(path.join(profile, 'Network', 'Cookies'), 'cookieA');
    expect((await codexAuthProvider(p).readCurrentAuth()).files).toHaveLength(1);
    const withProfile = await codexAuthProvider(p, { withAppProfile: true }).readCurrentAuth();
    expect(withProfile.files.map((f) => f.relPath)).toContain(
      'Packages/OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming/Codex/Network/Cookies',
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
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/unit/providers-auth.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 4: 구현**

`src/main/providers/types.ts`:
```ts
import type { AuthBundle, ToolId } from '../core/auth-bundle.js';
import type { Identity } from '../core/identity.js';

export interface AppInfo {
  aumid: string; // shell:AppsFolder 실행용
  packageDirMarker: string; // 앱 프로세스 경로에 포함되는 문자열
  managedDirs: string[]; // 앱이 띄우는 하위 프로세스(내장 CLI 등) 경로
  cliNames: string[]; // 독립 실행 CLI 프로세스 이름 (소문자)
}

export interface ToolAuthProvider {
  id: ToolId;
  app: AppInfo;
  readCurrentAuth(): Promise<AuthBundle>;
  identityOf(bundle: AuthBundle): Identity; // 로그인 안 됨이면 throw
  writeAuth(bundle: AuthBundle): Promise<void>; // 호출 전 앱 종료는 호출자 책임
}

export interface AuthProviderOptions {
  withAppProfile?: boolean; // Electron 프로필(쿠키 등)까지 교체 — Phase 0 V2/V3 결과로 기본값 결정
}
```

`src/main/providers/codex/auth.ts`:
```ts
import path from 'node:path';
import type { AuthBundle, AuthPathSpec } from '../../core/auth-bundle.js';
import { decodeJwtPayload, type Identity } from '../../core/identity.js';
import { applyAuth, collectAuth } from '../../infra/auth-fs.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { AuthProviderOptions, ToolAuthProvider } from '../types.js';

const PACKAGE = 'OpenAI.Codex_2p2nqsd0c76g0';
const AUTH_FILE: AuthPathSpec = { root: 'home', relPath: '.codex/auth.json' };
const PROFILE_DIR = `Packages/${PACKAGE}/LocalCache/Roaming/Codex`;
const PROFILE_PATHS: AuthPathSpec[] = ['Network', 'Local State', 'Local Storage'].map((name) => ({
  root: 'localAppData',
  relPath: `${PROFILE_DIR}/${name}`,
}));

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
    },
    readCurrentAuth: () => collectAuth(paths, 'codex', specs),
    identityOf(bundle: AuthBundle): Identity {
      const file = bundle.files.find((f) => f.root === AUTH_FILE.root && f.relPath === AUTH_FILE.relPath);
      if (!file?.data) throw new Error('codex: auth.json 없음 (로그인 안 됨)');
      const auth = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'));
      const accountId = str(auth?.tokens?.account_id);
      if (!accountId) throw new Error('codex: tokens.account_id 없음 (로그인 안 됨)');
      const idToken = str(auth.tokens.id_token);
      const claims = idToken ? decodeJwtPayload(idToken) : {};
      return { tool: 'codex', accountId, email: str(claims.email), displayName: str(claims.name) };
    },
    writeAuth: (bundle) => applyAuth(paths, bundle),
  };
}
```

`src/main/providers/claude/auth.ts`:
```ts
import path from 'node:path';
import type { AuthBundle, AuthPathSpec } from '../../core/auth-bundle.js';
import type { Identity } from '../../core/identity.js';
import { applyAuth, collectAuth, type JsonKeySpec } from '../../infra/auth-fs.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { AuthProviderOptions, ToolAuthProvider } from '../types.js';

const CREDENTIALS: AuthPathSpec = { root: 'home', relPath: '.claude/.credentials.json' };
const OAUTH_ACCOUNT: JsonKeySpec = { root: 'home', relPath: '.claude.json', key: 'oauthAccount' };
const PROFILE_PATHS: AuthPathSpec[] = ['Network', 'Local State', 'Local Storage'].map((name) => ({
  root: 'appData',
  relPath: `Claude/${name}`,
}));

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function claudeAuthProvider(paths: PathProvider, opts: AuthProviderOptions = {}): ToolAuthProvider {
  const specs = opts.withAppProfile ? [CREDENTIALS, ...PROFILE_PATHS] : [CREDENTIALS];
  return {
    id: 'claude',
    app: {
      aumid: 'Claude_pzs8sxrjxfjjc!Claude',
      packageDirMarker: `\\WindowsApps\\Claude_`,
      managedDirs: [path.join(paths.appData, 'Claude', 'claude-code')],
      cliNames: ['claude'],
    },
    readCurrentAuth: () => collectAuth(paths, 'claude', specs, [OAUTH_ACCOUNT]),
    identityOf(bundle: AuthBundle): Identity {
      const entry = bundle.jsonKeys.find((k) => k.relPath === OAUTH_ACCOUNT.relPath && k.key === OAUTH_ACCOUNT.key);
      const acc = entry?.value as Record<string, unknown> | null | undefined;
      const accountId = str(acc?.accountUuid);
      if (!acc || !accountId) throw new Error('claude: oauthAccount 없음 (로그인 안 됨)');
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
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run test/unit/providers-auth.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/main/providers test/helpers/fake-auth.ts test/unit/providers-auth.test.ts
git commit -m "feat(providers): add Codex and Claude auth providers"
```

---

### Task 6: PowerShell 헬퍼 + DPAPI SecretStore

**Files:**
- Create: `src/main/infra/powershell.ts`, `src/main/infra/secret-store.ts`, `test/helpers/fake-secrets.ts`
- Test: `test/unit/secret-store.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/secret-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { dpapiSecretStore } from '../../src/main/infra/secret-store.js';

describe.skipIf(process.platform !== 'win32')('dpapiSecretStore', () => {
  it('encrypts to different bytes and decrypts back', async () => {
    const store = dpapiSecretStore();
    const plain = Buffer.from('{"token":"비밀"}', 'utf8');
    const cipher = await store.encrypt(plain);
    expect(cipher.equals(plain)).toBe(false);
    expect((await store.decrypt(cipher)).toString('utf8')).toBe('{"token":"비밀"}');
  }, 30_000);

  it('fails to decrypt garbage', async () => {
    await expect(dpapiSecretStore().decrypt(Buffer.from('garbage'))).rejects.toThrow();
  }, 30_000);
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/secret-store.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/infra/powershell.ts`:
```ts
import { spawn } from 'node:child_process';

// Windows PowerShell 5.1 실행. 출력은 UTF-8 로 강제(한글 경로 깨짐 방지).
export function runPowerShell(script: string, stdin = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    ps.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    ps.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`powershell exit ${code}: ${err.trim()}`));
    });
    ps.stdin.end(stdin);
  });
}
```

`src/main/infra/secret-store.ts`:
```ts
import { runPowerShell } from './powershell.js';

export interface SecretStore {
  encrypt(plain: Buffer): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<Buffer>;
}

function dpapi(op: 'Protect' | 'Unprotect') {
  return async (input: Buffer): Promise<Buffer> => {
    const script =
      'Add-Type -AssemblyName System.Security; ' +
      '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd()); ' +
      `$out = [Security.Cryptography.ProtectedData]::${op}($in, $null, 'CurrentUser'); ` +
      '[Console]::Out.Write([Convert]::ToBase64String($out))';
    const b64 = await runPowerShell(script, input.toString('base64'));
    return Buffer.from(b64.trim(), 'base64');
  };
}

// 현재 Windows 사용자에 귀속되는 DPAPI 암호화. Plan 4 에서 Electron safeStorage 로 교체 가능.
export function dpapiSecretStore(): SecretStore {
  return { encrypt: dpapi('Protect'), decrypt: dpapi('Unprotect') };
}
```

`test/helpers/fake-secrets.ts` (이후 태스크 공용, 빠른 테스트용):
```ts
import type { SecretStore } from '../../src/main/infra/secret-store.js';

const PREFIX = Buffer.from('FAKE:');

export function fakeSecretStore(): SecretStore {
  return {
    encrypt: async (plain) => Buffer.concat([PREFIX, plain]),
    decrypt: async (cipher) => {
      if (!cipher.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('fake decrypt failed');
      return cipher.subarray(PREFIX.length);
    },
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/secret-store.test.ts`
Expected: PASS (2 tests) — Windows 에서만 실행됨

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/powershell.ts src/main/infra/secret-store.ts test/helpers/fake-secrets.ts test/unit/secret-store.test.ts
git commit -m "feat(infra): add DPAPI secret store via PowerShell"
```

---

### Task 7: AppDb (accounts, switch_events)

**Files:**
- Create: `src/main/infra/app-db.ts`
- Test: `test/unit/app-db.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/app-db.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDb, type NewAccount } from '../../src/main/infra/app-db.js';

const acct = (over: Partial<NewAccount> = {}): NewAccount => ({
  tool: 'codex', accountId: 'A', orgId: '', email: 'a@x.com', displayName: null,
  label: 'work', snapshotPath: 'C:\\s\\a.bin', snapshotAt: '2026-09-23T00:00:00Z', ...over,
});

let db: AppDb;
beforeEach(() => { db = new AppDb(':memory:'); });

describe('AppDb accounts', () => {
  it('inserts a new account', () => {
    const r = db.upsertAccount(acct());
    expect(r.created).toBe(true);
    expect(r.row).toMatchObject({ tool: 'codex', accountId: 'A', label: 'work', status: 'ok' });
    expect(db.findAccountByLabel('codex', 'work')?.id).toBe(r.row.id);
  });

  it('updates the snapshot of an existing identity but keeps its label', () => {
    db.upsertAccount(acct());
    const r = db.upsertAccount(acct({ label: 'renamed', snapshotAt: '2026-09-24T00:00:00Z' }));
    expect(r.created).toBe(false);
    expect(r.row.label).toBe('work');
    expect(r.row.snapshotAt).toBe('2026-09-24T00:00:00Z');
    expect(db.listAccounts()).toHaveLength(1);
  });

  it('rejects a label already used by another identity of the same tool', () => {
    db.upsertAccount(acct());
    expect(() => db.upsertAccount(acct({ accountId: 'B' }))).toThrow("'work'");
  });

  it('treats the same accountId under different orgs as different accounts', () => {
    db.upsertAccount(acct({ tool: 'claude', orgId: 'o1', label: 'a' }));
    db.upsertAccount(acct({ tool: 'claude', orgId: 'o2', label: 'b' }));
    expect(db.listAccounts('claude')).toHaveLength(2);
    expect(db.findAccountByIdentity('claude', 'A', 'o2')?.label).toBe('b');
  });

  it('updates account status', () => {
    const { row } = db.upsertAccount(acct());
    db.setAccountStatus(row.id, 'needs_relogin');
    expect(db.findAccountByLabel('codex', 'work')?.status).toBe('needs_relogin');
  });
});

describe('AppDb switch events', () => {
  it('records switches in order', () => {
    const { row } = db.upsertAccount(acct());
    db.recordSwitch('codex', row.id, 'ok', '2026-09-23T01:00:00Z');
    db.recordSwitch('codex', null, 'rolled_back', '2026-09-23T02:00:00Z');
    expect(db.listSwitches('codex')).toEqual([
      { accountRowId: row.id, switchedAt: '2026-09-23T01:00:00Z', result: 'ok' },
      { accountRowId: null, switchedAt: '2026-09-23T02:00:00Z', result: 'rolled_back' },
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/app-db.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/infra/app-db.ts`:
```ts
import Database from 'better-sqlite3';
import type { ToolId } from '../core/auth-bundle.js';

export type AccountStatus = 'ok' | 'needs_relogin';
export type SwitchResultCode = 'ok' | 'rolled_back';

export interface NewAccount {
  tool: ToolId;
  accountId: string;
  orgId: string; // 없으면 ''
  email: string | null;
  displayName: string | null;
  label: string;
  snapshotPath: string;
  snapshotAt: string;
}

export interface AccountRow extends NewAccount {
  id: number;
  status: AccountStatus;
}

export interface SwitchEvent {
  accountRowId: number | null;
  switchedAt: string;
  result: SwitchResultCode;
}

const MIGRATIONS = [
  `CREATE TABLE accounts (
     id            INTEGER PRIMARY KEY,
     tool          TEXT NOT NULL,
     account_id    TEXT NOT NULL,
     org_id        TEXT NOT NULL DEFAULT '',
     email         TEXT,
     display_name  TEXT,
     label         TEXT NOT NULL,
     snapshot_path TEXT NOT NULL,
     snapshot_at   TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'ok',
     UNIQUE (tool, account_id, org_id),
     UNIQUE (tool, label)
   );
   CREATE TABLE switch_events (
     id          INTEGER PRIMARY KEY,
     tool        TEXT NOT NULL,
     account_id  INTEGER REFERENCES accounts(id),
     switched_at TEXT NOT NULL,
     result      TEXT NOT NULL
   );`,
];

const ACCOUNT_COLUMNS = `id, tool, account_id AS accountId, org_id AS orgId, email, display_name AS displayName,
  label, snapshot_path AS snapshotPath, snapshot_at AS snapshotAt, status`;

export class AppDb {
  private db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]!);
      this.db.pragma(`user_version = ${i + 1}`);
    }
  }

  close(): void {
    this.db.close();
  }

  findAccountByIdentity(tool: ToolId, accountId: string, orgId: string): AccountRow | undefined {
    return this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool = ? AND account_id = ? AND org_id = ?`)
      .get(tool, accountId, orgId) as AccountRow | undefined;
  }

  findAccountByLabel(tool: ToolId, label: string): AccountRow | undefined {
    return this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool = ? AND label = ?`)
      .get(tool, label) as AccountRow | undefined;
  }

  listAccounts(tool?: ToolId): AccountRow[] {
    return tool
      ? (this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE tool = ? ORDER BY id`).all(tool) as AccountRow[])
      : (this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY tool, id`).all() as AccountRow[]);
  }

  // 같은 신원이면 스냅샷만 갱신(라벨 유지), 새 신원이면 추가.
  upsertAccount(a: NewAccount): { row: AccountRow; created: boolean } {
    const existing = this.findAccountByIdentity(a.tool, a.accountId, a.orgId);
    if (existing) {
      this.db
        .prepare(`UPDATE accounts SET email = ?, display_name = ?, snapshot_path = ?, snapshot_at = ?, status = 'ok' WHERE id = ?`)
        .run(a.email, a.displayName, a.snapshotPath, a.snapshotAt, existing.id);
      return { row: this.findAccountByLabel(a.tool, existing.label)!, created: false };
    }
    if (this.findAccountByLabel(a.tool, a.label)) {
      throw new Error(`label '${a.label}' is already used by another ${a.tool} account`);
    }
    this.db
      .prepare(
        `INSERT INTO accounts (tool, account_id, org_id, email, display_name, label, snapshot_path, snapshot_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.tool, a.accountId, a.orgId, a.email, a.displayName, a.label, a.snapshotPath, a.snapshotAt);
    return { row: this.findAccountByLabel(a.tool, a.label)!, created: true };
  }

  setAccountStatus(id: number, status: AccountStatus): void {
    this.db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id);
  }

  recordSwitch(tool: ToolId, accountRowId: number | null, result: SwitchResultCode, at = new Date().toISOString()): void {
    this.db
      .prepare('INSERT INTO switch_events (tool, account_id, switched_at, result) VALUES (?, ?, ?, ?)')
      .run(tool, accountRowId, at, result);
  }

  listSwitches(tool: ToolId): SwitchEvent[] {
    return this.db
      .prepare('SELECT account_id AS accountRowId, switched_at AS switchedAt, result FROM switch_events WHERE tool = ? ORDER BY id')
      .all(tool) as SwitchEvent[];
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/app-db.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/app-db.ts test/unit/app-db.test.ts
git commit -m "feat(infra): add AppDb with accounts and switch events"
```

---

### Task 8: BackupStore

**Files:**
- Create: `src/main/infra/backup-store.ts`
- Test: `test/unit/backup-store.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/backup-store.test.ts`:
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthBundle } from '../../src/main/core/auth-bundle.js';
import { BackupStore } from '../../src/main/infra/backup-store.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { tmpPaths } from '../helpers/tmp-paths.js';

const bundle = (data: string): AuthBundle => ({
  tool: 'codex',
  files: [{ root: 'home', relPath: '.codex/auth.json', data: Buffer.from(data).toString('base64') }],
  replaceDirs: [],
  jsonKeys: [],
});

describe('BackupStore', () => {
  it('saves an encrypted backup and loads it back', async () => {
    const p = await tmpPaths();
    const store = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore());
    const file = await store.save(bundle('A'));
    expect(file.startsWith(path.join(p.appDataDir, 'backups', 'codex'))).toBe(true);
    expect((await fs.readFile(file)).subarray(0, 5).toString()).toBe('FAKE:');
    expect(await store.load(file)).toEqual(bundle('A'));
  });

  it('keeps only the newest N backups per tool', async () => {
    const p = await tmpPaths();
    const store = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore(), 2);
    await store.save(bundle('1'));
    await store.save(bundle('2'));
    await store.save(bundle('3'));
    expect(await fs.readdir(path.join(p.appDataDir, 'backups', 'codex'))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/backup-store.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/infra/backup-store.ts`:
```ts
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deserializeBundle, serializeBundle, type AuthBundle } from '../core/auth-bundle.js';
import type { SecretStore } from './secret-store.js';

export class BackupStore {
  constructor(
    private readonly dir: string,
    private readonly secrets: SecretStore,
    private readonly keep = 20,
  ) {}

  async save(bundle: AuthBundle): Promise<string> {
    const toolDir = path.join(this.dir, bundle.tool);
    await fs.mkdir(toolDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(toolDir, `${stamp}-${crypto.randomBytes(3).toString('hex')}.bin`);
    await fs.writeFile(file, await this.secrets.encrypt(serializeBundle(bundle)));
    await this.prune(toolDir);
    return file;
  }

  async load(file: string): Promise<AuthBundle> {
    return deserializeBundle(await this.secrets.decrypt(await fs.readFile(file)));
  }

  private async prune(toolDir: string): Promise<void> {
    const names = (await fs.readdir(toolDir)).filter((n) => n.endsWith('.bin')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - this.keep))) {
      await fs.rm(path.join(toolDir, name));
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/backup-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/backup-store.ts test/unit/backup-store.test.ts
git commit -m "feat(infra): add encrypted BackupStore with pruning"
```

---

### Task 9: ProcessController + 프로세스 분류

**Files:**
- Create: `src/main/infra/process-controller.ts`, `src/main/services/app-processes.ts`, `test/helpers/fake-procs.ts`
- Test: `test/unit/app-processes.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/app-processes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { ProcInfo } from '../../src/main/infra/process-controller.js';
import type { AppInfo } from '../../src/main/providers/types.js';
import { classifyProcesses } from '../../src/main/services/app-processes.js';

const claudeApp: AppInfo = {
  aumid: 'Claude_pzs8sxrjxfjjc!Claude',
  packageDirMarker: '\\WindowsApps\\Claude_',
  managedDirs: ['C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code'],
  cliNames: ['claude'],
};

const procs: ProcInfo[] = [
  { pid: 1, name: 'claude', path: 'C:\\Program Files\\WindowsApps\\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe' },
  { pid: 2, name: 'claude', path: 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.280\\claude.exe' },
  { pid: 3, name: 'claude', path: 'C:\\Users\\u\\.local\\bin\\claude.exe' },
  { pid: 4, name: 'notepad', path: 'C:\\Windows\\notepad.exe' },
];

describe('classifyProcesses', () => {
  it('separates app (incl. app-managed children) from standalone CLI processes', () => {
    const { appProcs, strayCli } = classifyProcesses(procs, claudeApp);
    expect(appProcs.map((p) => p.pid)).toEqual([1, 2]);
    expect(strayCli.map((p) => p.pid)).toEqual([3]);
  });

  it('matches paths case-insensitively', () => {
    const upper = [{ pid: 9, name: 'CLAUDE', path: 'C:\\PROGRAM FILES\\WINDOWSAPPS\\CLAUDE_2\\APP\\CLAUDE.EXE' }];
    expect(classifyProcesses(upper, claudeApp).appProcs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/app-processes.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/infra/process-controller.ts`:
```ts
import { spawn } from 'node:child_process';
import { runPowerShell } from './powershell.js';

export interface ProcInfo {
  pid: number;
  name: string;
  path: string;
}

export interface ProcessController {
  list(): Promise<ProcInfo[]>;
  closeGracefully(pids: number[]): Promise<void>; // 메인 창 닫기 요청 (트레이로 숨을 수 있음)
  kill(pids: number[]): Promise<void>;
  launch(aumid: string): Promise<void>;
}

export function windowsProcessController(): ProcessController {
  return {
    async list() {
      const out = await runPowerShell(
        'Get-Process | Where-Object { $_.Path } | ' +
          'Select-Object @{n="pid";e={$_.Id}},@{n="name";e={$_.ProcessName}},@{n="path";e={$_.Path}} | ' +
          'ConvertTo-Json -Compress',
      );
      if (!out.trim()) return [];
      const parsed = JSON.parse(out) as ProcInfo | ProcInfo[];
      return Array.isArray(parsed) ? parsed : [parsed];
    },
    async closeGracefully(pids) {
      if (pids.length === 0) return;
      await runPowerShell(
        `foreach ($id in @(${pids.join(',')})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
          'if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }; exit 0',
      );
    },
    async kill(pids) {
      if (pids.length === 0) return;
      await runPowerShell(`Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue; exit 0`);
    },
    async launch(aumid) {
      spawn('explorer.exe', [`shell:AppsFolder\\${aumid}`], { detached: true, stdio: 'ignore' }).unref();
    },
  };
}
```

`src/main/services/app-processes.ts`:
```ts
import type { ProcInfo } from '../infra/process-controller.js';
import type { AppInfo } from '../providers/types.js';

export function classifyProcesses(procs: ProcInfo[], app: AppInfo): { appProcs: ProcInfo[]; strayCli: ProcInfo[] } {
  const marker = app.packageDirMarker.toLowerCase();
  const managed = app.managedDirs.map((d) => d.toLowerCase());
  const appProcs = procs.filter((p) => {
    const lp = p.path.toLowerCase();
    return lp.includes(marker) || managed.some((d) => lp.startsWith(d));
  });
  const strayCli = procs.filter((p) => !appProcs.includes(p) && app.cliNames.includes(p.name.toLowerCase()));
  return { appProcs, strayCli };
}
```

`test/helpers/fake-procs.ts`:
```ts
import type { ProcessController, ProcInfo } from '../../src/main/infra/process-controller.js';

export class FakeProcs implements ProcessController {
  running: ProcInfo[] = [];
  closesOnRequest = true;
  killed: number[] = [];
  launched: string[] = [];

  async list() {
    return [...this.running];
  }
  async closeGracefully(pids: number[]) {
    if (this.closesOnRequest) this.running = this.running.filter((p) => !pids.includes(p.pid));
  }
  async kill(pids: number[]) {
    this.killed.push(...pids);
    this.running = this.running.filter((p) => !pids.includes(p.pid));
  }
  async launch(aumid: string) {
    this.launched.push(aumid);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/app-processes.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Windows 구현 수동 확인 (읽기 전용 호출만)**

Run:
```bash
npx tsx -e "import('./src/main/infra/process-controller.ts').then(async m => { const l = await m.windowsProcessController().list(); console.log(l.length, l.filter(p => /claude|chatgpt|codex/i.test(p.name)).map(p => p.name + ' ' + p.path)); })"
```
Expected: 실행 중인 ChatGPT/Claude 프로세스 경로가 한글 깨짐 없이 출력됨. (`closeGracefully`/`kill`/`launch` 는 Task 12 의 실제 검증에서 확인)

- [ ] **Step 6: Commit**

```bash
git add src/main/infra/process-controller.ts src/main/services/app-processes.ts test/helpers/fake-procs.ts test/unit/app-processes.test.ts
git commit -m "feat: add Windows process controller and app process classification"
```

---

### Task 10: AccountService

**Files:**
- Create: `src/main/services/account-service.ts`
- Test: `test/unit/account-service.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/account-service.test.ts`:
```ts
import fs from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDb } from '../../src/main/infra/app-db.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { AccountService } from '../../src/main/services/account-service.js';
import { writeClaudeAuth, writeCodexAuth } from '../helpers/fake-auth.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { tmpPaths } from '../helpers/tmp-paths.js';

let p: PathProvider;
let svc: AccountService;
let db: AppDb;

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  svc = new AccountService({
    db,
    secrets: fakeSecretStore(),
    paths: p,
    providers: { codex: codexAuthProvider(p), claude: claudeAuthProvider(p) },
  });
});

describe('AccountService', () => {
  it('saves the currently logged-in account with an encrypted snapshot', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const { row, created } = await svc.saveCurrent('codex', 'work');
    expect(created).toBe(true);
    expect(row).toMatchObject({ tool: 'codex', accountId: 'acct-A', orgId: '', email: 'a@x.com', label: 'work' });
    expect(row.snapshotPath.startsWith(p.appDataDir)).toBe(true);
    expect((await fs.readFile(row.snapshotPath)).subarray(0, 5).toString()).toBe('FAKE:');
  });

  it('loads a snapshot that restores the same identity', async () => {
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com');
    const { row } = await svc.saveCurrent('claude', 'personal');
    const bundle = await svc.loadSnapshot(row);
    expect(claudeAuthProvider(p).identityOf(bundle)).toMatchObject({ accountId: 'acc-A', orgId: 'org-A' });
  });

  it('refreshes the snapshot when the same identity is saved again', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r1');
    await svc.saveCurrent('codex', 'work');
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r2');
    const { row, created } = await svc.saveCurrent('codex', 'ignored-label');
    expect(created).toBe(false);
    expect(row.label).toBe('work');
    const auth = (await svc.loadSnapshot(row)).files[0]!;
    expect(JSON.parse(Buffer.from(auth.data!, 'base64').toString()).tokens.refresh_token).toBe('r2');
  });

  it('fails when the tool is not logged in', async () => {
    await expect(svc.saveCurrent('codex', 'x')).rejects.toThrow('로그인');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/account-service.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/services/account-service.ts`:
```ts
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deserializeBundle, serializeBundle, type AuthBundle, type ToolId } from '../core/auth-bundle.js';
import type { Identity } from '../core/identity.js';
import type { AccountRow, AppDb } from '../infra/app-db.js';
import type { PathProvider } from '../infra/path-provider.js';
import type { SecretStore } from '../infra/secret-store.js';
import type { ToolAuthProvider } from '../providers/types.js';

export interface AccountServiceDeps {
  db: AppDb;
  secrets: SecretStore;
  paths: PathProvider;
  providers: Record<ToolId, ToolAuthProvider>;
}

export function accountKey(id: Identity): string {
  return crypto.createHash('sha256').update(`${id.tool}:${id.accountId}:${id.orgId ?? ''}`).digest('hex').slice(0, 16);
}

export class AccountService {
  constructor(private readonly d: AccountServiceDeps) {}

  list(tool?: ToolId): AccountRow[] {
    return this.d.db.listAccounts(tool);
  }

  async saveCurrent(tool: ToolId, label: string): Promise<{ row: AccountRow; created: boolean }> {
    const provider = this.d.providers[tool];
    const bundle = await provider.readCurrentAuth();
    return this.storeSnapshot(provider.identityOf(bundle), label, bundle);
  }

  async storeSnapshot(id: Identity, label: string, bundle: AuthBundle): Promise<{ row: AccountRow; created: boolean }> {
    const file = path.join(this.d.paths.appDataDir, 'profiles', id.tool, `${accountKey(id)}.bin`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, await this.d.secrets.encrypt(serializeBundle(bundle)));
    return this.d.db.upsertAccount({
      tool: id.tool,
      accountId: id.accountId,
      orgId: id.orgId ?? '',
      email: id.email ?? null,
      displayName: id.displayName ?? null,
      label,
      snapshotPath: file,
      snapshotAt: new Date().toISOString(),
    });
  }

  async loadSnapshot(account: AccountRow): Promise<AuthBundle> {
    return deserializeBundle(await this.d.secrets.decrypt(await fs.readFile(account.snapshotPath)));
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/account-service.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/account-service.ts test/unit/account-service.test.ts
git commit -m "feat(services): add AccountService for snapshot registration"
```

---

### Task 11: SwitchService (전환 + 롤백)

**Files:**
- Create: `src/main/services/switch-service.ts`
- Test: `test/unit/switch-service.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/switch-service.test.ts`:
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { serializeBundle } from '../../src/main/core/auth-bundle.js';
import { AppDb } from '../../src/main/infra/app-db.js';
import { BackupStore } from '../../src/main/infra/backup-store.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { AccountService } from '../../src/main/services/account-service.js';
import { SwitchService, type SwitchPrompts } from '../../src/main/services/switch-service.js';
import { writeCodexAuth } from '../helpers/fake-auth.js';
import { FakeProcs } from '../helpers/fake-procs.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { readText, tmpPaths } from '../helpers/tmp-paths.js';

const CODEX_APP_PATH = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';

let p: PathProvider;
let db: AppDb;
let accounts: AccountService;
let procs: FakeProcs;
let prompts: { [K in keyof SwitchPrompts]: Mock<SwitchPrompts[K]> };
let svc: SwitchService;
const secrets = fakeSecretStore();

const authJson = () => readText(path.join(p.home, '.codex', 'auth.json'));
const currentAccountId = async () => JSON.parse(await authJson()).tokens.account_id as string;

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  const providers = { codex: codexAuthProvider(p), claude: claudeAuthProvider(p) };
  accounts = new AccountService({ db, secrets, paths: p, providers });
  procs = new FakeProcs();
  prompts = {
    confirmKill: vi.fn<SwitchPrompts['confirmKill']>(async () => true),
    confirmSaveUnknown: vi.fn<SwitchPrompts['confirmSaveUnknown']>(async () => null),
    warnStrayCli: vi.fn<SwitchPrompts['warnStrayCli']>(),
  };
  svc = new SwitchService({
    accounts, db, providers, procs, prompts,
    backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
    closeTimeoutMs: 0,
    sleep: async () => {},
  });
  // 계정 두 개 등록: work(A), personal(B). 현재 로그인 = B
  await writeCodexAuth(p, 'acct-A', 'a@x.com');
  await accounts.saveCurrent('codex', 'work');
  await writeCodexAuth(p, 'acct-B', 'b@x.com');
  await accounts.saveCurrent('codex', 'personal');
});

describe('SwitchService', () => {
  it('switches to the target account, then launches the app', async () => {
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(await currentAccountId()).toBe('acct-A');
    expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
    expect(db.listSwitches('codex').map((e) => e.result)).toEqual(['ok']);
  });

  it('refreshes the outgoing account snapshot first (token rotation)', async () => {
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'rotated');
    await svc.switchTo('codex', 'work');
    await svc.switchTo('codex', 'personal');
    expect(JSON.parse(await authJson()).tokens.refresh_token).toBe('rotated');
  });

  it('closes a running app before touching files', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(procs.running).toHaveLength(0);
    expect(procs.killed).toEqual([]);
  });

  it('aborts without changes when the app does not close and the user declines kill', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    prompts.confirmKill.mockResolvedValue(false);
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted' });
    expect(await currentAccountId()).toBe('acct-B');
    expect(procs.launched).toEqual([]);
  });

  it('kills the app when it does not close and the user agrees', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(procs.killed).toEqual([10]);
  });

  it('warns about standalone CLI processes but continues', async () => {
    procs.running = [{ pid: 20, name: 'codex', path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.exe' }];
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(prompts.warnStrayCli).toHaveBeenCalledOnce();
  });

  it('rolls back when the restored identity does not match the target', async () => {
    const work = db.findAccountByLabel('codex', 'work')!;
    const personal = db.findAccountByLabel('codex', 'personal')!;
    // work 스냅샷을 B 의 번들로 오염시킨다
    const bBundle = await accounts.loadSnapshot(personal);
    await fs.writeFile(work.snapshotPath, await secrets.encrypt(serializeBundle(bBundle)));
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'current');
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'rolled_back' });
    expect(JSON.parse(await authJson()).tokens.refresh_token).toBe('current');
    expect(procs.launched).toEqual([]);
    expect(db.listSwitches('codex').map((e) => e.result)).toEqual(['rolled_back']);
  });

  it('marks the account as needs_relogin when its snapshot cannot be decrypted', async () => {
    const work = db.findAccountByLabel('codex', 'work')!;
    await fs.writeFile(work.snapshotPath, Buffer.from('corrupted'));
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted' });
    expect(db.findAccountByLabel('codex', 'work')!.status).toBe('needs_relogin');
    expect(await currentAccountId()).toBe('acct-B');
  });

  it('offers to save an unregistered current account before switching away', async () => {
    await writeCodexAuth(p, 'acct-C', 'c@x.com');
    prompts.confirmSaveUnknown.mockResolvedValue('third');
    await svc.switchTo('codex', 'work');
    expect(db.findAccountByLabel('codex', 'third')?.accountId).toBe('acct-C');
  });

  it('throws for an unknown label', async () => {
    await expect(svc.switchTo('codex', 'nope')).rejects.toThrow("'nope'");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/switch-service.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`src/main/services/switch-service.ts`:
```ts
import type { AuthBundle, ToolId } from '../core/auth-bundle.js';
import { sameIdentity, type Identity } from '../core/identity.js';
import type { AccountRow, AppDb } from '../infra/app-db.js';
import type { BackupStore } from '../infra/backup-store.js';
import type { ProcessController, ProcInfo } from '../infra/process-controller.js';
import type { AppInfo, ToolAuthProvider } from '../providers/types.js';
import type { AccountService } from './account-service.js';
import { classifyProcesses } from './app-processes.js';

export interface SwitchPrompts {
  confirmKill(procs: ProcInfo[]): Promise<boolean>;
  confirmSaveUnknown(identity: Identity): Promise<string | null>; // 저장할 라벨, null = 저장 안 함
  warnStrayCli(procs: ProcInfo[]): void;
}

export interface SwitchServiceDeps {
  accounts: AccountService;
  db: AppDb;
  backups: BackupStore;
  procs: ProcessController;
  providers: Record<ToolId, ToolAuthProvider>;
  prompts: SwitchPrompts;
  closeTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type SwitchResult =
  | { status: 'switched'; account: AccountRow }
  | { status: 'aborted'; reason: string }
  | { status: 'rolled_back'; reason: string; backupPath: string };

const toIdentity = (a: AccountRow): Identity => ({ tool: a.tool, accountId: a.accountId, orgId: a.orgId });

export class SwitchService {
  private readonly closeTimeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: SwitchServiceDeps) {
    this.closeTimeoutMs = d.closeTimeoutMs ?? 10_000;
    this.pollMs = d.pollMs ?? 500;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async switchTo(tool: ToolId, label: string): Promise<SwitchResult> {
    const target = this.d.db.findAccountByLabel(tool, label);
    if (!target) throw new Error(`no ${tool} account labelled '${label}'`);
    const provider = this.d.providers[tool];

    // 0. 대상 스냅샷을 먼저 복호화 — 실패하면 아무것도 건드리지 않는다
    let targetBundle: AuthBundle;
    try {
      targetBundle = await this.d.accounts.loadSnapshot(target);
    } catch (e) {
      this.d.db.setAccountStatus(target.id, 'needs_relogin');
      return { status: 'aborted', reason: `'${label}' 스냅샷을 복호화할 수 없음 — 재등록 필요 (${(e as Error).message})` };
    }

    // 1. 앱 종료
    const stopped = await this.stopApp(provider.app);
    if (!stopped.ok) return { status: 'aborted', reason: stopped.reason };

    // 2. 현재 계정 스냅샷 갱신 (토큰 rotation 대응)
    const current = await provider.readCurrentAuth();
    await this.refreshOutgoing(provider, current);

    // 3. 백업
    const backupPath = await this.d.backups.save(current);

    // 4. 교체 + 검증, 실패 시 롤백
    try {
      await provider.writeAuth(targetBundle);
      const after = provider.identityOf(await provider.readCurrentAuth());
      if (!sameIdentity(after, toIdentity(target))) {
        throw new Error(`복원 후 신원 불일치 (expected ${target.accountId}, got ${after.accountId})`);
      }
    } catch (e) {
      await provider.writeAuth(current);
      this.d.db.recordSwitch(tool, null, 'rolled_back');
      return { status: 'rolled_back', reason: (e as Error).message, backupPath };
    }

    // 5. 앱 실행
    await this.d.procs.launch(provider.app.aumid);
    this.d.db.recordSwitch(tool, target.id, 'ok');
    return { status: 'switched', account: target };
  }

  private async stopApp(app: AppInfo): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { appProcs, strayCli } = classifyProcesses(await this.d.procs.list(), app);
    if (strayCli.length > 0) this.d.prompts.warnStrayCli(strayCli);
    if (appProcs.length === 0) return { ok: true };

    await this.d.procs.closeGracefully(appProcs.map((p) => p.pid));
    let remaining = await this.waitForExit(app);
    if (remaining.length === 0) return { ok: true };

    if (!(await this.d.prompts.confirmKill(remaining))) return { ok: false, reason: '앱이 종료되지 않았고 강제 종료를 취소함' };
    await this.d.procs.kill(remaining.map((p) => p.pid));
    remaining = await this.waitForExit(app);
    return remaining.length === 0 ? { ok: true } : { ok: false, reason: '앱 프로세스를 종료할 수 없음' };
  }

  private async waitForExit(app: AppInfo): Promise<ProcInfo[]> {
    const deadline = Date.now() + this.closeTimeoutMs;
    for (;;) {
      const { appProcs } = classifyProcesses(await this.d.procs.list(), app);
      if (appProcs.length === 0 || Date.now() >= deadline) return appProcs;
      await this.sleep(this.pollMs);
    }
  }

  private async refreshOutgoing(provider: ToolAuthProvider, current: AuthBundle): Promise<void> {
    let id: Identity;
    try {
      id = provider.identityOf(current);
    } catch {
      return; // 로그인 안 된 상태 — 저장할 것 없음
    }
    const known = this.d.db.findAccountByIdentity(id.tool, id.accountId, id.orgId ?? '');
    if (known) {
      await this.d.accounts.storeSnapshot(id, known.label, current);
      return;
    }
    const label = await this.d.prompts.confirmSaveUnknown(id);
    if (label) await this.d.accounts.storeSnapshot(id, label, current);
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/switch-service.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: 전체 테스트 + 타입체크**

Run: `npx vitest run`
Expected: 모든 테스트 PASS

Run: `npx tsc --noEmit`
Expected: 출력 없음

- [ ] **Step 6: Commit**

```bash
git add src/main/services/switch-service.ts test/unit/switch-service.test.ts
git commit -m "feat(services): add SwitchService with backup, verification and rollback"
```

---

### Task 12: 개발용 CLI

**Files:**
- Create: `src/cli/index.ts`

- [ ] **Step 1: 구현**

`src/cli/index.ts`:
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { ToolId } from '../main/core/auth-bundle.js';
import { AppDb } from '../main/infra/app-db.js';
import { BackupStore } from '../main/infra/backup-store.js';
import { systemPaths } from '../main/infra/path-provider.js';
import { windowsProcessController } from '../main/infra/process-controller.js';
import { dpapiSecretStore } from '../main/infra/secret-store.js';
import { claudeAuthProvider } from '../main/providers/claude/auth.js';
import { codexAuthProvider } from '../main/providers/codex/auth.js';
import { AccountService } from '../main/services/account-service.js';
import { SwitchService } from '../main/services/switch-service.js';

const USAGE = `사용법:
  npm run cli -- list
  npm run cli -- current <codex|claude>
  npm run cli -- save <codex|claude> <라벨>
  npm run cli -- switch <codex|claude> <라벨>
옵션:
  --with-app-profile   Electron 프로필(쿠키/Local Storage)까지 스냅샷·교체 (검증 V2/V3 용)`;

function parseTool(v: string | undefined): ToolId {
  if (v === 'codex' || v === 'claude') return v;
  throw new Error(`도구는 codex 또는 claude\n\n${USAGE}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const withAppProfile = process.argv.includes('--with-app-profile');
  const [cmd, toolArg, label] = args;

  const paths = systemPaths();
  await fs.mkdir(paths.appDataDir, { recursive: true });
  const db = new AppDb(path.join(paths.appDataDir, 'app.db'));
  const secrets = dpapiSecretStore();
  const providers = {
    codex: codexAuthProvider(paths, { withAppProfile }),
    claude: claudeAuthProvider(paths, { withAppProfile }),
  };
  const accounts = new AccountService({ db, secrets, paths, providers });

  try {
    switch (cmd) {
      case 'list': {
        for (const a of accounts.list()) {
          console.log([a.tool, a.label, a.email ?? '-', a.status, a.snapshotAt].join('\t'));
        }
        return;
      }
      case 'current': {
        const tool = parseTool(toolArg);
        const id = providers[tool].identityOf(await providers[tool].readCurrentAuth());
        const known = db.findAccountByIdentity(tool, id.accountId, id.orgId ?? '');
        console.log(`${id.email ?? id.accountId} ${known ? `(등록됨: ${known.label})` : '(미등록)'}`);
        return;
      }
      case 'save': {
        const tool = parseTool(toolArg);
        if (!label) throw new Error(USAGE);
        const { row, created } = await accounts.saveCurrent(tool, label);
        console.log(created ? `저장: ${row.label} (${row.email ?? row.accountId})` : `갱신: 기존 '${row.label}' 스냅샷`);
        return;
      }
      case 'switch': {
        const tool = parseTool(toolArg);
        if (!label) throw new Error(USAGE);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const svc = new SwitchService({
            accounts,
            db,
            providers,
            procs: windowsProcessController(),
            backups: new BackupStore(path.join(paths.appDataDir, 'backups'), secrets),
            prompts: {
              async confirmKill(procs) {
                const a = await rl.question(`앱이 종료되지 않았습니다 (${procs.length}개 프로세스). 강제 종료할까요? [y/N] `);
                return a.trim().toLowerCase() === 'y';
              },
              async confirmSaveUnknown(id) {
                const a = await rl.question(`현재 로그인(${id.email ?? id.accountId})은 미등록입니다. 저장할 라벨(엔터=저장 안 함): `);
                return a.trim() || null;
              },
              warnStrayCli(procs) {
                console.warn(`경고: 독립 실행 CLI 가 실행 중입니다 — ${procs.map((p) => `${p.name}(${p.pid})`).join(', ')}. 전환 후 재시작하세요.`);
              },
            },
          });
          const r = await svc.switchTo(tool, label);
          if (r.status === 'switched') console.log(`전환 완료: ${r.account.label} (${r.account.email ?? r.account.accountId})`);
          else if (r.status === 'aborted') console.log(`취소: ${r.reason}`);
          else console.log(`롤백됨: ${r.reason}\n백업: ${r.backupPath}`);
        } finally {
          rl.close();
        }
        return;
      }
      default:
        console.log(USAGE);
    }
  } finally {
    db.close();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
```

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 출력 없음

- [ ] **Step 3: 읽기 전용 명령 동작 확인 (실제 PC)**

Run: `npm run cli -- list`
Expected: 출력 없음(등록된 계정 없음), 종료 코드 0. `%APPDATA%\ai-account-bridge\app.db` 생성됨.

Run: `npm run cli -- current codex`
Expected: `<현재 GPT 이메일> (미등록)`

Run: `npm run cli -- current claude`
Expected: `<현재 Claude 이메일> (미등록)`

- [ ] **Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): add dev CLI for list/current/save/switch"
```

---

### Task 13: Phase 0 검증 런북(V1~V4) + 설계 문서 동기화

**Files:**
- Create: `docs/verification/phase0-auth.md`
- Modify: `docs/superpowers/specs/2026-09-23-ai-account-bridge-design.md` (D9 행, §6 V1~V4 결과 열)
- Modify: `docs/architecture.md` (§4 `accounts.org_id`, §7 전환 시퀀스 순서)

- [ ] **Step 1: 런북 작성**

`docs/verification/phase0-auth.md`:
````markdown
# Phase 0 — 인증 전환 검증 (V1~V4)

## 준비
- GPT 계정 2개(A, B), Claude 계정 2개(A, B) — 본인 소유
- **Claude 전환은 Claude Desktop 안의 세션에서 실행하지 말 것.** 전환 시 Claude Desktop 과 그 안의 Claude Code 세션이 모두 종료된다. 별도 Windows Terminal/PowerShell 창에서 `npm run cli -- ...` 로 실행한다.
- 각 단계 전후로 `npm run cli -- current <tool>` 결과를 기록한다.

## V1 — Codex: auth.json 만 교체
1. ChatGPT 앱에서 A 로그인 → `npm run cli -- save codex A`
2. 앱에서 로그아웃 → B 로그인 → `npm run cli -- save codex B`
3. `npm run cli -- switch codex A`
4. 앱이 자동 실행되면 **Codex(코드) 화면**에서 계정/설정의 이메일 확인, 간단한 작업 1회 실행
- 통과: 코드 쪽이 A 로 동작

## V2 — ChatGPT 채팅 쪽 로그인 출처
1. V1 직후 상태에서 **채팅 화면**의 계정 이메일 확인
2. A 면 → 채팅도 auth.json 을 따름 (최소 세트 = auth.json)
3. B 면 → 채팅은 Electron 프로필을 따름. 앱 종료 후 `--with-app-profile` 로 A/B 를 다시 `save` 하고 `switch` 재시도, 채팅 이메일 확인
- 기록: 채팅/코드 각각 어떤 파일을 따르는지 → 분리 전환(v1.1) 가능 여부

## V3 — Claude: .credentials.json + oauthAccount 교체
1. Claude 앱에서 A 로그인 → (별도 터미널) `npm run cli -- save claude A`
2. 로그아웃 → B 로그인 → `npm run cli -- save claude B`
3. `npm run cli -- switch claude A`
4. Desktop 채팅 화면 계정, Code 탭 계정, `claude` CLI 의 `/status` 계정 확인
- B 로 남는 화면이 있으면 → `--with-app-profile` 로 재등록·재시도 후 기록

## V4 — 토큰 rotation
1. A 로 전환 후 30분 이상 실제 사용 (토큰 갱신 유도)
2. B 로 전환 → 다시 A 로 전환
3. A 가 로그인 상태로 열리는지 확인 (Codex, Claude 각각)
- 통과: 재로그인 없이 사용 가능

## 결과
| ID | 도구 | 결과 (통과/실패) | 최소 교체 세트 | 메모 |
|---|---|---|---|---|
| V1 | Codex | | | |
| V2 | ChatGPT 채팅 | | | |
| V3 | Claude | | | |
| V4 | 둘 다 | | | |
````

- [ ] **Step 2: 설계 문서 D9 행 수정**

`docs/superpowers/specs/2026-09-23-ai-account-bridge-design.md` 의 D9 행을 아래로 교체:
```markdown
| D9 | 인증 스냅샷은 **DPAPI(CurrentUser)로 암호화 저장**, 값은 UI/로그에 절대 출력 안 함. Plan 1(CLI)은 PowerShell `ProtectedData`, Plan 4(Electron)는 `safeStorage` — 둘 다 `SecretStore` 인터페이스 뒤 | `auth.json`, `.credentials.json` 은 평문 토큰 | 평문 복사 |
```

- [ ] **Step 3: 아키텍처 문서 동기화**

`docs/architecture.md` §4 의 `accounts` DDL 에서
```sql
  org_id        TEXT,
```
를
```sql
  org_id        TEXT NOT NULL DEFAULT '',   -- NULL 이면 UNIQUE 가 동작하지 않으므로 '' 사용
  display_name  TEXT,
```
로 바꾸고, `UNIQUE (tool, account_id, org_id)` 아래에 `UNIQUE (tool, label)` 을 추가한다.

§7 전환 시퀀스에서
```
  SS->>P: writeAuth(B)
  SS->>PC: launch(aumid)
  SS->>P: identityOf(readCurrentAuth()) == B ?
```
를
```
  SS->>P: writeAuth(B)
  SS->>P: identityOf(readCurrentAuth()) == B ?
```
로 바꾸고, `else 성공` 분기의 첫 줄로 `SS->>PC: launch(aumid)` 를 추가한다. 또한 `SS->>SEC: accountB 스냅샷 복호화` 줄을 `SS->>PC: findRunning…` 줄 **앞**으로 옮긴다(복호화 실패 시 앱을 건드리지 않음).

- [ ] **Step 4: Commit**

```bash
git add docs/verification/phase0-auth.md docs/superpowers/specs/2026-09-23-ai-account-bridge-design.md docs/architecture.md
git commit -m "docs: add Phase 0 auth verification runbook and sync design with Plan 1"
```

- [ ] **Step 5: 사용자와 V1~V4 실행**

런북을 사용자와 함께 수행한다. 계정 로그인/로그아웃은 사용자가 직접 한다. 결과 표를 채우고, V2/V3 결과에 따라 `AuthProviderOptions.withAppProfile` 의 기본값을 결정해 기록한다.

```bash
git add docs/verification/phase0-auth.md
git commit -m "docs: record Phase 0 V1-V4 results"
```

---

## 구현 중 변경 사항 (2026-09-23)

Task 1~12 를 구현하는 과정에서 각 태스크 본문(설계 당시 계획)과 달라진 부분을 요약한다. 위 태스크 본문은 과거 기록으로 그대로 두고, 실제 최종 동작은 [설계 문서](../specs/2026-09-23-ai-account-bridge-design.md) D11~D13, [아키텍처 §7](../../architecture.md#7-전환-시퀀스), [검증 런북](../../verification/phase0-auth.md) 을 따른다.

- **전환 순서 확정**: 대상 스냅샷 복호화(실패 시 아무것도 안 건드리고 `needs_relogin`) → 독립 실행 CLI 확인 → 앱 종료 → 준비 단계(현재 인증 읽기 + 범위 검사, 스냅샷 갱신/미등록 저장 확인, 이미 대상 계정이면 쓰기 생략, 백업) → 인증 교체 + 검증 → 실패 시 롤백(재실행 여부는 전환 전 앱 실행 상태 기준) → 성공 시 기록 후 앱 실행.
- **`SwitchPrompts`**: `confirmKill`, `confirmSaveUnknown` 에 더해 `confirmStrayCli` (기본값 거부 시 앱을 건드리기 전에 취소)를 추가. 계획 초안의 `warnStrayCli`(경고만 하고 진행)보다 강화된 확인 방식.
- **스냅샷 범위 검사**: `auth-fs.ts` 의 `bundleScope()` 로 교체 대상 경로/키 집합의 지문을 비교. `save` 와 `switch` 에 준 `--with-app-profile` 이 다르면 아무것도 쓰지 않고 전환을 취소한다.
- **인프라 강화**: `AccountService.storeSnapshot` 원자적 쓰기(tmp+rename) + 새 신원 저장 전 라벨 충돌 검사, `BackupStore` 는 방금 쓴 백업 파일을 정리 대상에서 제외, `classifyProcesses` 는 앱 관리 디렉터리를 경로 구분자 경계로 매칭, PID 유효성 검사, `runPowerShell` 30초 타임아웃, `AppDb` 마이그레이션을 트랜잭션으로 실행, `auth-fs` 는 `*.aab-tmp` 임시 파일을 무시/정리.

Task 12 커밋 이후, Phase 0 재검토(reviewer) 과정에서 다음이 추가로 바뀌었다:

- **`saveCurrent` 라벨 충돌 거부**: 현재 로그인 신원이 **다른 라벨로 이미 등록**돼 있으면 아무것도 쓰지 않고 거부한다 (§4.1, D14 급 결정이지만 데이터/DB 스키마 변경은 없어 결정 로그에는 별도 항목을 추가하지 않음). 앱의 계정 변경이 인증 파일에 아직 반영되지 않은 상태에서 새 라벨로 잘못 이중 등록되는 사고를 막는다.
- **`.prev.bin`**: `AccountService.storeSnapshot` 이 갱신 시 기존 `.bin` 을 `.prev.bin` 으로 한 세대만 보관(임시 파일을 쓰고 rename 하기 전에 복사). 두 번 연속 갱신하면 이전 상태는 사라진다.
- **`restore` 명령 추가**: `SwitchService.restoreBackup(tool, file)` + CLI `restore <tool> <backup.bin 경로>`. 백업(`backups/`)뿐 아니라 계정 스냅샷(`profiles/**/*.bin`, `*.prev.bin`)도 같은 포맷이라 그대로 복원 가능. 진행 중 가드, 앱을 닫기 전 범위(스코프) 확인, 독립 CLI/강제 종료 확인, 복원 직전 상태의 안전 백업(경로를 결과로 반환, 복원 대상 백업 파일은 정리 대상에서 제외), `writeAuth`, 원래 실행 중이었으면 재실행, 닫힌 뒤 오류가 나면 취소 + 재실행 + 안전 백업 경로 안내. `switch` 와 달리 신원 검증을 하지 않고 `switch_events` 에도 기록하지 않는다(백업이 로그아웃 상태일 수 있음).
- **롤백 실패 오류에 복구 명령 포함**: `SwitchService` 의 롤백 자체 실패 오류 메시지에 `npm run cli -- restore <tool> "<백업 경로>"` 를 그대로 포함(전환에 `--with-app-profile` 을 썼으면 그 옵션도 붙여서).
- **Claude 계정 정보 불일치는 "로그인 안 됨"과 다르게 처리**: `identityOf` 는 로그인 안 됨일 때만 `NotLoggedInError` 를 던지고, `~/.claude.json` 과 Desktop `config.json` 의 계정이 어긋나면 일반 `Error`("계정 정보 불일치")를 던진다. `SwitchService` 는 `NotLoggedInError` 만 "로그인 안 됨"으로 삼키고, 그 외 신원 오류는 다시 던져 전환을 취소한다(앱이 실행 중이었으면 재실행) — 처음에는 두 경우를 구분하지 않아 불일치 상태에서도 조용히 덮어쓰는 결함이 있었다.
- **Claude 기본 범위 확장**: 기본(스코프 없이) 저장/전환 대상에 `%APPDATA%\Claude\config.json` 의 `oauth:tokenCache`, `oauth:tokenCacheV2`, `lastKnownAccountUuid` 세 키가 추가됨. `--with-app-profile` 은 여기에 `Network`/`Local State`/`Local Storage` 를 더한다.
- **Codex 웹 프로필 경로 수정**: `--with-app-profile` 의 실제 프로필 경로가 `LocalCache\Roaming\Codex\` 바로 아래가 아니라 `LocalCache\Roaming\Codex\web\Codex\` 아래(`Local State`, `Default\Network`, `Default\Local Storage`)임을 확인하고 수정. 루트 바로 아래 경로는 4월 이후 갱신되지 않는 죽은 경로였다.
- **`applyAuth` 불필요한 파일 생성 방지**: JSON 키를 지우는 스냅샷을 적용할 때, 대상 파일 자체가 없고 지울 키도 없으면 파일을 새로 만들지 않는다.
- **CLI/UX**: 강제 종료를 거부했을 때의 안내 메시지에 "앱이 트레이에 숨어 있을 수 있다"는 문구 추가, `list` 출력 마지막 칸에 스냅샷 파일 경로 추가.
- **알려진 제한 추가**: 프로세스 간 잠금 없음(같은 프로세스 안에서만 진행 중 가드 유효), `list` 가 스냅샷 범위(`--with-app-profile` 여부)는 보여주지 않음, npm 설치 `claude`/`codex` 는 `node.exe` 로 실행돼 독립 CLI 감지에 안 걸림, `--with-app-profile` 전환마다 대용량 DPAPI 호출이 여러 번이라 느림(30초 타임아웃으로 안전하게 중단), `restore` 는 outgoing 스냅샷을 갱신하지 않음, `.prev.bin` 은 한 세대만 보관. 자세한 내용은 [설계 문서 §9](../specs/2026-09-23-ai-account-bridge-design.md) 와 [검증 런북](../../verification/phase0-auth.md) 참고.
- **알려진 제한 (다음 계획에서 다룸)**: 스냅샷 로드의 일시적 오류도 `needs_relogin` 으로 표시됨(손상과 구분 안 됨), CLI 확인 프롬프트 진행 중 Ctrl+C·비TTY 입력 미처리, Claude 쪽 손상된 JSON 오류는 원본 `SyntaxError` 그대로 노출(Codex 는 별도 메시지로 처리됨).