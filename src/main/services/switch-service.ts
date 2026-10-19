import type { AuthBundle, ToolId } from '../core/auth-bundle.js';
import { NotLoggedInError, sameIdentity, type Identity } from '../core/identity.js';
import type { AccountRow, AppDb } from '../infra/app-db.js';
import { bundleScope, clearedBundle } from '../infra/auth-fs.js';
import type { BackupStore } from '../infra/backup-store.js';
import type { ProcessController, ProcInfo } from '../infra/process-controller.js';
import type { AppInfo, ToolAuthProvider } from '../providers/types.js';
import { SnapshotDecryptError, SnapshotMissingError, type AccountService } from './account-service.js';
import { classifyProcesses } from './app-processes.js';

export interface SwitchPrompts {
  confirmKill(procs: ProcInfo[]): Promise<boolean>;
  confirmSaveUnknown(identity: Identity): Promise<string | null>; // 저장할 라벨, null = 저장 안 함
  confirmStrayCli(procs: ProcInfo[]): Promise<boolean>; // 계속 진행할지 여부
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
  restoreHintFlags?: string; // 롤백 실패 시 안내하는 복구 명령에 덧붙일 옵션 (예: '--with-app-profile')
  launchTimeoutMs?: number; // 앱 실행 후 프로세스가 뜰 때까지 기다리는 최대 시간
  autoKill?: boolean; // true 면 정상 종료 대기(closeTimeoutMs) 후 confirmKill 없이 바로 강제 종료한다 (기본값: false)
  onProgress?: (step: string) => void; // 진행 단계를 사람이 읽을 수 있는 한글 문자열로 알려준다
}

export type SwitchResult =
  | { status: 'switched'; account: AccountRow; launchWarning?: string; notice?: string }
  | { status: 'aborted'; reason: string; launchWarning?: string }
  | { status: 'rolled_back'; reason: string; backupPath: string; launchWarning?: string };

export type RestoreResult =
  | { status: 'restored'; backupPath: string; launchWarning?: string }
  | { status: 'aborted'; reason: string; launchWarning?: string };

export type PrepareNewLoginResult =
  | { status: 'ready'; backupPath: string; launchWarning?: string; notice?: string }
  | { status: 'aborted'; reason: string; launchWarning?: string };

const LAUNCH_FAILURE_WARNING =
  '앱이 시작되지 않았습니다 — 앱 업데이트 대기(관리자 권한 필요) 등으로 실행이 막혔을 수 있습니다. 앱을 직접 실행해 보고, Windows 이벤트 뷰어의 AppXDeploymentServer 로그를 확인하세요. (인증 파일 전환은 완료됨)';

const SKIPPED_REFRESH_NOTICE = '현재 로그인 정보를 읽을 수 없어 이전 계정 스냅샷을 갱신하지 않았습니다';

const toIdentity = (a: AccountRow): Identity => ({ tool: a.tool, accountId: a.accountId, orgId: a.orgId });

const scopeMismatchError = (label: string): Error =>
  new Error(
    `'${label}' 스냅샷의 범위(앱 프로필 포함 여부)가 현재 실행 옵션과 다릅니다 — 등록할 때와 같은 --with-app-profile 옵션으로 실행하세요`,
  );
const sameScope = (a: AuthBundle, b: AuthBundle): boolean => JSON.stringify(bundleScope(a)) === JSON.stringify(bundleScope(b));

export class SwitchService {
  private readonly closeTimeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly launchTimeoutMs: number;
  private readonly autoKill: boolean;
  private inFlight = false;

  constructor(private readonly d: SwitchServiceDeps) {
    this.closeTimeoutMs = d.closeTimeoutMs ?? 10_000;
    this.pollMs = d.pollMs ?? 500;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.launchTimeoutMs = d.launchTimeoutMs ?? 20_000;
    this.autoKill = d.autoKill ?? false;
  }

