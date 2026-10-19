import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolId } from '../main/core/auth-bundle.js';
import { truncate, type IrBlock, type IrMessage } from '../main/core/ir.js';
import type { AccountRow, AppDb } from '../main/infra/app-db.js';
import { readAppIcon } from '../main/infra/app-icons.js';
import { BackupStore } from '../main/infra/backup-store.js';
import { acquireOpLock } from '../main/infra/op-lock.js';
import { displayPath, type PathProvider } from '../main/infra/path-provider.js';
import type { ProcessController } from '../main/infra/process-controller.js';
import type { SecretStore } from '../main/infra/secret-store.js';
import type { ToolAuthProvider } from '../main/providers/types.js';
import { AccountService } from '../main/services/account-service.js';
import { ImportService, type DuplicatePolicy, type ImportTarget } from '../main/services/import-service.js';
import { LibraryService, type LibrarySession } from '../main/services/library-service.js';
import { SwitchService, type SwitchPrompts } from '../main/services/switch-service.js';

const TOOLS: ToolId[] = ['codex', 'claude'];

export type PromptKind = 'confirmKill' | 'confirmSaveUnknown' | 'confirmStrayCli';

export interface RpcDeps {
  paths: PathProvider;
  db: AppDb;
  secrets: SecretStore;
  procs: ProcessController;
  makeProviders(withAppProfile: boolean): Record<ToolId, ToolAuthProvider>;
  prompt(kind: PromptKind, data: unknown): Promise<unknown>;
  readAppIcon?: (packageFamilyName: string) => Promise<string | null>; // 테스트 주입용 — 기본은 설치된 앱에서 읽기
}

export type ToolCurrent = { email?: string; accountId: string; registeredLabel?: string } | { error: string };

export interface StateResult {
  tools: Record<ToolId, { current: ToolCurrent }>;
  accounts: AccountRow[];
  paths: { appDataDir: string; claudeDesktop: string }; // 홈 폴더는 ~ 로 줄여 표시
}

export interface HandlerContext {
  progress(step: string): void;
}

export interface Handlers {
  handle(method: string, params: unknown, ctx?: HandlerContext): Promise<unknown>;
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error('params 는 객체여야 합니다');
  return v as Record<string, unknown>;
}

function parseTool(v: unknown): ToolId {
  if (v === 'codex' || v === 'claude') return v;
  throw new Error('tool 은 codex 또는 claude 이어야 합니다');
}

function parseLabel(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) {
    throw new Error('label 은 1~64자 문자열이어야 합니다');
  }
  return v;
}

function parseOptionalString(v: unknown, maxLen: number, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > maxLen) throw new Error(`${field} 는 ${maxLen}자 이하 문자열이어야 합니다`);
  return v;
}

