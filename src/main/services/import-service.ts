import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolId } from '../core/auth-bundle.js';
import type { ToolLogMode } from '../core/render.js';
import { withRepoStatus, type RepoStatus, type WorkspaceScan } from '../core/repo-status.js';
import { normalizeWinPath } from '../core/win-path.js';
import { claudeCopyOf, pickClaudeCwd, withCopiedFolder, withRebasedFolder } from '../core/work-folder.js';
import type { AppDb } from '../infra/app-db.js';
import { FsTransaction, pruneBackups } from '../infra/fs-transaction.js';
import type { PathProvider } from '../infra/path-provider.js';
import { canonicalPath } from '../infra/real-path.js';
import { gitStatusLines, scanWorkspace } from '../infra/workspace-scan.js';
import { listClaudeSessions } from '../providers/claude/sessions.js';
import { forkClaudeSession, requireClaudeTemplate, writeClaudeSession } from '../providers/claude/writer.js';
import { writeCodexSession } from '../providers/codex/writer.js';
import type { SessionSummary } from '../providers/types.js';
import type { LibraryService } from './library-service.js';
import type { SwitchService } from './switch-service.js';

const BACKUP_KEEP = 50;

export type ImportTarget =
  | { tool: 'claude'; account: { accountId: string; orgId: string } } // Codex→Claude, Claude→Claude(포크)
  | { tool: 'codex' }; // Claude→Codex
export type DuplicatePolicy = 'skip' | 'copy';
export interface ImportOptions {
  copyInstructions?: boolean; // AGENTS.md ↔ CLAUDE.md 지침 파일 복사 (기본 꺼짐)
  copyWorkFolder?: boolean; // Codex→Claude: GPT 대화 폴더를 복사해 새 세션이 따로 쓰게 함 (기본 꺼짐)
  fullToolLog?: boolean; // 도구 실행 기록을 입력·출력까지 모두 옮김 (기본은 한 줄 요약 + 실패 출력만)
}
// copied: 복사함, reused: 같은 실행에서 앞 세션이 만든 복사본을 같이 씀, skipped/failed: 복사하지 않고 원래 폴더를 씀
export interface FolderCopyResult {
  from: string;
  to?: string;
  status: 'copied' | 'reused' | 'skipped' | 'failed';
  reason?: string;
}
export interface InstructionsResult {
  path: string;
  status: 'created' | 'exists' | 'skipped';
  reason?: string;
}
export interface ImportItemResult {
  key: string;
  status: 'imported' | 'forked' | 'skipped' | 'failed';
  reason?: string;
  dstSessionId?: string;
  instructions?: InstructionsResult;
  subInstructions?: InstructionsResult[]; // 하위 폴더(예: 하위 저장소)에 맞춘 지침 파일 — 원본 지침 파일이 있는 곳만
  folderCopy?: FolderCopyResult;
}

export interface ImportServiceDeps {
  paths: PathProvider;
  db: AppDb;
  library: LibraryService;
  switcher: SwitchService;
  backupsDir: string;
  now?: () => Date;
  repoStatus?: (dir: string) => Promise<string[] | undefined>; // 테스트 주입용 — 기본은 git status
}

// 한 번의 가져오기 동안 폴더마다 한 번만 훑고 git 상태를 읽는다 — 같은 폴더의 세션 여러 개를 옮길 때.
interface RunCache {
  scan(dir: string): Promise<WorkspaceScan>;
  status(dir: string): Promise<RepoStatus[]>;
  claudeCwd(cwd: string): string;
}

const dstAccountKeyOf = (target: ImportTarget): string => (target.tool === 'claude' ? `${target.account.accountId}/${target.account.orgId}` : '');
const folderKey = (dir: string) => path.resolve(dir).toLowerCase();

export class ImportService {
  private readonly now: () => Date;

