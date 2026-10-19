import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createPrompter, type Prompter } from './prompter.js';
import type { ToolId } from '../main/core/auth-bundle.js';
import type { AccountRow } from '../main/infra/app-db.js';
import { AppDb } from '../main/infra/app-db.js';
import { BackupStore } from '../main/infra/backup-store.js';
import { acquireOpLock } from '../main/infra/op-lock.js';
import { migrateAppData } from '../main/infra/data-migration.js';
import { displayPath, systemPaths, type PathProvider } from '../main/infra/path-provider.js';
import { windowsProcessController } from '../main/infra/process-controller.js';
import { dpapiSecretStore, type SecretStore } from '../main/infra/secret-store.js';
import { claudeAuthProvider } from '../main/providers/claude/auth.js';
import { codexAuthProvider } from '../main/providers/codex/auth.js';
import { AccountService } from '../main/services/account-service.js';
import { type FolderCopyResult, ImportService, type ImportTarget, type InstructionsResult } from '../main/services/import-service.js';
import { LibraryService } from '../main/services/library-service.js';
import { SwitchService, type SwitchPrompts } from '../main/services/switch-service.js';

// 열: 도구·라벨·이메일·상태·범위(auth | auth+app-profile)·저장 시각·경로.
// list 출력의 마지막 칸에 스냅샷 파일 경로를 남겨서, appDataDir 을 뒤져볼 때 .prev.bin 을 어떤 라벨의
// 것인지 알 수 있게 한다.
export function formatAccountRow(a: AccountRow): string {
  return [a.tool, a.label, a.email ?? '-', a.status, a.scope, a.snapshotAt, a.snapshotPath].join('\t');
}

// list 끝에 붙이는 '# ' 접두 안내 줄 — 어느 폴더를 쓰는지 보이게 해서 경로 혼동을 바로 알아채게 한다 (홈은 ~ 로 줄임).
export function formatPathLines(paths: PathProvider): string[] {
  return [
    `# 앱 데이터: ${displayPath(paths.appDataDir, paths.home)}`,
    `# Claude Desktop: ${displayPath(paths.claudeDesktop, paths.home)}`,
  ];
}

// sessions 명령 출력 한 줄 — 검증용이라 원문 대신 제목 앞 40자만 보여준다. 제목은 첫 사용자 메시지에서
// 뽑히는 경우가 있어 개행/탭을 포함할 수 있으므로, 한 줄짜리 탭 구분 출력이 깨지지 않도록 공백으로 접는다.
export function formatSessionRow(s: { key: string; title: string; updatedAt: number; hasTranscript: boolean }): string {
  const oneLine = s.title.replace(/\s+/g, ' ').trim();
  const title40 = oneLine.length > 40 ? oneLine.slice(0, 40) : oneLine;
  return [s.key, title40, new Date(s.updatedAt).toISOString(), String(s.hasTranscript)].join('\t');
}

function makePrompts(prompter: Prompter): SwitchPrompts {
  return {
    async confirmKill(procs) {
      const a = await prompter.ask(`앱이 종료되지 않았습니다 (${procs.length}개 프로세스). 강제 종료할까요? [y/N] `);
      return a?.trim().toLowerCase() === 'y';
    },
    async confirmSaveUnknown(id) {
      const a = await prompter.ask(`현재 로그인(${id.email ?? id.accountId})은 미등록입니다. 저장할 라벨(엔터=저장 안 함): `);
      return a?.trim() || null;
    },
    async confirmStrayCli(procs) {
      const list = procs.map((p) => `${p.name}(${p.pid})`).join(', ');
      const a = await prompter.ask(`독립 실행 CLI 가 실행 중입니다 — ${list}. 전환 후 이 CLI 가 이전 계정 토큰을 덮어쓸 수 있습니다. 그래도 진행할까요? [y/N] `);
      return a?.trim().toLowerCase() === 'y';
    },
  };
}