  async switchTo(tool: ToolId, label: string): Promise<SwitchResult> {
    if (this.inFlight) return { status: 'aborted', reason: '다른 전환이 진행 중입니다' };
    this.inFlight = true;
    try {
      const target = this.d.db.findAccountByLabel(tool, label);
      if (!target) throw new Error(`no ${tool} account labelled '${label}'`);
      const provider = this.d.providers[tool];

      // 0. 대상 스냅샷을 먼저 복호화 — 실패하면 아무것도 건드리지 않는다
      this.progress('스냅샷 확인');
      let targetBundle: AuthBundle;
      try {
        targetBundle = await this.d.accounts.loadSnapshot(target);
      } catch (e) {
        if (e instanceof SnapshotMissingError) {
          this.d.db.setAccountStatus(target.id, 'needs_relogin');
          return { status: 'aborted', reason: `'${label}' 스냅샷 파일 없음 — 재등록 필요` };
        }
        if (e instanceof SnapshotDecryptError) {
          this.d.db.setAccountStatus(target.id, 'needs_relogin');
          return { status: 'aborted', reason: `'${label}' 스냅샷을 복호화할 수 없음 — 재등록 필요 (${e.message})` };
        }
        // 그 밖의 IO/PowerShell 오류는 스냅샷 상태를 알 수 없으므로 상태를 바꾸지 않는다.
        return { status: 'aborted', reason: `'${label}' 스냅샷을 읽는 중 오류 — 계정 상태는 바꾸지 않았습니다 (${(e as Error).message})` };
      }

      // 1. 앱 종료 (독립 CLI 확인 포함)
      const stopped = await this.stopApp(provider.app);
      if (!stopped.ok) return { status: 'aborted', reason: stopped.reason };
      const wasRunning = stopped.wasRunning;

      // 2. 현재 계정 스냅샷 갱신 (토큰 rotation 대응) + 이미 대상 계정이 활성 상태면 쓰기 생략
      let current: AuthBundle;
      let backupPath!: string;
      let sameAccountTarget: AccountRow | undefined;
      let notice: string | undefined;
      try {
        current = await provider.readCurrentAuth();
        if (!sameScope(current, targetBundle)) throw scopeMismatchError(target.label);
        this.progress('현재 계정 저장');
        if (!(await this.refreshOutgoing(provider, current))) notice = SKIPPED_REFRESH_NOTICE;

        let currentIdentity: Identity | undefined;
        try {
          currentIdentity = provider.identityOf(current);
        } catch (e) {
          if (!(e instanceof NotLoggedInError)) throw e;
          currentIdentity = undefined;
        }
        if (currentIdentity && sameIdentity(currentIdentity, toIdentity(target))) {
          sameAccountTarget = target;
        } else {
          // 3. 백업
          this.progress('백업');
          backupPath = await this.d.backups.save(current);
        }
      } catch (e) {
        const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
        return { status: 'aborted', reason: `전환 준비 중 오류: ${(e as Error).message}`, launchWarning };
      }

      if (sameAccountTarget) {
        this.d.db.recordSwitch(tool, sameAccountTarget.id, 'ok');
        const launchWarning = await this.launchAndVerify(provider.app);
        return { status: 'switched', account: sameAccountTarget, launchWarning };
      }

      // 4. 교체 + 검증, 실패 시 롤백
      try {
        this.progress('로그인 정보 교체');
        await provider.writeAuth(targetBundle);
        this.progress('계정 확인');
        const after = provider.identityOf(await provider.readCurrentAuth());
        if (!sameIdentity(after, toIdentity(target))) {
          throw new Error(`복원 후 신원 불일치 (expected ${target.accountId}, got ${after.accountId})`);
        }
      } catch (e) {
        const originalErr = e as Error;
        try {
          await provider.writeAuth(current);
        } catch (rollbackErr) {
          const hintFlags = this.d.restoreHintFlags ? ` ${this.d.restoreHintFlags}` : '';
          const failure = new Error(
            `롤백 실패 — 인증 파일이 불완전할 수 있습니다. 백업: ${backupPath} (원인: ${(rollbackErr as Error).message}; 최초 오류: ${originalErr.message})` +
              ` — 복구: npm run cli -- restore ${tool} "${backupPath}"${hintFlags}`,
          );
          try {
            this.d.db.recordSwitch(tool, null, 'rolled_back');
          } catch {
            /* 기록 실패는 무시하고 원래 오류를 던진다 */
          }
          throw failure;
        }
        try {
          this.d.db.recordSwitch(tool, null, 'rolled_back');
        } catch {
          /* 기록 실패는 무시하고 롤백 결과는 그대로 반환한다 */
        }
        const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
        return { status: 'rolled_back', reason: originalErr.message, backupPath, launchWarning };
      }

      // 5. 앱 실행
      this.d.db.recordSwitch(tool, target.id, 'ok');
      const launchWarning = await this.launchAndVerify(provider.app);
      return { status: 'switched', account: target, launchWarning, notice };
    } finally {
      this.inFlight = false;
    }
  }