  constructor(private readonly d: ImportServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async run(
    srcTool: ToolId,
    keys: string[],
    target: ImportTarget,
    policy: DuplicatePolicy,
    onProgress?: (step: string) => void,
    options: ImportOptions = {},
  ): Promise<{ status: 'done'; results: ImportItemResult[]; launchWarning?: string } | { status: 'aborted'; reason: string }> {
    // 대상 앱을 건드리기 전에 먼저 요청받은 키들이 하나라도 실제 세션으로 풀리는지 확인한다 — 전부 알 수
    // 없는 키라면(예: 목록이 새로고침된 뒤의 낡은 요청) 앱을 종료/재실행하지 않고 바로 취소한다. 일부만
    // 알 수 없는 키인 경우는 지금처럼 importOne 에서 항목별 실패로 남긴다.
    const summaries = this.summariesFor(srcTool);
    if (!keys.some((k) => summaries.has(k))) {
      return { status: 'aborted', reason: '가져올 수 있는 세션이 없습니다' };
    }

    const outcome = await this.d.switcher.runWithAppStopped(target.tool, async (progress) => {
      const report = (step: string) => {
        progress(step);
        onProgress?.(step);
      };
      const results: ImportItemResult[] = [];
      // 지침 파일은 cwd 마다 한 번만 처리한다 — 같은 cwd 의 다음 세션이 방금 만든 파일을 '이미 있음' 으로 보고하지 않게.
      const instructionCwds = options.copyInstructions ? new Set<string>() : undefined;
      // 작업 폴더 복사본도 원래 폴더마다 한 번만 만든다 — 같은 대화 폴더의 다음 세션은 그 복사본을 같이 쓴다.
      const folderCopies = options.copyWorkFolder ? new Map<string, string>() : undefined;
      const cache = this.runCache();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        report(`세션 읽는 중 (${i + 1}/${keys.length})`);
        results.push(await this.importOne(srcTool, key, target, policy, summaries, report, cache, instructionCwds, folderCopies, options.fullToolLog ? 'full' : 'summary'));
      }
      return results;
    });

    if (outcome.status === 'aborted') return { status: 'aborted', reason: outcome.reason };
    return { status: 'done', results: outcome.value, launchWarning: outcome.launchWarning };
  }

