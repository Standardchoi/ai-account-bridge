import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deserializeBundle, serializeBundle, type AuthBundle, type ToolId } from '../core/auth-bundle.js';
import type { Identity } from '../core/identity.js';
import type { AccountRow, AccountScope, AppDb } from '../infra/app-db.js';
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

function validateLabel(label: string): void {
  if (!label || label.length > 64) throw new Error('label 은 1~64자 문자열이어야 합니다');
}

// 스냅샷 파일이 없음(ENOENT) — 재등록이 필요하다.
export class SnapshotMissingError extends Error {}
// 스냅샷을 복호화/해석할 수 없음 — 재등록이 필요하다. (IO·PowerShell 실행 문제와는 구별된다.)
export class SnapshotDecryptError extends Error {}

// 복호화 자체가 아니라 PowerShell 을 실행하지 못한 경우(시간 초과, 실행 파일 없음/권한)는 스냅샷 손상이 아니다.
function isInfraError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException;
  return err.message?.startsWith('powershell timed out') === true || err.syscall?.startsWith('spawn') === true;
}

const prevSnapshotPath = (snapshotPath: string): string => `${snapshotPath.slice(0, -'.bin'.length)}.prev.bin`;

// 번들이 home 밖(Electron 프로필: claudeDesktop/localAppData 아래 폴더·파일)을 다루면 앱 프로필 포함 스냅샷이다.
// (Claude Desktop 의 config.json 키는 항상 들어가지만 jsonKeys 라서 files/replaceDirs 로는 잡히지 않는다.)
export function snapshotScopeOf(bundle: AuthBundle): AccountScope {
  const outsideHome = bundle.files.some((f) => f.root !== 'home') || bundle.replaceDirs.some((d) => d.root !== 'home');
  return outsideHome ? 'auth+app-profile' : 'auth';
}

export class AccountService {
  constructor(private readonly d: AccountServiceDeps) {}

  list(tool?: ToolId): AccountRow[] {
    return this.d.db.listAccounts(tool);
  }

  async saveCurrent(tool: ToolId, label: string): Promise<{ row: AccountRow; created: boolean }> {
    const provider = this.d.providers[tool];
    const bundle = await provider.readCurrentAuth();
    const id = provider.identityOf(bundle);
    const existing = this.d.db.findAccountByIdentity(id.tool, id.accountId, id.orgId ?? '');
    if (existing && existing.label !== label) {
      throw new Error(
        `현재 로그인(${id.email ?? id.accountId})은 이미 '${existing.label}' 로 등록되어 있습니다 — 앱의 계정 변경이 아직 인증 파일에 반영되지 않았을 수 있습니다. 아무것도 저장하지 않았습니다.`,
      );
    }
    const result = await this.storeSnapshot(id, label, bundle);
    this.d.db.recordSwitch(tool, result.row.id, 'saved');
    return result;
  }

  async storeSnapshot(id: Identity, label: string, bundle: AuthBundle): Promise<{ row: AccountRow; created: boolean }> {
    const orgId = id.orgId ?? '';
    if (!this.d.db.findAccountByIdentity(id.tool, id.accountId, orgId) && this.d.db.findAccountByLabel(id.tool, label)) {
      throw new Error(`label '${label}' is already used by another ${id.tool} account`);
    }
    const file = path.join(this.d.paths.appDataDir, 'profiles', id.tool, `${accountKey(id)}.bin`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, await this.d.secrets.encrypt(serializeBundle(bundle)));
      const prevFile = `${file.slice(0, -'.bin'.length)}.prev.bin`;
      await fs.copyFile(file, prevFile).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      });
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    return this.d.db.upsertAccount({
      tool: id.tool,
      accountId: id.accountId,
      orgId: id.orgId ?? '',
      email: id.email ?? null,
      displayName: id.displayName ?? null,
      label,
      snapshotPath: file,
      snapshotAt: new Date().toISOString(),
      scope: snapshotScopeOf(bundle),
    });
  }

  async loadSnapshot(account: AccountRow): Promise<AuthBundle> {
    let cipher: Buffer;
    try {
      cipher = await fs.readFile(account.snapshotPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new SnapshotMissingError('스냅샷 파일 없음');
      throw e;
    }
    try {
      return deserializeBundle(await this.d.secrets.decrypt(cipher));
    } catch (e) {
      if (isInfraError(e)) throw e;
      throw new SnapshotDecryptError((e as Error).message);
    }
  }

  async rename(tool: ToolId, label: string, newLabel: string): Promise<AccountRow> {
    validateLabel(newLabel);
    const row = this.d.db.findAccountByLabel(tool, label);
    if (!row) throw new Error(`no ${tool} account labelled '${label}'`);
    return this.d.db.renameAccount(row.id, newLabel);
  }

  // DB 등록만 지운다 — 도구의 실제 로그인 상태(라이브 인증 파일)는 절대 건드리지 않는다.
  async remove(tool: ToolId, label: string): Promise<void> {
    const row = this.d.db.findAccountByLabel(tool, label);
    if (!row) throw new Error(`no ${tool} account labelled '${label}'`);
    this.d.db.deleteAccount(row.id);
    await fs.rm(row.snapshotPath, { force: true }).catch(() => {});
    await fs.rm(prevSnapshotPath(row.snapshotPath), { force: true }).catch(() => {});
  }
}