  // 백업 파일에서 직접 복원. 로그아웃 상태 백업일 수 있으므로 신원 검증은 하지 않고, switch_events 에도 기록하지 않는다.
  async restoreBackup(tool: ToolId, file: string): Promise<RestoreResult> {
    if (this.inFlight) return { status: 'aborted', reason: '다른 전환이 진행 중입니다' };
    this.inFlight = true;
    try {
      this.progress('백업 불러오기');
      let bundle: AuthBundle;
      try {
        bundle = await this.d.backups.load(file);
      } catch (e) {
        return { status: 'aborted', reason: `백업을 불러올 수 없음: ${(e as Error).message}` };
      }
      if (bundle.tool !== tool) {
        return { status: 'aborted', reason: `백업은 '${bundle.tool}' 용이며 요청한 '${tool}' 과 다릅니다` };
      }
      const provider = this.d.providers[tool];

      const stopped = await this.stopApp(provider.app);
      if (!stopped.ok) return { status: 'aborted', reason: stopped.reason };
      const wasRunning = stopped.wasRunning;

      // 앱이 쿠키 파일 등을 잠그고 있으면 종료 전 읽기가 EBUSY 로 실패하므로, 종료 후에 읽어
      // 범위 확인과 안전 백업에 같이 쓴다.
      let current: AuthBundle;
      let safetyBackupPath: string | undefined;
      try {
        current = await provider.readCurrentAuth();
        if (!sameScope(bundle, current)) {
          const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
          return {
            status: 'aborted',
            reason: '백업의 범위(앱 프로필 포함 여부)가 현재 실행 옵션과 다릅니다 — 백업을 만들 때와 같은 --with-app-profile 옵션으로 실행하세요',
            launchWarning,
          };
        }
        safetyBackupPath = await this.d.backups.save(current, file);
        this.progress('복원');
        await provider.writeAuth(bundle);
      } catch (e) {
        // 쓰기가 일부만 되었을 수 있으므로 안전 백업 상태로 되돌린 뒤에만 앱을 다시 띄운다.
        if (safetyBackupPath) {
          try {
            await provider.writeAuth(current!);
          } catch (rollbackErr) {
            const hintFlags = this.d.restoreHintFlags ? ` ${this.d.restoreHintFlags}` : '';
            throw new Error(
              `복원 실패 후 되돌리기도 실패 — 인증 파일이 불완전할 수 있어 앱을 다시 실행하지 않았습니다. 복원 직전 상태 백업: ${safetyBackupPath} (원인: ${(rollbackErr as Error).message}; 최초 오류: ${(e as Error).message})` +
                ` — 복구: npm run cli -- restore ${tool} "${safetyBackupPath}"${hintFlags}`,
            );
          }
        }
        const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
        const backupNote = safetyBackupPath ? ` (복원 직전 상태 백업: ${safetyBackupPath})` : '';
        return { status: 'aborted', reason: `복원 중 오류: ${(e as Error).message}${backupNote}`, launchWarning };
      }

      const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
      return { status: 'restored', backupPath: safetyBackupPath, launchWarning };
    } finally {
      this.inFlight = false;
    }
  }