  private async importOne(
    srcTool: ToolId,
    key: string,
    target: ImportTarget,
    policy: DuplicatePolicy,
    summaries: Map<string, SessionSummary>,
    report: (step: string) => void,
    cache: RunCache,
    instructionCwds?: Set<string>,
    folderCopies?: Map<string, string>,
    toolLog: ToolLogMode = 'summary',
  ): Promise<ImportItemResult> {
    const dstAccountKey = dstAccountKeyOf(target);
    if (policy === 'skip' && this.d.db.findImports(srcTool, key, target.tool, dstAccountKey).length > 0) {
      return { key, status: 'skipped' };
    }

    const tx = new FsTransaction(this.d.backupsDir);
    // 되돌리기 자체가 실패했을 때 안내 메시지에 쓸 수 있도록, writer 가 반환하자마자 catch 밖에서도 보이게 잡아둔다.
    let dstSessionId: string | undefined;
    let claimedCwd: string | undefined; // 이 항목이 지침 파일 처리를 맡은 cwd — 실패해 되돌리면 다음 항목이 다시 시도하게 풀어준다
    let claimedCopy: string | undefined; // 이 항목이 만든 작업 폴더 복사본의 원래 폴더 — 되돌리면 복사본도 지워지므로 풀어준다
    try {
      const summary = summaries.get(key);
      if (!summary) throw new Error('알 수 없는 세션입니다');
      if (!summary.file) throw new Error('대화 기록이 없습니다');
      let cwd = this.resolveCwd(srcTool, target, summary);
      if (!cwd) throw new Error('작업 폴더를 알 수 없습니다');
      let folderCopy: FolderCopyResult | undefined;
      // 원본 생성 시각이 유효하지 않으면(범위 밖 값 등) 현재 시각으로 대체하고 stats 에 남긴다.
      const createdAtValid = Number.isFinite(new Date(summary.createdAt).getTime());
      const sourceCreatedAt = (createdAtValid ? new Date(summary.createdAt) : this.now()).toISOString();
      const extraStats = createdAtValid ? {} : { invalidCreatedAt: true };

      let status: ImportItemResult['status'];
      let statsJson = JSON.stringify(extraStats);

      if (srcTool === 'claude' && target.tool === 'claude') {
        if (summary.kind !== 'code' || !summary.indexPath) throw new Error('Claude 계정 간 공유는 Code 세션만 가능합니다');
        report('변환');
        const r = await forkClaudeSession(this.d.paths, tx, {
          sourceIndexPath: summary.indexPath,
          sourceTranscriptPath: summary.file,
          to: target.account,
          now: this.now,
        });
        dstSessionId = r.cliSessionId;
        status = 'forked';
      } else {
        const ir = await this.d.library.read(srcTool, key);
        statsJson = JSON.stringify({ ...ir.stats, ...extraStats });
        // 받는 쪽 AI 가 이어서 작업하기 전에 알도록 저장소마다 브랜치와 커밋하지 않은 변경을 대화 첫머리에 적는다
        // (상위 폴더가 git 저장소가 아니고 하위 저장소를 여럿 모은 폴더 — 예: multi-repo — 도 저장소별로).
        report('저장소 상태 확인');
        let writeIr = withRepoStatus(ir, await cache.status(cwd));
        report('변환');
        if (target.tool === 'claude') {
          const copyTo = folderCopies && srcTool === 'codex' ? claudeCopyOf(cwd) : undefined;
          if (folderCopies && copyTo) {
            requireClaudeTemplate(this.d.paths, target.account); // 쓸 수 없는 대상이면 폴더를 복사하기 전에 실패시킨다
            const srcKey = path.resolve(cwd).toLowerCase();
            const existing = folderCopies.get(srcKey);
            if (existing) {
              folderCopy = { from: cwd, to: existing, status: 'reused' };
            } else {
              report('작업 폴더 복사');
              folderCopy = await copyWorkFolder(tx, cwd, copyTo);
              if (folderCopy.to) {
                folderCopies.set(srcKey, folderCopy.to);
                claimedCopy = srcKey;
              }
            }
            if (folderCopy.to) {
              writeIr = withCopiedFolder(writeIr, cwd, folderCopy.to);
              cwd = folderCopy.to;
            }
          }
          // Claude 는 경로 문자열로 프로젝트를 나눈다 — 같은 폴더의 다른 표기(예: C:\Users\olduser ↔ C:\Users\me)는 한 표기로
          // 맞추고, 대화 속 옛 표기도 그 표기로 바꾼다(core/work-folder 의 pickClaudeCwd).
          const claudeCwd = cache.claudeCwd(cwd);
          if (claudeCwd !== normalizeWinPath(cwd)) writeIr = withRebasedFolder(writeIr, cwd, claudeCwd);
          cwd = claudeCwd;
          const r = await writeClaudeSession(this.d.paths, tx, { ir: writeIr, sourceCreatedAt, account: target.account, cwd, gitBranch: summary.gitBranch, toolLog, now: this.now });
          dstSessionId = r.cliSessionId;
        } else {
          const r = await writeCodexSession(this.d.paths, tx, { ir: writeIr, sourceCreatedAt, cwd, toolLog, now: this.now });
          dstSessionId = r.threadId;
        }
        status = 'imported';
      }

      let instructions: InstructionsResult | undefined;
      let subInstructions: InstructionsResult[] = [];
      if (instructionCwds && srcTool !== target.tool) {
        const cwdKey = folderKey(cwd);
        if (!instructionCwds.has(cwdKey)) {
          instructionCwds.add(cwdKey);
          claimedCwd = cwdKey;
          instructions = await copyInstructions(tx, srcTool, cwd);
          subInstructions = await copySubInstructions(tx, srcTool, cwd, await cache.scan(cwd));
        }
      }

      report('대상 앱에 등록');
      this.d.db.recordImport({
        srcTool,
        srcKey: key,
        dstTool: target.tool,
        dstAccountKey,
        dstSessionId,
        importedAt: this.now().toISOString(),
        statsJson,
      });
      report('이력 기록');
      tx.commit();
      await pruneBackups(this.d.backupsDir, BACKUP_KEEP).catch(() => {}); // 정리 실패는 이관 결과에 영향 없음
      return {
        key,
        status,
        dstSessionId,
        ...(instructions ? { instructions } : {}),
        ...(subInstructions.length > 0 ? { subInstructions } : {}),
        ...(folderCopy ? { folderCopy } : {}),
      };
    } catch (e) {
      const reason = (e as Error).message;
      if (claimedCwd) instructionCwds?.delete(claimedCwd);
      if (claimedCopy) folderCopies?.delete(claimedCopy);
      try {
        await tx.rollback();
      } catch (rollbackErr) {
        return {
          key,
          status: 'failed',
          reason: `${reason} — 되돌리기 실패: 수동 확인이 필요합니다 (${target.tool} 대상, 새 세션 ${dstSessionId ?? '알 수 없음'}): ${(rollbackErr as Error).message}`,
        };
      }
      return { key, status: 'failed', reason };
    }
  }