const USAGE = `사용법:
  npm run cli -- list
  npm run cli -- current <codex|claude>
  npm run cli -- save <codex|claude> <라벨>
  npm run cli -- switch <codex|claude> <라벨>
  npm run cli -- restore <codex|claude> <backup.bin 경로>
  npm run cli -- rename <codex|claude> <라벨> <새라벨>
  npm run cli -- delete <codex|claude> <라벨>
  npm run cli -- add <codex|claude>                     로그아웃 없이 새 계정 추가 준비
  npm run cli -- sessions <codex|claude> [--all]        세션 목록 (검증용): 키·제목 앞 40자·갱신일·대화기록 유무
  npm run cli -- import <codex|claude> <키...> --to <codex|claude> [--account <라벨>] [--copy] [--copy-instructions] [--copy-folder] [--full-tool-log]
                                                         세션을 다른 도구/계정으로 이관 (Claude 대상 라벨 생략 시 현재 로그인 계정)
옵션:
  --with-app-profile   Electron 프로필(쿠키/Local Storage)까지 스냅샷·교체 (검증 V2/V3 용)
                        (--with-app-profile 는 save 때 정한 범위를 switch 때도 동일하게 지정해야 함)
  --all                (sessions) 보관됨·서브에이전트 세션도 포함
  --to <codex|claude>  (import) 이관 대상 도구
  --account <라벨>     (import) Claude 대상 계정 라벨 — 생략하면 현재 로그인 계정
  --copy               (import) 이미 이관한 세션이어도 새 복사본을 만듦 (기본은 건너뜀)
  --copy-instructions  (import) 대상 cwd 와 그 아래 2단계 폴더(하위 저장소)에 지침 파일도 만듦 (AGENTS.md ↔ CLAUDE.md, 이미 있으면 그대로 둠)
  --copy-folder        (import) Codex→Claude: GPT 대화 폴더(문서/Codex/날짜/이름)를 문서/Claude/… 로 복사해 새 세션이 따로 씀
  --full-tool-log      (import) 도구 실행 기록을 입력·출력까지 모두 옮김 (기본은 실행한 명령 한 줄씩 + 실패한 출력 앞부분)`;

const KNOWN_FLAGS = new Set(['--with-app-profile']);

function parseTool(v: string | undefined): ToolId {
  if (v === 'codex' || v === 'claude') return v;
  throw new Error(`도구는 codex 또는 claude\n\n${USAGE}`);
}