function parseOptionalBoolean(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${field} 는 boolean 이어야 합니다`);
  return v;
}

function parseKey(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 300) throw new Error('key 는 1~300자 문자열이어야 합니다');
  return v;
}

function parseImportKeys(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) throw new Error('keys 는 1~200개의 배열이어야 합니다');
  return v.map((k) => parseKey(k));
}

function parsePolicy(v: unknown): DuplicatePolicy {
  if (v === 'skip' || v === 'copy') return v;
  throw new Error("policy 는 'skip' 또는 'copy' 이어야 합니다");
}

function parseFlag(v: unknown, name: string): boolean {
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  throw new Error(`${name} 는 true/false 이어야 합니다`);
}

// target.accountKey 는 'acct:<rowId>'(등록된 Claude 계정) 또는 'current'(현재 로그인된 Claude 신원)이다 —
// 둘 다 실제로 존재/로그인 여부를 검증한 뒤에야 ImportTarget 으로 만든다.
async function parseImportTarget(v: unknown, db: AppDb, claudeProvider: ToolAuthProvider): Promise<ImportTarget> {
  const rec = asRecord(v);
  const tool = parseTool(rec.tool);
  if (tool === 'codex') return { tool: 'codex' };

  const accountKey = rec.accountKey;
  if (typeof accountKey !== 'string' || accountKey.length === 0) {
    throw new Error("target.accountKey 가 필요합니다 ('acct:<id>' 또는 'current')");
  }
  if (accountKey === 'current') {
    const identity = claudeProvider.identityOf(await claudeProvider.readCurrentAuth());
    return { tool: 'claude', account: { accountId: identity.accountId, orgId: identity.orgId ?? '' } };
  }
  const m = /^acct:(\d+)$/.exec(accountKey);
  if (!m) throw new Error("target.accountKey 형식이 올바르지 않습니다 ('acct:<id>' 또는 'current')");
  const row = db.findAccountById(Number(m[1]));
  if (!row || row.tool !== 'claude') throw new Error('등록된 Claude 계정을 찾을 수 없습니다');
  return { tool: 'claude', account: { accountId: row.accountId, orgId: row.orgId } };
}

// 렌더러에는 원본 파일 경로 대신 대화 기록 유무만 보낸다.
function toLibrarySessionView(s: LibrarySession): Omit<LibrarySession, 'file'> & { hasTranscript: boolean } {
  const { file, ...rest } = s;
  return { ...rest, hasTranscript: file !== '' };
}

export function createHandlers(deps: RpcDeps): Handlers {
  let mutating = false;
  const library = new LibraryService({ paths: deps.paths, db: deps.db });

  async function withLock<T>(op: string, fn: () => Promise<T>): Promise<T> {
    if (mutating) throw new Error('다른 작업이 진행 중입니다');
    mutating = true;
    try {
      const release = await acquireOpLock(deps.paths.appDataDir, op);
      try {
        return await fn();
      } finally {
        await release();
      }
    } finally {
      mutating = false;
    }
  }

  function makePrompts(): SwitchPrompts {
    return {
      confirmKill: async (procs) => Boolean(await deps.prompt('confirmKill', procs)),
      confirmSaveUnknown: async (identity) => {
        const answer = await deps.prompt('confirmSaveUnknown', identity);
        return typeof answer === 'string' && answer.length > 0 ? answer : null;
      },
      confirmStrayCli: async (procs) => Boolean(await deps.prompt('confirmStrayCli', procs)),
    };
  }

  function backupsDirPath(): string {
    return path.join(deps.paths.appDataDir, 'backups');
  }

  async function parseBackupFile(v: unknown): Promise<string> {
    if (typeof v !== 'string' || v.length === 0) throw new Error('file 이 필요합니다');
    const resolved = path.resolve(v);
    const root = path.resolve(deps.paths.appDataDir) + path.sep;
    if (!resolved.startsWith(root)) throw new Error('허용되지 않은 파일 경로입니다');
    if (path.extname(resolved).toLowerCase() !== '.bin') throw new Error('.bin 파일만 허용됩니다');
    const st = await fs.stat(resolved).catch(() => undefined);
    if (!st || !st.isFile()) throw new Error('파일을 찾을 수 없습니다');
    return resolved;
  }

  function accountServiceFor(providers: Record<ToolId, ToolAuthProvider>): AccountService {
    return new AccountService({ db: deps.db, secrets: deps.secrets, paths: deps.paths, providers });
  }

  function switchServiceFor(providers: Record<ToolId, ToolAuthProvider>, withAppProfile: boolean, ctx?: HandlerContext): SwitchService {
    return new SwitchService({
      accounts: accountServiceFor(providers),
      db: deps.db,
      providers,
      procs: deps.procs,
      backups: new BackupStore(backupsDirPath(), deps.secrets),
      prompts: makePrompts(),
      restoreHintFlags: withAppProfile ? '--with-app-profile' : undefined,
      autoKill: true,
      closeTimeoutMs: 3000,
      onProgress: ctx ? (step) => ctx.progress(step) : undefined,
    });
  }

  async function state(): Promise<StateResult> {
    const providers = deps.makeProviders(false);
    const tools = {} as Record<ToolId, { current: ToolCurrent }>;
    for (const tool of TOOLS) {
      try {
        const bundle = await providers[tool].readCurrentAuth();
        const id = providers[tool].identityOf(bundle);
        const known = deps.db.findAccountByIdentity(tool, id.accountId, id.orgId ?? '');
        tools[tool] = {
          current: {
            ...(id.email ? { email: id.email } : {}),
            accountId: id.accountId,
            ...(known ? { registeredLabel: known.label } : {}),
          },
        };
      } catch (e) {
        tools[tool] = { current: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    return {
      tools,
      accounts: deps.db.listAccounts(),
      paths: {
        appDataDir: displayPath(deps.paths.appDataDir, deps.paths.home),
        claudeDesktop: displayPath(deps.paths.claudeDesktop, deps.paths.home),
      },
    };
  }

  async function save(paramsRaw: unknown): Promise<{ created: boolean; label: string }> {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const label = parseLabel(params.label);
    const providers = deps.makeProviders(Boolean(params.withAppProfile));
    const { row, created } = await accountServiceFor(providers).saveCurrent(tool, label);
    return { created, label: row.label };
  }

  async function doSwitch(paramsRaw: unknown, ctx?: HandlerContext) {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const label = parseLabel(params.label);
    const withAppProfile = Boolean(params.withAppProfile);
    const providers = deps.makeProviders(withAppProfile);
    return switchServiceFor(providers, withAppProfile, ctx).switchTo(tool, label);
  }

  async function addAccount(paramsRaw: unknown, ctx?: HandlerContext) {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const withAppProfile = Boolean(params.withAppProfile);
    const providers = deps.makeProviders(withAppProfile);
    return switchServiceFor(providers, withAppProfile, ctx).prepareNewLogin(tool);
  }

  async function rename(paramsRaw: unknown): Promise<{ label: string }> {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const label = parseLabel(params.label);
    const newLabel = parseLabel(params.newLabel);
    const row = await accountServiceFor(deps.makeProviders(false)).rename(tool, label, newLabel);
    return { label: row.label };
  }

  async function removeAccount(paramsRaw: unknown): Promise<{ deleted: true }> {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const label = parseLabel(params.label);
    await accountServiceFor(deps.makeProviders(false)).remove(tool, label);
    return { deleted: true };
  }

  async function restore(paramsRaw: unknown, ctx?: HandlerContext) {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const file = await parseBackupFile(params.file);
    const withAppProfile = Boolean(params.withAppProfile);
    const providers = deps.makeProviders(withAppProfile);
    return switchServiceFor(providers, withAppProfile, ctx).restoreBackup(tool, file);
  }

  function libraryList(paramsRaw: unknown) {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const account = parseOptionalString(params.account, 200, 'account');
    const includeSubagents = parseOptionalBoolean(params.includeSubagents, 'includeSubagents');
    const includeArchived = parseOptionalBoolean(params.includeArchived, 'includeArchived');
    const { accounts, projects, imported } = library.list(tool, { account, includeSubagents, includeArchived });
    return { accounts, projects: projects.map((p) => ({ ...p, sessions: p.sessions.map(toLibrarySessionView) })), imported };
  }

  const MAX_LIBRARY_BLOCKS = 2000;

  async function librarySession(paramsRaw: unknown) {
    const params = asRecord(paramsRaw);
    const tool = parseTool(params.tool);
    const key = parseKey(params.key);
    const s = await library.read(tool, key);
    const clip = (b: IrBlock): IrBlock => (b.kind === 'text' || b.kind === 'compactSummary' ? { ...b, text: truncate(b.text, 8000) } : b);

    const sliced = s.messages.slice(0, 300);
    const messages: IrMessage[] = [];
    let blockCount = 0;
    let blocksTruncated = false;
    for (const m of sliced) {
      if (blockCount >= MAX_LIBRARY_BLOCKS) { blocksTruncated = true; break; }
      const blocks = m.blocks.slice(0, MAX_LIBRARY_BLOCKS - blockCount).map(clip);
      if (blocks.length < m.blocks.length) blocksTruncated = true;
      blockCount += blocks.length;
      messages.push({ ...m, blocks });
    }

    return { session: { ...s, messages }, messagesTruncated: s.messages.length > 300, blocksTruncated };
  }

  // 이관 쓰기는 switchServiceFor 를 그대로 재사용해 대상 앱 종료/재실행/동시실행 방지·진행 이벤트 전달을
  // 얻는다 — 앱 프로필 범위는 이관과 무관하므로 항상 withAppProfile=false 로 provider 를 만든다.
  async function importSessions(paramsRaw: unknown, ctx?: HandlerContext) {
    const params = asRecord(paramsRaw);
    const srcTool = parseTool(params.srcTool);
    const keys = parseImportKeys(params.keys);
    const policy = parsePolicy(params.policy);
    const copyInstructions = parseFlag(params.copyInstructions, 'copyInstructions');
    const copyWorkFolder = parseFlag(params.copyWorkFolder, 'copyWorkFolder');
    const fullToolLog = parseFlag(params.fullToolLog, 'fullToolLog');
    const providers = deps.makeProviders(false);
    const target = await parseImportTarget(params.target, deps.db, providers.claude);
    const switcher = switchServiceFor(providers, false, ctx);
    const importer = new ImportService({ paths: deps.paths, db: deps.db, library, switcher, backupsDir: backupsDirPath() });
    return importer.run(srcTool, keys, target, policy, undefined, { copyInstructions, copyWorkFolder, fullToolLog });
  }

  // 앱 아이콘은 설치 위치 조회(PowerShell)가 느리므로 처음 한 번만 읽어 둔다. 앱 AUMID 의 '!' 앞이 패키지 패밀리 이름.
  let iconsOnce: Promise<Record<ToolId, string | null>> | undefined;
  function appIcons() {
    const read = deps.readAppIcon ?? ((family: string) => readAppIcon(family));
    iconsOnce ??= (async () => {
      const providers = deps.makeProviders(false);
      const entries = await Promise.all(TOOLS.map(async (t) => [t, await read(providers[t].app.aumid.split('!')[0]!)] as const));
      return Object.fromEntries(entries) as Record<ToolId, string | null>;
    })();
    return iconsOnce;
  }

  function importHistory(paramsRaw: unknown) {
    const params = asRecord(paramsRaw);
    const srcTool = parseTool(params.srcTool);
    const key = parseKey(params.key);
    return { imports: deps.db.findImportsBySource(srcTool, key) };
  }

  return {
    async handle(method: string, params: unknown, ctx?: HandlerContext): Promise<unknown> {
      switch (method) {
        case 'state':
          return state();
        case 'backupsDir':
          return backupsDirPath();
        case 'save':
          return withLock('save', () => save(params));
        case 'switch':
          return withLock('switch', () => doSwitch(params, ctx));
        case 'restore':
          return withLock('restore', () => restore(params, ctx));
        case 'addAccount':
          return withLock('addAccount', () => addAccount(params, ctx));
        case 'rename':
          return withLock('rename', () => rename(params));
        case 'delete':
          return withLock('delete', () => removeAccount(params));
        case 'libraryList':
          return libraryList(params);
        case 'librarySession':
          return librarySession(params);
        case 'importSessions':
          return withLock('importSessions', () => importSessions(params, ctx));
        case 'importHistory':
          return importHistory(params);
        case 'appIcons':
          return appIcons();
        default:
          throw new Error(`알 수 없는 메서드: ${method}`);
      }
    },
  };
}