  // Cowork 세션(cwd '/sessions/…')을 Codex 로 보낼 때는 인덱스의 userSelectedFolders[0] (hostFolder) 을 실제 작업 폴더로 쓴다.
  private resolveCwd(srcTool: ToolId, target: ImportTarget, summary: SessionSummary): string {
    if (srcTool === 'claude' && target.tool === 'codex' && summary.kind === 'cowork') {
      return summary.hostFolder ?? '';
    }
    return summary.cwd;
  }

  private runCache(): RunCache {
    const scans = new Map<string, Promise<WorkspaceScan>>();
    const statuses = new Map<string, Promise<RepoStatus[]>>();
    const reals = new Map<string, string>();
    let known: { cwd: string; updatedAt: number }[] | undefined;
    const real = (p: string) => {
      let v = reals.get(p);
      if (v === undefined) {
        v = canonicalPath(p);
        reals.set(p, v);
      }
      return v;
    };
    const scan = (dir: string) => {
      const k = folderKey(dir);
      let v = scans.get(k);
      if (!v) {
        v = scanWorkspace(dir);
        scans.set(k, v);
      }
      return v;
    };
    const readStatus = this.d.repoStatus ?? ((dir: string) => gitStatusLines(dir));
    return {
      scan,
      status: (dir) => {
        const k = folderKey(dir);
        let v = statuses.get(k);
        if (!v) {
          v = scan(dir).then((s) => Promise.all(s.repos.map(async (r) => ({ ...r, changes: await readStatus(path.join(dir, ...r.rel.split('/'))) }))));
          statuses.set(k, v);
        }
        return v;
      },
      claudeCwd: (cwd) => {
        if (!known) {
          try {
            known = listClaudeSessions(this.d.paths).map((s) => ({ cwd: s.cwd, updatedAt: s.updatedAt }));
          } catch {
            known = []; // 목록을 못 읽어도 이관은 계속한다 — 실제 경로로 맞춘다
          }
        }
        return pickClaudeCwd(cwd, known, real);
      },
    };
  }

  // library.list() 는 옵션과 무관하게 도구의 모든 세션을 내부 캐시에 채운다 — 여기서는 그 결과를 키로 평탄화해 쓴다.
  private summariesFor(tool: ToolId): Map<string, SessionSummary> {
    const { projects } = this.d.library.list(tool, { includeArchived: true, includeSubagents: true });
    const map = new Map<string, SessionSummary>();
    for (const p of projects) for (const s of p.sessions) map.set(s.key, s);
    return map;
  }
}

