import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { serializeBundle } from '../../src/main/core/auth-bundle.js';
import { AppDb } from '../../src/main/infra/app-db.js';
import { bundleScope } from '../../src/main/infra/auth-fs.js';
import { BackupStore } from '../../src/main/infra/backup-store.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { AccountService } from '../../src/main/services/account-service.js';
import { classifyProcesses } from '../../src/main/services/app-processes.js';
import { SwitchService, type SwitchPrompts } from '../../src/main/services/switch-service.js';
import { writeClaudeAuth, writeCodexAuth } from '../helpers/fake-auth.js';
import { FakeProcs } from '../helpers/fake-procs.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

const CODEX_APP_PATH = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';

let p: PathProvider;
let db: AppDb;
let accounts: AccountService;
let procs: FakeProcs;
let prompts: { [K in keyof SwitchPrompts]: Mock<SwitchPrompts[K]> };
let svc: SwitchService;
let providers: { codex: ReturnType<typeof codexAuthProvider>; claude: ReturnType<typeof claudeAuthProvider> };
const secrets = fakeSecretStore();

const authJson = () => readText(path.join(p.home, '.codex', 'auth.json'));
const currentAccountId = async () => JSON.parse(await authJson()).tokens.account_id as string;

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  providers = { codex: codexAuthProvider(p), claude: claudeAuthProvider(p) };
  accounts = new AccountService({ db, secrets, paths: p, providers });
  procs = new FakeProcs();
  // 기본적으로 launch() 가 실제로 앱을 띄운 것처럼 동작하게 해서, 기존 테스트들이 launchWarning 없이
  // 통과하도록 한다. 앱이 뜨지 않는 경우를 검증하는 테스트는 이 값을 undefined 로 되돌린다.
  procs.startsOnLaunch = { pid: 999, name: 'ChatGPT', path: CODEX_APP_PATH };
  prompts = {
    confirmKill: vi.fn<SwitchPrompts['confirmKill']>(async () => true),
    confirmSaveUnknown: vi.fn<SwitchPrompts['confirmSaveUnknown']>(async () => null),
    confirmStrayCli: vi.fn<SwitchPrompts['confirmStrayCli']>(async () => true),
  };
  svc = new SwitchService({
    accounts, db, providers, procs, prompts,
    backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
    closeTimeoutMs: 0,
    sleep: async () => {},
    launchTimeoutMs: 1000,
    pollMs: 100,
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
    expect(db.listSwitches('codex').map((e) => e.result)).toEqual(['saved', 'saved', 'ok']);
  });

  it('refreshes the outgoing account snapshot first (token rotation)', async () => {
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'rotated');
    await svc.switchTo('codex', 'work');
    await svc.switchTo('codex', 'personal');
    expect(JSON.parse(await authJson()).tokens.refresh_token).toBe('rotated');
  });

  it('switching to the already-active account refreshes its snapshot without overwriting fresh tokens', async () => {
    // B 가 이미 로그인된 상태에서 personal 로 전환 — 토큰이 그 사이 회전되어도 auth.json 을 다시 쓰면 안 된다
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'rotated-fresh');
    const r = await svc.switchTo('codex', 'personal');
    expect(r.status).toBe('switched');
    expect(JSON.parse(await authJson()).tokens.refresh_token).toBe('rotated-fresh');
    const personal = db.findAccountByLabel('codex', 'personal')!;
    const snap = await accounts.loadSnapshot(personal);
    const authFile = snap.files.find((f) => f.relPath === '.codex/auth.json');
    const parsed = JSON.parse(Buffer.from(authFile!.data!, 'base64').toString('utf8'));
    expect(parsed.tokens.refresh_token).toBe('rotated-fresh');
    expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
  });

  it('closes a running app before touching files', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    // 원래 pid(10)는 닫혔고, 전환 후 재실행되어 새 프로세스(startsOnLaunch)로 대체됨
    expect(procs.running).toEqual([procs.startsOnLaunch]);
    expect(procs.killed).toEqual([]);
  });

  it('has no launchWarning when the app successfully starts after switching', async () => {
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect((r as { launchWarning?: string }).launchWarning).toBeUndefined();
  });

  it('reports a launchWarning when the app does not start after switching', async () => {
    procs.startsOnLaunch = undefined;
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect((r as { launchWarning?: string }).launchWarning).toContain('앱이 시작되지 않았습니다');
  });

  it('aborts without changes when the app does not close and the user declines kill, mentioning the tray', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    prompts.confirmKill.mockResolvedValue(false);
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted', reason: '앱이 종료되지 않았고 강제 종료를 취소함 — 앱이 트레이에 숨어 있을 수 있으니 직접 다시 여세요' });
    expect(await currentAccountId()).toBe('acct-B');
    expect(procs.launched).toEqual([]);
  });

  it('polls exit with the light alive() and calls list() only for the initial and the final classification', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    let listCalls = 0;
    let listCallsWhenGone = -1;
    const realList = procs.list.bind(procs);
    procs.list = async () => { listCalls++; return realList(); };
    const realAlive = procs.alive.bind(procs);
    procs.alive = async (pids) => {
      if (procs.aliveCalls === 3) procs.running = [];
      const r = await realAlive(pids);
      if (r.length === 0 && listCallsWhenGone < 0) listCallsWhenGone = listCalls;
      return r;
    };
    const patient = new SwitchService({
      accounts, db, providers, procs, prompts,
      backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
      closeTimeoutMs: 60_000,
      sleep: async () => {},
      launchTimeoutMs: 1000,
      pollMs: 100,
    });
    const r = await patient.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(procs.aliveCalls).toBeGreaterThanOrEqual(4);
    expect(listCallsWhenGone).toBe(1); // 종료 대기 중에는 list() 를 부르지 않았다
    expect(procs.killed).toEqual([]);
  });

  it('treats an app process that respawns after the old pids exit as still running', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closeGracefully = async () => { procs.running = [{ pid: 11, name: 'ChatGPT', path: CODEX_APP_PATH }]; };
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(procs.killed).toEqual([11]); // 새로 뜬 프로세스를 다시 분류해 정리
  });

  it('kills the app when it does not close and the user agrees', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(procs.killed).toEqual([10]);
  });

  it('force-kills the app automatically when autoKill is enabled, without prompting confirmKill', async () => {
    const autoKillSvc = new SwitchService({
      accounts, db, providers, procs, prompts,
      backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
      closeTimeoutMs: 0,
      sleep: async () => {},
      launchTimeoutMs: 1000,
      pollMs: 100,
      autoKill: true,
    });
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    const r = await autoKillSvc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(procs.killed).toEqual([10]);
    expect(prompts.confirmKill).not.toHaveBeenCalled();
  });

  it('aborts when autoKill cannot terminate the remaining processes', async () => {
    const autoKillSvc = new SwitchService({
      accounts, db, providers, procs, prompts,
      backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
      closeTimeoutMs: 0,
      sleep: async () => {},
      launchTimeoutMs: 1000,
      pollMs: 100,
      autoKill: true,
    });
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    procs.kill = async () => {}; // 강제 종료해도 프로세스가 남는 상황을 재현
    const r = await autoKillSvc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted', reason: '앱 프로세스를 종료할 수 없음' });
    expect(prompts.confirmKill).not.toHaveBeenCalled();
  });

  it('reports progress steps in order for a successful switch that requires a kill', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    procs.closesOnRequest = false;
    const steps: string[] = [];
    const progressSvc = new SwitchService({
      accounts, db, providers, procs, prompts,
      backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
      closeTimeoutMs: 0,
      sleep: async () => {},
      launchTimeoutMs: 1000,
      pollMs: 100,
      autoKill: true,
      onProgress: (step) => steps.push(step),
    });
    const r = await progressSvc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(steps).toEqual([
      '스냅샷 확인',
      '앱 종료 중',
      '강제 종료 중',
      '현재 계정 저장',
      '백업',
      '로그인 정보 교체',
      '계정 확인',
      '앱 실행',
      '앱 실행 확인',
    ]);
  });

  it('reports progress steps in order for restoreBackup', async () => {
    const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
    const provider = codexAuthProvider(p);
    await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
    const file = await backups.save(await provider.readCurrentAuth());
    await writeCodexAuth(p, 'acct-B', 'b@x.com');
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    const steps: string[] = [];
    const progressSvc = new SwitchService({
      accounts, db, providers, procs, prompts,
      backups,
      closeTimeoutMs: 0,
      sleep: async () => {},
      launchTimeoutMs: 1000,
      pollMs: 100,
      onProgress: (step) => steps.push(step),
    });
    const r = await progressSvc.restoreBackup('codex', file);
    expect(r.status).toBe('restored');
    expect(steps).toEqual(['백업 불러오기', '앱 종료 중', '복원', '앱 실행', '앱 실행 확인']);
  });

  it('confirms about standalone CLI processes and continues', async () => {
    procs.running = [{ pid: 20, name: 'codex', path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.exe' }];
    const r = await svc.switchTo('codex', 'work');
    expect(r.status).toBe('switched');
    expect(prompts.confirmStrayCli).toHaveBeenCalledOnce();
  });

  it('aborts before closing the app when stray CLI processes exist and the user declines', async () => {
    procs.running = [
      { pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH },
      { pid: 20, name: 'codex', path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.exe' },
    ];
    prompts.confirmStrayCli.mockResolvedValue(false);
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted' });
    expect(await currentAccountId()).toBe('acct-B');
    // 앱이 종료 시도조차 되지 않음
    expect(procs.running.map((pr) => pr.pid)).toEqual([10, 20]);
    expect(procs.launched).toEqual([]);
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
    // 롤백 시점에 앱이 실행 중이 아니었으므로 재실행하지 않는다
    expect(procs.launched).toEqual([]);
    expect(db.listSwitches('codex').map((e) => e.result)).toEqual(['saved', 'saved', 'rolled_back']);
  });

  it('relaunches the app after a successful rollback if it was running before the switch', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    const work = db.findAccountByLabel('codex', 'work')!;
    const personal = db.findAccountByLabel('codex', 'personal')!;
    const bBundle = await accounts.loadSnapshot(personal);
    await fs.writeFile(work.snapshotPath, await secrets.encrypt(serializeBundle(bBundle)));
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'current');
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'rolled_back' });
    expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
  });

  it('marks needs_relogin with a missing-file reason when the snapshot file does not exist', async () => {
    const work = db.findAccountByLabel('codex', 'work')!;
    await fs.rm(work.snapshotPath);
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted' });
    expect((r as { reason: string }).reason).toContain('스냅샷 파일 없음');
    expect(db.findAccountByLabel('codex', 'work')!.status).toBe('needs_relogin');
  });

  it('aborts without changing status on IO errors other than decrypt/ENOENT', async () => {
    const work = db.findAccountByLabel('codex', 'work')!;
    await fs.rm(work.snapshotPath);
    await fs.mkdir(work.snapshotPath); // 파일 자리에 폴더 -> EISDIR
    const r = await svc.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted' });
    expect((r as { reason: string }).reason).toContain('읽는 중 오류');
    expect(db.findAccountByLabel('codex', 'work')!.status).toBe('ok');
  });

  it('does not mark needs_relogin when the PowerShell decrypt step times out', async () => {
    const slow = new SwitchService({
      accounts: new AccountService({
        db, paths: p, providers,
        secrets: { encrypt: secrets.encrypt, decrypt: async () => { throw new Error('powershell timed out after 30000ms'); } },
      }),
      db, providers, procs, prompts,
      backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
      closeTimeoutMs: 0, sleep: async () => {},
    });
    const r = await slow.switchTo('codex', 'work');
    expect(r).toMatchObject({ status: 'aborted' });
    expect(db.findAccountByLabel('codex', 'work')!.status).toBe('ok');
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

  it('relaunches the app and aborts without changes when preparing the switch fails', async () => {
    procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
    await writeCodexAuth(p, 'acct-C', 'c@x.com');
    // 'work' 는 이미 다른 신원(A)이 쓰고 있는 라벨 — storeSnapshot 이 충돌 오류를 던진다
    prompts.confirmSaveUnknown.mockResolvedValue('work');
    const r = await svc.switchTo('codex', 'personal');
    expect(r).toMatchObject({ status: 'aborted' });
    expect(await currentAccountId()).toBe('acct-C');
    const work = db.findAccountByLabel('codex', 'work')!;
    const personal = db.findAccountByLabel('codex', 'personal')!;
    expect(db.listSwitches('codex')).toEqual([
      { accountRowId: work.id, switchedAt: expect.any(String), result: 'saved' },
      { accountRowId: personal.id, switchedAt: expect.any(String), result: 'saved' },
    ]);
    // 전환 준비 중 실패했으므로, 닫았던 앱을 다시 띄워준다
    expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
  });

  it('rejects a second switchTo call while one is already in flight', async () => {
    let releaseGate: () => void = () => {};
    procs.listGate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const first = svc.switchTo('codex', 'work'); // gets stuck inside stopApp() awaiting procs.list()
    const second = await svc.switchTo('codex', 'personal');
    expect(second).toMatchObject({ status: 'aborted' });
    expect((second as { reason: string }).reason).toContain('진행 중');

    releaseGate();
    const firstResult = await first;
    expect(firstResult.status).toBe('switched');
  });

  it('throws for an unknown label', async () => {
    await expect(svc.switchTo('codex', 'nope')).rejects.toThrow("'nope'");
  });

  it('throws a rollback-failure error naming the backup path when the rollback write itself fails, and the backup holds the pre-switch content', async () => {
    const work = db.findAccountByLabel('codex', 'work')!;
    const personal = db.findAccountByLabel('codex', 'personal')!;
    // work 스냅샷을 B 의 번들로 오염시킨다 (기존 롤백 테스트와 동일)
    const bBundle = await accounts.loadSnapshot(personal);
    await fs.writeFile(work.snapshotPath, await secrets.encrypt(serializeBundle(bBundle)));
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'current');

    // codex provider 를 감싸서: 1차 호출(대상 쓰기)은 성공, 2차 호출(롤백 쓰기)은 실패하게 만든다
    const realCodex = codexAuthProvider(p);
    let writeCalls = 0;
    const flakyCodex = {
      ...realCodex,
      writeAuth: async (bundle: Parameters<typeof realCodex.writeAuth>[0]) => {
        writeCalls++;
        if (writeCalls === 2) throw new Error('EBUSY: file locked');
        return realCodex.writeAuth(bundle);
      },
    };
    const backupsDir = path.join(p.appDataDir, 'backups');
    const flakySvc = new SwitchService({
      accounts, db, providers: { codex: flakyCodex, claude: claudeAuthProvider(p) }, procs, prompts,
      backups: new BackupStore(backupsDir, secrets),
      closeTimeoutMs: 0,
      sleep: async () => {},
    });

    let caught: Error | undefined;
    try {
      await flakySvc.switchTo('codex', 'work');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('롤백 실패');
    expect(caught!.message).toContain(backupsDir);
    expect(caught!.message).toContain('npm run cli -- restore codex "');
    expect(db.listSwitches('codex').map((e) => e.result)).toEqual(['saved', 'saved', 'rolled_back']);

    // 백업 파일이 실제로 전환 전 B 의 내용(refresh_token='current')을 담고 있는지 확인
    const codexBackupDir = path.join(backupsDir, 'codex');
    const backupFiles = await fs.readdir(codexBackupDir);
    expect(backupFiles).toHaveLength(1);
    const loaded = await new BackupStore(backupsDir, secrets).load(path.join(codexBackupDir, backupFiles[0]!));
    const authFile = loaded.files.find((f) => f.relPath === '.codex/auth.json');
    const parsed = JSON.parse(Buffer.from(authFile!.data!, 'base64').toString('utf8'));
    expect(parsed.tokens.refresh_token).toBe('current');
  });

  it('aborts when the target snapshot scope (app-profile inclusion) differs from the current run', async () => {
    const profileNetworkDir = path.join(
      p.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex', 'Default', 'Network',
    );
    await writeFile(path.join(profileNetworkDir, 'Cookies'), 'fake-cookie-data');

    // 'work' 를 --with-app-profile 옵션으로 다시 저장해 스냅샷 범위를 넓힌다
    const accountsWithProfile = new AccountService({
      db, secrets, paths: p,
      providers: { codex: codexAuthProvider(p, { withAppProfile: true }), claude: claudeAuthProvider(p) },
    });
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    await accountsWithProfile.saveCurrent('codex', 'work');
    await writeCodexAuth(p, 'acct-B', 'b@x.com'); // 현재 로그인은 다시 B 로 복귀

    const r = await svc.switchTo('codex', 'work'); // svc 는 프로필 옵션 없이 구성됨
    expect(r).toMatchObject({ status: 'aborted' });
    expect((r as { reason: string }).reason).toContain('범위');
    expect(await currentAccountId()).toBe('acct-B');
    const work = db.findAccountByLabel('codex', 'work')!;
    const personal = db.findAccountByLabel('codex', 'personal')!;
    expect(db.listSwitches('codex')).toEqual([
      { accountRowId: work.id, switchedAt: expect.any(String), result: 'saved' },
      { accountRowId: personal.id, switchedAt: expect.any(String), result: 'saved' },
      { accountRowId: work.id, switchedAt: expect.any(String), result: 'saved' },
    ]);
    await expect(fs.readdir(path.join(p.appDataDir, 'backups', 'codex'))).rejects.toThrow();
  });

  it("aborts when the outgoing account's stored snapshot scope differs from the current run, leaving it unchanged", async () => {
    const profileNetworkDir = path.join(
      p.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex', 'Default', 'Network',
    );
    await writeFile(path.join(profileNetworkDir, 'Cookies'), 'fake-cookie-data');

    const accountsWithProfile = new AccountService({
      db, secrets, paths: p,
      providers: { codex: codexAuthProvider(p, { withAppProfile: true }), claude: claudeAuthProvider(p) },
    });
    // personal(B) 가 이미 현재 로그인 상태 — --with-app-profile 옵션으로 다시 스냅샷을 찍어 범위를 넓힌다
    await accountsWithProfile.saveCurrent('codex', 'personal');

    const personalBefore = db.findAccountByLabel('codex', 'personal')!;
    const scopeBefore = bundleScope(await accounts.loadSnapshot(personalBefore));
    expect(scopeBefore.length).toBeGreaterThan(1); // 프로필 경로 포함 확인

    const r = await svc.switchTo('codex', 'work'); // svc 는 프로필 옵션 없음 — work 는 애초에 범위가 맞음
    expect(r).toMatchObject({ status: 'aborted' });
    expect((r as { reason: string }).reason).toContain('범위');
    expect((r as { reason: string }).reason).toContain('personal');

    const personalAfter = db.findAccountByLabel('codex', 'personal')!;
    const scopeAfter = bundleScope(await accounts.loadSnapshot(personalAfter));
    expect(scopeAfter).toEqual(scopeBefore);
  });

  it('switches Claude accounts, preserving unrelated .claude.json keys', async () => {
    const claudeCfgPath = path.join(p.home, '.claude.json');
    await fs.mkdir(path.dirname(claudeCfgPath), { recursive: true });
    await fs.writeFile(claudeCfgPath, JSON.stringify({ numStartups: 7 }));

    await writeClaudeAuth(p, 'acct-A-claude', 'org-1', 'a@claude.com', 'refresh-A');
    await accounts.saveCurrent('claude', 'claudeA');
    await writeClaudeAuth(p, 'acct-B-claude', 'org-1', 'b@claude.com', 'refresh-B');
    await accounts.saveCurrent('claude', 'claudeB');

    const r = await svc.switchTo('claude', 'claudeA');
    expect(r.status).toBe('switched');

    const cfg = JSON.parse(await fs.readFile(claudeCfgPath, 'utf8'));
    expect(cfg.oauthAccount.accountUuid).toBe('acct-A-claude');
    expect(cfg.numStartups).toBe(7);

    const creds = JSON.parse(await fs.readFile(path.join(p.home, '.claude', '.credentials.json'), 'utf8'));
    expect(creds.claudeAiOauth.refreshToken).toBe('refresh-A');
  });

  it('cancels the switch (rather than silently overwriting) when the current Claude account mismatches Desktop config.json, relaunching if it was running', async () => {
    const CLAUDE_APP_PATH = 'C:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__pzs8sxrjxfjjc\\Claude.exe';
    procs.running = [{ pid: 30, name: 'Claude', path: CLAUDE_APP_PATH }];

    await writeClaudeAuth(p, 'acct-A-claude', 'org-1', 'a@claude.com');
    await accounts.saveCurrent('claude', 'claudeA');
    await writeClaudeAuth(p, 'acct-B-claude', 'org-1', 'b@claude.com');
    await accounts.saveCurrent('claude', 'claudeB');

    // Desktop config.json 이 가리키는 계정과 ~/.claude.json 의 oauthAccount 가 어긋난 상태를 재현
    const desktopCfgPath = path.join(p.appData, 'Claude', 'config.json');
    const desktopCfg = JSON.parse(await fs.readFile(desktopCfgPath, 'utf8'));
    desktopCfg.lastKnownAccountUuid = 'someone-else-entirely';
    await fs.writeFile(desktopCfgPath, JSON.stringify(desktopCfg));
    const claudeJsonBefore = await fs.readFile(path.join(p.home, '.claude.json'), 'utf8');

    const r = await svc.switchTo('claude', 'claudeA');
    expect(r).toMatchObject({ status: 'aborted' });
    expect((r as { reason: string }).reason).toContain('계정 정보 불일치');

    // 아무 파일도 바뀌지 않았어야 함
    expect(await fs.readFile(path.join(p.home, '.claude.json'), 'utf8')).toBe(claudeJsonBefore);
    // 백업도 만들어지지 않았어야 함
    await expect(fs.readdir(path.join(p.appDataDir, 'backups', 'claude'))).rejects.toThrow();
    // 실행 중이었으므로 다시 띄워준다
    expect(procs.launched).toEqual(['Claude_pzs8sxrjxfjjc!Claude']);
  });

  it('switches Claude accounts, restoring Desktop config.json token cache keys and preserving an unrelated key', async () => {
    const desktopCfgPath = path.join(p.appData, 'Claude', 'config.json');
    await fs.mkdir(path.dirname(desktopCfgPath), { recursive: true });
    await fs.writeFile(desktopCfgPath, JSON.stringify({ someUnrelatedSetting: 'keep-me' }));

    await writeClaudeAuth(p, 'acct-A-claude', 'org-1', 'a@claude.com', 'refresh-A');
    await accounts.saveCurrent('claude', 'claudeA');
    await writeClaudeAuth(p, 'acct-B-claude', 'org-1', 'b@claude.com', 'refresh-B');
    await accounts.saveCurrent('claude', 'claudeB');

    const r = await svc.switchTo('claude', 'claudeA');
    expect(r.status).toBe('switched');

    const cfg = JSON.parse(await fs.readFile(desktopCfgPath, 'utf8'));
    expect(cfg['oauth:tokenCache']).toBe('tc-refresh-A');
    expect(cfg['oauth:tokenCacheV2']).toBe('tc2-refresh-A');
    expect(cfg.lastKnownAccountUuid).toBe('acct-A-claude');
    expect(cfg.someUnrelatedSetting).toBe('keep-me');
  });

  describe('restoreBackup', () => {
    it('restores auth.json content from a backup file', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com'); // 복원 직전 현재 로그인 상태로 되돌림

      const r = await svc.restoreBackup('codex', file);
      expect(r.status).toBe('restored');
      expect(await currentAccountId()).toBe('acct-Z');
      const work = db.findAccountByLabel('codex', 'work')!;
      const personal = db.findAccountByLabel('codex', 'personal')!;
      expect(db.listSwitches('codex')).toEqual([
        { accountRowId: work.id, switchedAt: expect.any(String), result: 'saved' },
        { accountRowId: personal.id, switchedAt: expect.any(String), result: 'saved' },
      ]);
    });

    it('aborts and leaves auth unchanged when the backup is for a different tool', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const claudeProvider = claudeAuthProvider(p);
      await writeClaudeAuth(p, 'acc-Z', 'org-Z', 'z@claude.com');
      const file = await backups.save(await claudeProvider.readCurrentAuth());

      const r = await svc.restoreBackup('codex', file);
      expect(r).toMatchObject({ status: 'aborted' });
      expect(await currentAccountId()).toBe('acct-B');
    });

    it('writes a safety backup of the pre-restore state before overwriting, returning its path', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com', 'pre-restore');

      const r = await svc.restoreBackup('codex', file);
      expect(r.status).toBe('restored');
      const safetyBackup = await backups.load((r as { backupPath: string }).backupPath);
      const authFile = safetyBackup.files.find((f) => f.relPath === '.codex/auth.json');
      const parsed = JSON.parse(Buffer.from(authFile!.data!, 'base64').toString('utf8'));
      expect(parsed.tokens.refresh_token).toBe('pre-restore');
    });

    it('protects the backup file being restored from pruning by the safety backup', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets, 1); // keep=1 이면 안전 백업이 곧바로 정리 대상을 만든다
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth()); // 복원할 백업 (정리되면 안 됨)
      await writeCodexAuth(p, 'acct-B', 'b@x.com');

      const restoreSvc = new SwitchService({
        accounts, db, providers: { codex: provider, claude: claudeAuthProvider(p) }, procs, prompts,
        backups,
        closeTimeoutMs: 0,
        sleep: async () => {},
      });

      const r = await restoreSvc.restoreBackup('codex', file);
      expect(r.status).toBe('restored');
      expect(await exists(file)).toBe(true);
      expect(await backups.load(file)).toMatchObject({ tool: 'codex' });
    });

    it('aborts and relaunches the app when the backup scope (app-profile inclusion) differs from the current run', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const providerWithProfile = codexAuthProvider(p, { withAppProfile: true });
      await writeCodexAuth(p, 'acct-Z', 'z@x.com');
      const profileNetworkDir = path.join(
        p.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex', 'Default', 'Network',
      );
      await writeFile(path.join(profileNetworkDir, 'Cookies'), 'fake-cookie-data');
      const file = await backups.save(await providerWithProfile.readCurrentAuth()); // 더 넓은 범위로 찍힌 백업

      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
      const r = await svc.restoreBackup('codex', file); // svc 는 --with-app-profile 없이 구성됨
      expect(r).toMatchObject({ status: 'aborted' });
      expect((r as { reason: string }).reason).toContain('범위');
      // 범위 확인은 앱 종료 후에 하므로 중단되면 앱을 다시 띄워야 함
      expect(procs.running).toEqual([procs.startsOnLaunch]);
      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
    });

    it('restores the safety backup before relaunching when writeAuth fails partway, and does not relaunch if that rollback also fails', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com', 'pre');
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];

      let calls = 0;
      const partial = {
        ...provider,
        writeAuth: async (b: Parameters<typeof provider.writeAuth>[0]) => {
          calls++;
          if (calls === 1) {
            await writeCodexAuth(p, 'acct-half', 'h@x.com', 'half'); // 일부만 써진 상태 흉내
            throw new Error('EBUSY: locked');
          }
          return provider.writeAuth(b);
        },
      };
      const mk = (codex: typeof provider) =>
        new SwitchService({ accounts, db, providers: { codex, claude: claudeAuthProvider(p) }, procs, prompts, backups, closeTimeoutMs: 0, sleep: async () => {} });
      const r = await mk(partial).restoreBackup('codex', file);
      expect(r).toMatchObject({ status: 'aborted' });
      expect(await currentAccountId()).toBe('acct-B'); // 되돌려짐
      expect(procs.launched).toHaveLength(1);

      // 되돌리기까지 실패
      procs.launched.length = 0;
      procs.running = [{ pid: 11, name: 'ChatGPT', path: CODEX_APP_PATH }];
      const dead = { ...provider, writeAuth: async () => { throw new Error('EBUSY: locked'); } };
      await expect(mk(dead).restoreBackup('codex', file)).rejects.toThrow(/되돌리기도 실패.*백업: .*\.bin/);
      expect(procs.launched).toEqual([]);
    });

    it('aborts and relaunches the app when writeAuth fails after it was closed, reporting the safety backup path', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com');
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];

      let writes = 0;
      const flakyCodex = {
        ...provider,
        writeAuth: async (b: Parameters<typeof provider.writeAuth>[0]) => {
          if (++writes === 1) throw new Error('EBUSY: locked'); // 되돌리기(두 번째 쓰기)는 성공
          return provider.writeAuth(b);
        },
      };
      const flakySvc = new SwitchService({
        accounts, db, providers: { codex: flakyCodex, claude: claudeAuthProvider(p) }, procs, prompts,
        backups,
        closeTimeoutMs: 0,
        sleep: async () => {},
      });

      const r = await flakySvc.restoreBackup('codex', file);
      expect(r).toMatchObject({ status: 'aborted' });
      expect((r as { reason: string }).reason).toContain('복원 중 오류');
      expect((r as { reason: string }).reason).toContain('EBUSY');
      expect((r as { reason: string }).reason).toContain('복원 직전 상태 백업');
      // 앱은 닫혔다가 실패 후 재실행되어 새 프로세스(startsOnLaunch)로 대체됨
      expect(procs.running).toEqual([procs.startsOnLaunch]);
      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']); // 실패 후 다시 띄워줌
    });

    it('has no launchWarning when the app successfully restarts after restoring', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com');
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }]; // 복원 전 앱이 실행 중이었음

      const r = await svc.restoreBackup('codex', file);
      expect(r.status).toBe('restored');
      expect((r as { launchWarning?: string }).launchWarning).toBeUndefined();
    });

    it('reports a launchWarning when the app does not restart after restoring', async () => {
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com');
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }]; // 복원 전 앱이 실행 중이었음
      procs.startsOnLaunch = undefined;

      const r = await svc.restoreBackup('codex', file);
      expect(r.status).toBe('restored');
      expect((r as { launchWarning?: string }).launchWarning).toContain('앱이 시작되지 않았습니다');
    });
  });

  describe('skipped outgoing refresh notice', () => {
    const NOTICE = '현재 로그인 정보를 읽을 수 없어 이전 계정 스냅샷을 갱신하지 않았습니다';

    it('switchTo adds a notice when there is no current login', async () => {
      await fs.rm(path.join(p.home, '.codex', 'auth.json'));
      const r = await svc.switchTo('codex', 'work');
      expect(r).toMatchObject({ status: 'switched', notice: NOTICE });
    });

    it('switchTo has no notice when the outgoing account was refreshed', async () => {
      const r = await svc.switchTo('codex', 'work');
      expect((r as { notice?: string }).notice).toBeUndefined();
    });

    it('prepareNewLogin adds a notice when there is no current login', async () => {
      await fs.rm(path.join(p.home, '.codex', 'auth.json'));
      const r = await svc.prepareNewLogin('codex');
      expect(r).toMatchObject({ status: 'ready', notice: NOTICE });
    });
  });

  describe('prepareNewLogin', () => {
    it('refreshes the registered current account snapshot, clears the auth files, backs up the previous content, relaunches, and does not record a switch event', async () => {
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
      await writeCodexAuth(p, 'acct-B', 'b@x.com', 'rotated');
      const r = await svc.prepareNewLogin('codex');
      expect(r.status).toBe('ready');

      const personal = db.findAccountByLabel('codex', 'personal')!;
      const snap = await accounts.loadSnapshot(personal);
      const authFile = snap.files.find((f) => f.relPath === '.codex/auth.json');
      expect(JSON.parse(Buffer.from(authFile!.data!, 'base64').toString()).tokens.refresh_token).toBe('rotated');

      expect(await exists(path.join(p.home, '.codex', 'auth.json'))).toBe(false);

      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const backed = await backups.load((r as { backupPath: string }).backupPath);
      const backedAuth = backed.files.find((f) => f.relPath === '.codex/auth.json');
      expect(JSON.parse(Buffer.from(backedAuth!.data!, 'base64').toString()).tokens.refresh_token).toBe('rotated');

      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
      const work = db.findAccountByLabel('codex', 'work')!;
      expect(db.listSwitches('codex')).toEqual([
        { accountRowId: work.id, switchedAt: expect.any(String), result: 'saved' },
        { accountRowId: personal.id, switchedAt: expect.any(String), result: 'saved' },
      ]);
    });

    it('with a profile-scoped provider, also wipes the app profile directory (Network/Local State/Local Storage) from disk while keeping its content in the backup', async () => {
      const profileNetworkDir = path.join(
        p.localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', 'Codex', 'web', 'Codex', 'Default', 'Network',
      );
      await writeFile(path.join(profileNetworkDir, 'Cookies'), 'fake-cookie-data');

      // 'personal'(현재 로그인 = acct-B)을 --with-app-profile 범위로 다시 저장해, prepareNewLogin 의
      // scope 검사(refreshOutgoing 과 동일한 검사)를 통과하게 한다 — 다른 scope 테스트들과 같은 패턴.
      const providersWithProfile = {
        codex: codexAuthProvider(p, { withAppProfile: true }),
        claude: claudeAuthProvider(p, { withAppProfile: true }),
      };
      const accountsWithProfile = new AccountService({ db, secrets, paths: p, providers: providersWithProfile });
      await accountsWithProfile.saveCurrent('codex', 'personal');

      const profileSvc = new SwitchService({
        accounts: accountsWithProfile, db, providers: providersWithProfile, procs, prompts,
        backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
        closeTimeoutMs: 0,
        sleep: async () => {},
        launchTimeoutMs: 1000,
        pollMs: 100,
      });

      const r = await profileSvc.prepareNewLogin('codex');
      expect(r.status).toBe('ready');

      // 프로필 디렉터리(쿠키 등)까지 디스크에서 지워짐
      await expect(fs.stat(profileNetworkDir)).rejects.toThrow();
      expect(await exists(path.join(p.home, '.codex', 'auth.json'))).toBe(false);

      // ...하지만 백업에는 그 이전 내용이 남아 있음
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), secrets);
      const backed = await backups.load((r as { backupPath: string }).backupPath);
      expect(backed.replaceDirs.length).toBeGreaterThan(0);
      const cookieFile = backed.files.find((f) => f.relPath.endsWith('Network/Cookies'));
      expect(Buffer.from(cookieFile!.data!, 'base64').toString()).toBe('fake-cookie-data');
    });

    it('clears Claude credentials and oauthAccount/config.json token keys while keeping unrelated config keys', async () => {
      const desktopCfgPath = path.join(p.appData, 'Claude', 'config.json');
      await writeClaudeAuth(p, 'acct-A-claude', 'org-1', 'a@claude.com');
      await accounts.saveCurrent('claude', 'claudeA');
      const desktopCfg = JSON.parse(await fs.readFile(desktopCfgPath, 'utf8'));
      desktopCfg.someUnrelatedSetting = 'keep-me';
      await fs.writeFile(desktopCfgPath, JSON.stringify(desktopCfg));

      const r = await svc.prepareNewLogin('claude');
      expect(r.status).toBe('ready');

      expect(await exists(path.join(p.home, '.claude', '.credentials.json'))).toBe(false);
      const claudeCfg = JSON.parse(await fs.readFile(path.join(p.home, '.claude.json'), 'utf8'));
      expect(claudeCfg.oauthAccount).toBeUndefined();
      const desktopCfgAfter = JSON.parse(await fs.readFile(desktopCfgPath, 'utf8'));
      expect(desktopCfgAfter['oauth:tokenCache']).toBeUndefined();
      expect(desktopCfgAfter['oauth:tokenCacheV2']).toBeUndefined();
      expect(desktopCfgAfter.lastKnownAccountUuid).toBeUndefined();
      expect(desktopCfgAfter.someUnrelatedSetting).toBe('keep-me');
    });

    it('aborts without changes when the current login is unregistered and the user declines to save it', async () => {
      await writeCodexAuth(p, 'acct-C', 'c@x.com');
      prompts.confirmSaveUnknown.mockResolvedValue(null);
      const before = await authJson();
      const r = await svc.prepareNewLogin('codex');
      expect(r).toMatchObject({ status: 'aborted', reason: '현재 로그인을 먼저 저장해야 새 계정을 추가할 수 있습니다' });
      expect(await authJson()).toBe(before);
      expect(db.listAccounts('codex').map((a) => a.label)).toEqual(['work', 'personal']);
    });

    it('saves the current unregistered login under the confirmed label, then clears the auth files', async () => {
      await writeCodexAuth(p, 'acct-C', 'c@x.com');
      prompts.confirmSaveUnknown.mockResolvedValue('third');
      const r = await svc.prepareNewLogin('codex');
      expect(r.status).toBe('ready');
      expect(db.findAccountByLabel('codex', 'third')?.accountId).toBe('acct-C');
      expect(await exists(path.join(p.home, '.codex', 'auth.json'))).toBe(false);
    });

    it('has nothing to save when not logged in, but still clears (a no-op) and reports ready', async () => {
      await fs.rm(path.join(p.home, '.codex', 'auth.json'));
      const r = await svc.prepareNewLogin('codex');
      expect(r.status).toBe('ready');
      expect(db.listAccounts('codex').map((a) => a.label)).toEqual(['work', 'personal']);
    });

    it('rejects a second call while one is already in flight', async () => {
      let releaseGate: () => void = () => {};
      procs.listGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const first = svc.prepareNewLogin('codex');
      const second = await svc.prepareNewLogin('codex');
      expect(second).toMatchObject({ status: 'aborted' });
      expect((second as { reason: string }).reason).toContain('진행 중');
      releaseGate();
      const firstResult = await first;
      expect(firstResult.status).toBe('ready');
    });
  });

  it('includes --with-app-profile in the rollback-failure recovery hint when restoreHintFlags is set', async () => {
    const work = db.findAccountByLabel('codex', 'work')!;
    const personal = db.findAccountByLabel('codex', 'personal')!;
    const bBundle = await accounts.loadSnapshot(personal);
    await fs.writeFile(work.snapshotPath, await secrets.encrypt(serializeBundle(bBundle)));
    await writeCodexAuth(p, 'acct-B', 'b@x.com', 'current');

    const realCodex = codexAuthProvider(p);
    let writeCalls = 0;
    const flakyCodex = {
      ...realCodex,
      writeAuth: async (bundle: Parameters<typeof realCodex.writeAuth>[0]) => {
        writeCalls++;
        if (writeCalls === 2) throw new Error('EBUSY: file locked');
        return realCodex.writeAuth(bundle);
      },
    };
    const flakySvc = new SwitchService({
      accounts, db, providers: { codex: flakyCodex, claude: claudeAuthProvider(p) }, procs, prompts,
      backups: new BackupStore(path.join(p.appDataDir, 'backups'), secrets),
      closeTimeoutMs: 0,
      sleep: async () => {},
      restoreHintFlags: '--with-app-profile',
    });

    let caught: Error | undefined;
    try {
      await flakySvc.switchTo('codex', 'work');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('npm run cli -- restore codex "');
    expect(caught!.message).toContain('--with-app-profile');
  });

  describe('runWithAppStopped', () => {
    it('stops a running app, runs fn with it stopped, and relaunches it afterwards', async () => {
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
      let sawRunning: boolean | undefined;
      const r = await svc.runWithAppStopped('codex', async () => {
        const { appProcs } = classifyProcesses(await procs.list(), providers.codex.app);
        sawRunning = appProcs.length > 0;
        return 'the-value';
      });
      expect(sawRunning).toBe(false);
      expect(r).toMatchObject({ status: 'done', value: 'the-value' });
      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
    });

    it('does not relaunch when the app was not running beforehand', async () => {
      const r = await svc.runWithAppStopped('codex', async () => 'v');
      expect(r).toMatchObject({ status: 'done', value: 'v' });
      expect(procs.launched).toEqual([]);
    });

    it('relaunches the app and reports aborted with the error message when fn throws', async () => {
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
      const r = await svc.runWithAppStopped('codex', async () => {
        throw new Error('boom during migration write');
      });
      expect(r).toMatchObject({ status: 'aborted', reason: 'boom during migration write' });
      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
    });

    it('reports done with a launchWarning (not aborted) when fn succeeded but the relaunch throws', async () => {
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
      procs.launch = async () => {
        throw new Error('launch blocked');
      };
      const r = await svc.runWithAppStopped('codex', async () => 'written');
      expect(r).toMatchObject({ status: 'done', value: 'written' });
      expect((r as { launchWarning?: string }).launchWarning).toEqual(expect.stringContaining('launch blocked'));
    });

    it('keeps the fn error as the abort reason and turns a relaunch failure into launchWarning', async () => {
      procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
      procs.launch = async () => {
        throw new Error('launch blocked');
      };
      const r = await svc.runWithAppStopped('codex', async () => {
        throw new Error('boom during migration write');
      });
      expect(r).toMatchObject({ status: 'aborted', reason: 'boom during migration write' });
      expect((r as { launchWarning?: string }).launchWarning).toEqual(expect.stringContaining('launch blocked'));
    });

    it('rejects a concurrent call while one is already in flight', async () => {
      let releaseGate: () => void = () => {};
      procs.listGate = new Promise<void>((resolve) => { releaseGate = resolve; });

      const first = svc.runWithAppStopped('codex', async () => 'first'); // stuck inside stopApp() awaiting procs.list()
      const second = await svc.runWithAppStopped('codex', async () => 'second');
      expect(second).toMatchObject({ status: 'aborted' });
      expect((second as { reason: string }).reason).toContain('진행 중');

      releaseGate();
      const firstResult = await first;
      expect(firstResult).toMatchObject({ status: 'done', value: 'first' });
    });

    it('aborts without running fn when stray CLI processes exist and the user declines', async () => {
      procs.running = [{ pid: 20, name: 'codex', path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\codex.exe' }];
      prompts.confirmStrayCli.mockResolvedValue(false);
      let called = false;
      const r = await svc.runWithAppStopped('codex', async () => { called = true; return 'x'; });
      expect(r).toMatchObject({ status: 'aborted' });
      expect(called).toBe(false);
    });
  });
});