function parseSessionsArgs(rest: string[]): { tool: ToolId; all: boolean } {
  let all = false;
  const positional: string[] = [];
  for (const a of rest) {
    if (a === '--all') {
      all = true;
      continue;
    }
    if (a.startsWith('--')) throw new Error(`알 수 없는 옵션: ${a}\n\n${USAGE}`);
    positional.push(a);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { tool: parseTool(positional[0]), all };
}

interface ImportArgs {
  srcTool: ToolId;
  keys: string[];
  to: ToolId;
  account?: string;
  copy: boolean;
  copyInstructions: boolean;
  copyWorkFolder: boolean;
  fullToolLog: boolean;
}

// 값을 갖는 옵션(--to/--account) 뒤에 값이 없거나(마지막 토큰) 다음 '--옵션' 이 바로 오면(값을 빼먹은 것)
// 명확한 오류로 거부한다 — 그렇지 않으면 예를 들어 '--to --copy' 가 to='--copy' 로 조용히 들어가 버린다.
function requireFlagValue(rest: string[], i: number, flag: string): string {
  const value = rest[i];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 뒤에 값이 필요합니다\n\n${USAGE}`);
  return value;
}

// 키 목록의 개수를 미리 알 수 없으므로(가변 길이), '--' 로 시작하는 토큰이 나오기 전까지를 키로 모으고
// 그 뒤를 옵션으로 파싱한다 — 기존 명령들의 '먼저 걸러내고 위치 인자로 읽는' 방식으로는 표현할 수 없다.
export function parseImportArgs(rest: string[]): ImportArgs {
  if (rest.length === 0) throw new Error(USAGE);
  const srcTool = parseTool(rest[0]);
  const keys: string[] = [];
  let i = 1;
  while (i < rest.length && !rest[i]!.startsWith('--')) {
    keys.push(rest[i]!);
    i++;
  }
  let to: string | undefined;
  let account: string | undefined;
  let copy = false;
  let copyInstructions = false;
  let copyWorkFolder = false;
  let fullToolLog = false;
  while (i < rest.length) {
    const flag = rest[i]!;
    if (flag === '--to') {
      to = requireFlagValue(rest, i + 1, flag);
      i += 2;
    } else if (flag === '--account') {
      account = requireFlagValue(rest, i + 1, flag);
      i += 2;
    } else if (flag === '--copy') {
      copy = true;
      i += 1;
    } else if (flag === '--copy-instructions') {
      copyInstructions = true;
      i += 1;
    } else if (flag === '--copy-folder') {
      copyWorkFolder = true;
      i += 1;
    } else if (flag === '--full-tool-log') {
      fullToolLog = true;
      i += 1;
    } else {
      throw new Error(`알 수 없는 옵션: ${flag}\n\n${USAGE}`);
    }
  }
  if (keys.length === 0) throw new Error(`가져올 세션 키가 최소 1개 필요합니다\n\n${USAGE}`);
  if (keys.length > 200) throw new Error('세션은 한 번에 최대 200개까지 가져올 수 있습니다');
  if (to !== 'codex' && to !== 'claude') throw new Error(`--to 는 codex 또는 claude 이어야 합니다\n\n${USAGE}`);
  return { srcTool, keys, to, account, copy, copyInstructions, copyWorkFolder, fullToolLog };
}

async function runSessions(rest: string[], paths: PathProvider, db: AppDb): Promise<void> {
  const { tool, all } = parseSessionsArgs(rest);
  const library = new LibraryService({ paths, db });
  const { projects } = library.list(tool, { includeArchived: all, includeSubagents: all });
  const sessions = projects.flatMap((p) => p.sessions).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sessions) {
    console.log(formatSessionRow({ key: s.key, title: s.title, updatedAt: s.updatedAt, hasTranscript: s.file !== '' }));
  }
}

const IMPORT_STATUS_LABEL: Record<string, string> = { imported: '가져옴', forked: '공유됨', skipped: '건너뜀', failed: '실패' };

export function formatInstructions(r: InstructionsResult): string {
  if (r.status === 'created') return `${r.path} 생성`;
  if (r.status === 'exists') return `${r.path} 이미 있음`;
  return `${r.path} 건너뜀${r.reason ? ` (${r.reason})` : ''}`;
}

export function formatFolderCopy(r: FolderCopyResult): string {
  if (r.status === 'copied') return `${r.from} → ${r.to} 복사`;
  if (r.status === 'reused') return `${r.to} (앞 세션과 같은 복사본)`;
  return `복사 ${r.status === 'failed' ? '실패' : '건너뜀'}${r.reason ? ` (${r.reason})` : ''} — 원래 폴더 ${r.from} 를 씀`;
}

async function runImport(rest: string[], paths: PathProvider, db: AppDb, secrets: SecretStore): Promise<void> {
  const { srcTool, keys, to, account, copy, copyInstructions, copyWorkFolder, fullToolLog } = parseImportArgs(rest);
  const providers = { codex: codexAuthProvider(paths), claude: claudeAuthProvider(paths) };
  const accounts = new AccountService({ db, secrets, paths, providers });
  const library = new LibraryService({ paths, db });

  let target: ImportTarget;
  if (to === 'codex') {
    target = { tool: 'codex' };
  } else if (account) {
    const row = db.findAccountByLabel('claude', account);
    if (!row) throw new Error(`등록된 Claude 계정 '${account}' 를 찾을 수 없습니다`);
    target = { tool: 'claude', account: { accountId: row.accountId, orgId: row.orgId } };
  } else {
    const identity = providers.claude.identityOf(await providers.claude.readCurrentAuth());
    target = { tool: 'claude', account: { accountId: identity.accountId, orgId: identity.orgId ?? '' } };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompter = createPrompter(rl);
  try {
    const switcher = new SwitchService({
      accounts,
      db,
      providers,
      procs: windowsProcessController(),
      backups: new BackupStore(path.join(paths.appDataDir, 'backups'), secrets),
      prompts: makePrompts(prompter),
      autoKill: true,
      closeTimeoutMs: 3000,
      onProgress: (step) => console.log(`  · ${step}`),
    });
    const importSvc = new ImportService({ paths, db, library, switcher, backupsDir: path.join(paths.appDataDir, 'backups') });
    const r = await importSvc.run(srcTool, keys, target, copy ? 'copy' : 'skip', undefined, { copyInstructions, copyWorkFolder, fullToolLog });
    if (r.status === 'aborted') {
      console.log(`취소: ${r.reason}`);
      return;
    }
    for (const item of r.results) {
      const label = IMPORT_STATUS_LABEL[item.status] ?? item.status;
      console.log(`${item.key}\t${label}${item.reason ? `\t${item.reason}` : ''}`);
      if (item.instructions) console.log(`  지침: ${formatInstructions(item.instructions)}`);
      for (const sub of item.subInstructions ?? []) console.log(`  지침: ${formatInstructions(sub)}`);
      if (item.folderCopy) console.log(`  작업 폴더: ${formatFolderCopy(item.folderCopy)}`);
    }
    if (r.launchWarning) console.log(`경고: ${r.launchWarning}`);
  } finally {
    prompter.dispose();
    rl.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd0 = argv[0];

  // sessions/import 는 --to/--account 처럼 값을 갖는 옵션과 가변 길이 키 목록을 함께 받으므로, 아래의
  // '알 수 없는 --옵션 이면 거부 → -- 로 시작 안 하는 토큰만 위치 인자로 취급'하는 방식으로는 못 다룬다 —
  // 그래서 이 두 명령은 각자 파서(parseSessionsArgs/parseImportArgs)로 raw argv 를 직접 파싱한다.
  if (cmd0 === 'sessions' || cmd0 === 'import') {
    const paths = systemPaths();
    await migrateAppData(paths, (line) => console.log(line));
    await fs.mkdir(paths.appDataDir, { recursive: true });
    const db = new AppDb(path.join(paths.appDataDir, 'app.db'));
    let release: (() => Promise<void>) | undefined;
    try {
      if (cmd0 === 'sessions') {
        await runSessions(argv.slice(1), paths, db);
      } else {
        release = await acquireOpLock(paths.appDataDir, 'import');
        await runImport(argv.slice(1), paths, db, dpapiSecretStore());
      }
    } finally {
      await release?.();
      db.close();
    }
    return;
  }

  for (const a of argv) {
    if (a.startsWith('--') && !KNOWN_FLAGS.has(a)) {
      console.error(`알 수 없는 옵션: ${a}\n\n${USAGE}`);
      process.exitCode = 1;
      return;
    }
  }
  const args = argv.filter((a) => !a.startsWith('--'));
  const withAppProfile = argv.includes('--with-app-profile');
  const [cmd, toolArg, label, newLabel] = args;

  if (
    cmd !== 'list' &&
    cmd !== 'current' &&
    cmd !== 'save' &&
    cmd !== 'switch' &&
    cmd !== 'restore' &&
    cmd !== 'rename' &&
    cmd !== 'delete' &&
    cmd !== 'add'
  ) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const paths = systemPaths();
  await migrateAppData(paths, (line) => console.log(line));
  await fs.mkdir(paths.appDataDir, { recursive: true });
  const db = new AppDb(path.join(paths.appDataDir, 'app.db'));
  const secrets = dpapiSecretStore();
  const providers = {
    codex: codexAuthProvider(paths, { withAppProfile }),
    claude: claudeAuthProvider(paths, { withAppProfile }),
  };
  const accounts = new AccountService({ db, secrets, paths, providers });

  let release: (() => Promise<void>) | undefined;
  try {
    if (cmd !== 'list' && cmd !== 'current') release = await acquireOpLock(paths.appDataDir, cmd);
    switch (cmd) {
      case 'list': {
        for (const a of accounts.list()) {
          console.log(formatAccountRow(a));
        }
        for (const line of formatPathLines(paths)) console.log(line);
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
        const prompter = createPrompter(rl);
        try {
          const svc = new SwitchService({
            accounts,
            db,
            providers,
            procs: windowsProcessController(),
            backups: new BackupStore(path.join(paths.appDataDir, 'backups'), secrets),
            prompts: makePrompts(prompter),
            restoreHintFlags: withAppProfile ? '--with-app-profile' : undefined,
            autoKill: true,
            closeTimeoutMs: 3000,
            onProgress: (step) => console.log(`  · ${step}`),
          });
          const r = await svc.switchTo(tool, label);
          if (r.status === 'switched') {
            console.log(`전환 완료: ${r.account.label} (${r.account.email ?? r.account.accountId})`);
            if (r.notice) console.log(`안내: ${r.notice}`);
          } else if (r.status === 'aborted') console.log(`취소: ${r.reason}`);
          else console.log(`롤백됨: ${r.reason}\n백업: ${r.backupPath}`);
          if (r.launchWarning) console.log(`경고: ${r.launchWarning}`);
        } finally {
          prompter.dispose();
          rl.close();
        }
        return;
      }
      case 'restore': {
        const tool = parseTool(toolArg);
        if (!label) throw new Error(USAGE);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const prompter = createPrompter(rl);
        try {
          const svc = new SwitchService({
            accounts,
            db,
            providers,
            procs: windowsProcessController(),
            backups: new BackupStore(path.join(paths.appDataDir, 'backups'), secrets),
            prompts: makePrompts(prompter),
            autoKill: true,
            closeTimeoutMs: 3000,
            onProgress: (step) => console.log(`  · ${step}`),
          });
          const r = await svc.restoreBackup(tool, label);
          if (r.status === 'restored') console.log(`복원 완료 (복원 직전 상태 백업: ${r.backupPath})`);
          else console.log(`취소: ${r.reason}`);
          if (r.launchWarning) console.log(`경고: ${r.launchWarning}`);
        } finally {
          prompter.dispose();
          rl.close();
        }
        return;
      }
      case 'rename': {
        const tool = parseTool(toolArg);
        if (!label || !newLabel) throw new Error(USAGE);
        const updated = await accounts.rename(tool, label, newLabel);
        console.log(`이름 변경: '${label}' → '${updated.label}'`);
        return;
      }
      case 'delete': {
        const tool = parseTool(toolArg);
        if (!label) throw new Error(USAGE);
        await accounts.remove(tool, label);
        console.log(`삭제: ${label}`);
        return;
      }
      case 'add': {
        const tool = parseTool(toolArg);
        if (withAppProfile) {
          console.log(
            "'--with-app-profile' 가 켜져 있어 앱의 쿠키·로컬 저장소(Network, Local State, Local Storage)도 비워집니다. 기존 상태는 백업과 계정 스냅샷에 남습니다.",
          );
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const prompter = createPrompter(rl);
        try {
          const svc = new SwitchService({
            accounts,
            db,
            providers,
            procs: windowsProcessController(),
            backups: new BackupStore(path.join(paths.appDataDir, 'backups'), secrets),
            prompts: makePrompts(prompter),
            restoreHintFlags: withAppProfile ? '--with-app-profile' : undefined,
            autoKill: true,
            closeTimeoutMs: 3000,
            onProgress: (step) => console.log(`  · ${step}`),
          });
          const r = await svc.prepareNewLogin(tool);
          if (r.status === 'ready') {
            console.log(`백업: ${r.backupPath}`);
            if (r.notice) console.log(`안내: ${r.notice}`);
            console.log(`앱에서 새 계정으로 로그인한 뒤 \`npm run cli -- save ${tool} <라벨>\` 을 실행하세요`);
          } else {
            console.log(`취소: ${r.reason}`);
          }
          if (r.launchWarning) console.log(`경고: ${r.launchWarning}`);
        } finally {
          prompter.dispose();
          rl.close();
        }
        return;
      }
    }
  } finally {
    await release?.();
    db.close();
  }
}

// 이 파일이 직접 실행됐을 때만 main() 을 돌린다 — 테스트처럼 모듈로 import 될 때 실제 %APPDATA%
// 등 진짜 머신을 건드리지 않도록 하기 위함.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