// GPT 대화 폴더를 '<문서>\Claude\<날짜>\<이름>'(이미 있으면 ' (2)', ' (3)' …)으로 통째로 복사한다(git 저장소 포함, 원본은 그대로).
// 복사본은 항목 트랜잭션에 묶여 항목이 실패하면 지워진다. 원래 폴더가 없거나 복사가 실패하면 복사하지 않고 원래 폴더를
// 쓰도록 skipped/failed 로 남긴다 — 대화 이관 자체는 계속한다.
async function copyWorkFolder(tx: FsTransaction, src: string, base: string): Promise<FolderCopyResult> {
  const stat = await fs.stat(src).catch(() => undefined);
  if (!stat?.isDirectory()) return { from: src, status: 'skipped', reason: '작업 폴더가 없습니다' };
  let dst = base;
  // Codex 도 같은 날 대화 폴더를 new-chat, new-chat-2 … 로 짓는다 — 그 이름과 겹치지 않게 탐색기처럼 ' (2)' 를 붙인다.
  for (let n = 2; await fs.stat(dst).then(() => true, () => false); n++) dst = `${base} (${n})`;
  const removeCopy = () => fs.rm(dst, { recursive: true, force: true });
  try {
    await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (e) {
    await removeCopy().catch(() => {});
    return { from: src, status: 'failed', reason: (e as Error).message };
  }
  tx.onRollback(removeCopy);
  return { from: src, to: dst, status: 'copied' };
}

// Codex→Claude: AGENTS.md 만 있으면 '@AGENTS.md' 한 줄짜리 CLAUDE.md 를 만든다(Claude Code 파일 참조 — 원본 유지).
// Claude→Codex: CLAUDE.md 만 있으면 바이트 그대로 AGENTS.md 로 복사한다(Codex 는 참조 문법이 없음).
// 생성은 항목 트랜잭션으로 추적해 항목이 실패하면 함께 지워진다. 폴더/원본이 없으면 실패가 아니라 건너뜀으로 남긴다.
async function copyInstructions(tx: FsTransaction, srcTool: ToolId, cwd: string): Promise<InstructionsResult> {
  const [srcName, dstName] = srcTool === 'codex' ? ['AGENTS.md', 'CLAUDE.md'] : ['CLAUDE.md', 'AGENTS.md'];
  const dst = path.join(cwd, dstName);
  const stat = await fs.stat(cwd).catch(() => undefined);
  if (!stat?.isDirectory()) return { path: dst, status: 'skipped', reason: '작업 폴더가 없습니다' };
  if (await fs.stat(dst).then(() => true, () => false)) return { path: dst, status: 'exists' };
  let src: Buffer;
  try {
    src = await fs.readFile(path.join(cwd, srcName));
  } catch {
    return { path: dst, status: 'skipped', reason: `${srcName} 없음` };
  }
  await tx.createFile(dst, srcTool === 'codex' ? '@AGENTS.md\n' : src);
  return { path: dst, status: 'created' };
}

// 하위 폴더(작업 폴더 아래 2단계까지 — 예: multi-repo 의 하위 저장소)도 같은 규칙으로 맞춘다. 원본 지침 파일이 있는 폴더만
// 다루고, 대상 파일이 이미 있으면 그대로 둔다. 작업 폴더 자신은 copyInstructions 가 맡는다.
async function copySubInstructions(tx: FsTransaction, srcTool: ToolId, cwd: string, scan: WorkspaceScan): Promise<InstructionsResult[]> {
  const [srcName, dstName] = srcTool === 'codex' ? ['AGENTS.md', 'CLAUDE.md'] : ['CLAUDE.md', 'AGENTS.md'];
  const results: InstructionsResult[] = [];
  for (const rel of scan.instructionFiles) {
    const parts = rel.split('/');
    const name = parts.pop()!;
    if (parts.length === 0 || name.toLowerCase() !== srcName.toLowerCase()) continue;
    const dir = path.join(cwd, ...parts);
    const dst = path.join(dir, dstName);
    if (await fs.stat(dst).then(() => true, () => false)) {
      results.push({ path: dst, status: 'exists' });
      continue;
    }
    const src = await fs.readFile(path.join(dir, name));
    await tx.createFile(dst, srcTool === 'codex' ? '@AGENTS.md\n' : src);
    results.push({ path: dst, status: 'created' });
  }
  return results;
}