  // 로그아웃 없이 새 계정을 추가할 준비를 한다: 현재 계정을 저장/백업하고, 인증 파일을 비운 뒤 앱을 다시
  // 연다 — 서버 쪽 로그아웃(토큰 폐기)은 절대 호출하지 않는다. switch_events 에도 기록하지 않는다.
  async prepareNewLogin(tool: ToolId): Promise<PrepareNewLoginResult> {
    if (this.inFlight) return { status: 'aborted', reason: '다른 전환이 진행 중입니다' };
    this.inFlight = true;
    try {
      const provider = this.d.providers[tool];

      const stopped = await this.stopApp(provider.app);
      if (!stopped.ok) return { status: 'aborted', reason: stopped.reason };
      const wasRunning = stopped.wasRunning;

      let backupPath: string;
      let notice: string | undefined;
      try {
        const current = await provider.readCurrentAuth();

        let currentIdentity: Identity | undefined;
        try {
          currentIdentity = provider.identityOf(current);
        } catch (e) {
          if (!(e instanceof NotLoggedInError)) throw e;
          currentIdentity = undefined;
        }

        if (!currentIdentity) notice = SKIPPED_REFRESH_NOTICE;
        if (currentIdentity) {
          this.progress('현재 계정 저장');
          const known = this.d.db.findAccountByIdentity(tool, currentIdentity.accountId, currentIdentity.orgId ?? '');
          if (known) {
            const knownSnapshot = await this.d.accounts.loadSnapshot(known);
            if (!sameScope(knownSnapshot, current)) throw scopeMismatchError(known.label);
            await this.d.accounts.storeSnapshot(currentIdentity, known.label, current);
          } else {
            const label = await this.d.prompts.confirmSaveUnknown(currentIdentity);
            if (!label) {
              const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
              return { status: 'aborted', reason: '현재 로그인을 먼저 저장해야 새 계정을 추가할 수 있습니다', launchWarning };
            }
            await this.d.accounts.storeSnapshot(currentIdentity, label, current);
          }
        }

        this.progress('백업');
        backupPath = await this.d.backups.save(current);
        await provider.writeAuth(clearedBundle(current));
      } catch (e) {
        const launchWarning = wasRunning ? await this.launchAndVerify(provider.app) : undefined;
        return { status: 'aborted', reason: `새 계정 추가 준비 중 오류: ${(e as Error).message}`, launchWarning };
      }

      const launchWarning = await this.launchAndVerify(provider.app);
      return { status: 'ready', backupPath, launchWarning, notice };
    } finally {
      this.inFlight = false;
    }
  }

  // 대상 앱을 종료한 상태로 fn 을 실행한다(마이그레이션 쓰기 등). fn 이 끝나면(성공/실패 무관) 앱이 실행 중이었을
  // 경우에만 재실행+확인한다. fn 의 예외는 aborted 로 변환된다(사유 = 오류 메시지).
  async runWithAppStopped<T>(
    tool: ToolId,
    fn: (progress: (step: string) => void) => Promise<T>,
  ): Promise<{ status: 'done'; value: T; launchWarning?: string } | { status: 'aborted'; reason: string; launchWarning?: string }> {
    if (this.inFlight) return { status: 'aborted', reason: '다른 전환이 진행 중입니다' };
    this.inFlight = true;
    try {
      const provider = this.d.providers[tool];
      const stopped = await this.stopApp(provider.app);
      if (!stopped.ok) return { status: 'aborted', reason: stopped.reason };
      const wasRunning = stopped.wasRunning;

      // fn 은 자체 try 안에서 실행하고, 재실행은 그 밖에서 따로 시도한다 — fn 이 성공했다면 앱 실행 실패는
      // 경고일 뿐 결과를 aborted 로 뒤집지 않는다.
      let outcome: { ok: true; value: T } | { ok: false; reason: string };
      try {
        outcome = { ok: true, value: await fn((step) => this.progress(step)) };
      } catch (e) {
        outcome = { ok: false, reason: (e as Error).message };
      }

      let launchWarning: string | undefined;
      if (wasRunning) {
        try {
          launchWarning = await this.launchAndVerify(provider.app);
        } catch (e) {
          launchWarning = `앱을 다시 실행하지 못했습니다 — 앱을 직접 실행하세요 (${(e as Error).message})`;
        }
      }
      return outcome.ok
        ? { status: 'done', value: outcome.value, launchWarning }
        : { status: 'aborted', reason: outcome.reason, launchWarning };
    } finally {
      this.inFlight = false;
    }
  }

  private async stopApp(app: AppInfo): Promise<{ ok: true; wasRunning: boolean } | { ok: false; reason: string }> {
    const { appProcs, strayCli } = classifyProcesses(await this.d.procs.list(), app);
    const wasRunning = appProcs.length > 0;

    if (strayCli.length > 0 && !(await this.d.prompts.confirmStrayCli(strayCli))) {
      return { ok: false, reason: '독립 실행 CLI 가 실행 중이라 전환을 취소함' };
    }
    if (!wasRunning) return { ok: true, wasRunning };

    this.progress('앱 종료 중');
    await this.d.procs.closeGracefully(appProcs.map((p) => p.pid));
    let remaining = await this.waitForExit(app, appProcs);
    if (remaining.length === 0) return { ok: true, wasRunning };

    if (!this.autoKill && !(await this.d.prompts.confirmKill(remaining))) {
      return { ok: false, reason: '앱이 종료되지 않았고 강제 종료를 취소함 — 앱이 트레이에 숨어 있을 수 있으니 직접 다시 여세요' };
    }
    this.progress('강제 종료 중');
    await this.d.procs.kill(remaining.map((p) => p.pid));
    remaining = await this.waitForExit(app, remaining);
    return remaining.length === 0 ? { ok: true, wasRunning } : { ok: false, reason: '앱 프로세스를 종료할 수 없음' };
  }

  // 앱을 실행하고, 프로세스가 실제로 뜨는지 확인한다. launchTimeoutMs 안에 뜨지 않으면 경고 메시지를 반환한다
  // (예: 스토어 업데이트 대기 등으로 실행이 막힌 경우). procs.launch() 자체의 오류는 그대로 전파한다.
  private async launchAndVerify(app: AppInfo): Promise<string | undefined> {
    this.progress('앱 실행');
    await this.d.procs.launch(app.aumid);
    this.progress('앱 실행 확인');
    const iterations = Math.max(1, Math.ceil(this.launchTimeoutMs / this.pollMs));
    for (let i = 0; i < iterations; i++) {
      const { appProcs } = classifyProcesses(await this.d.procs.list(), app);
      if (appProcs.length > 0) return undefined;
      if (i < iterations - 1) await this.sleep(this.pollMs);
    }
    return LAUNCH_FAILURE_WARNING;
  }

  private progress(step: string): void {
    this.d.onProgress?.(step);
  }

  // 종료 대기는 가벼운 alive() 로 폴링하고, 모두 사라진 뒤 list() 로 한 번만 다시 분류해 새로 뜬 앱 프로세스를 찾는다.
  private async waitForExit(app: AppInfo, waitingOn: ProcInfo[]): Promise<ProcInfo[]> {
    const deadline = Date.now() + this.closeTimeoutMs;
    for (;;) {
      const alive = new Set(await this.d.procs.alive(waitingOn.map((p) => p.pid)));
      if (alive.size === 0) return classifyProcesses(await this.d.procs.list(), app).appProcs;
      if (Date.now() >= deadline) return waitingOn.filter((p) => alive.has(p.pid));
      await this.sleep(this.pollMs);
    }
  }

  // 스냅샷을 갱신(또는 사용자가 저장 안 함을 선택)했으면 true, 로그인 정보가 없어 건너뛰었으면 false.
  private async refreshOutgoing(provider: ToolAuthProvider, current: AuthBundle): Promise<boolean> {
    let id: Identity;
    try {
      id = provider.identityOf(current);
    } catch (e) {
      if (!(e instanceof NotLoggedInError)) throw e;
      return false; // 로그인 안 된 상태 — 저장할 것 없음
    }
    const known = this.d.db.findAccountByIdentity(id.tool, id.accountId, id.orgId ?? '');
    if (known) {
      const knownSnapshot = await this.d.accounts.loadSnapshot(known);
      if (!sameScope(knownSnapshot, current)) throw scopeMismatchError(known.label);
      await this.d.accounts.storeSnapshot(id, known.label, current);
      return true;
    }
    const label = await this.d.prompts.confirmSaveUnknown(id);
    if (label) await this.d.accounts.storeSnapshot(id, label, current);
    return true;
  }
}
