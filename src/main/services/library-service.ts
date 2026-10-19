import path from 'node:path';
import type { ToolId } from '../core/auth-bundle.js';
import type { IrSession } from '../core/ir.js';
import { basenameOf, samePathOrInside } from '../core/win-path.js';
import type { AppDb } from '../infra/app-db.js';
import { mainWorktreeRoot } from '../infra/git-worktree.js';
import { canonicalPath } from '../infra/real-path.js';
import type { PathProvider } from '../infra/path-provider.js';
import { listClaudeSessions, readClaudeSession } from '../providers/claude/sessions.js';
import { listCodexSessions, readCodexSession, type CodexProject } from '../providers/codex/sessions.js';
import type { SessionSummary } from '../providers/types.js';

export interface LibraryAccount { key: string; label: string }
export interface LibrarySession extends SessionSummary { accountKey: string; accountLabel: string }
export interface LibraryProject { key: string; name: string; path?: string; sessions: LibrarySession[] }
export interface LibraryListOptions { account?: string; includeSubagents?: boolean; includeArchived?: boolean }
// imported: 반환된 세션들 중 (도구·대상 계정과 무관하게) 한 번이라도 이관된 적 있는 키 목록 — GUI 가 행에
// '이관됨' 배지를 붙일 때 쓴다. 세션마다 이력을 조회하지 않고 imports 테이블을 한 번만 조회해서 채운다.
export interface LibraryList { accounts: LibraryAccount[]; projects: LibraryProject[]; imported: string[] }

export class LibraryService {
  private readonly lastListed = new Map<ToolId, Map<string, SessionSummary>>();

  constructor(private readonly d: { paths: PathProvider; db: AppDb }) {}

  list(tool: ToolId, opts: LibraryListOptions): LibraryList {
    const { sessions, projects } = tool === 'codex' ? listCodexSessions(this.d.paths) : { sessions: listClaudeSessions(this.d.paths), projects: [] as CodexProject[] };
    this.lastListed.set(tool, new Map(sessions.map((s) => [s.key, s])));

    const attribute = tool === 'codex' ? this.codexAttributor() : this.claudeAttributor();
    const importedKeys = this.d.db.listImportedSrcKeys(tool);
    // 작업 폴더의 '실제 자리': git worktree 면 원본 저장소 루트, 링크(정션)는 푼 경로. 목록 한 번 동안 캐시한다.
    const places = new Map<string, string>();
    const placeOf = (cwd: string) => {
      let v = places.get(cwd);
      if (v === undefined) {
        v = canonicalPath(mainWorktreeRoot(cwd) ?? cwd);
        places.set(cwd, v);
      }
      return v;
    };
    const roots: ProjectRoot[] = projects.flatMap((project) => project.roots.map((root) => ({ project, root, real: canonicalPath(root) })));
    const accounts = new Map<string, string>();
    const groups = new Map<string, LibraryProject>();
    const imported: string[] = [];

    for (const s of sessions) {
      const acc = attribute(s);
      accounts.set(acc.key, acc.label);
      if (!opts.includeSubagents && s.kind === 'subagent') continue;
      if (!opts.includeArchived && s.archived) continue;
      if (opts.account && opts.account !== acc.key) continue;
      const g = groupOf(tool, s, projects, roots, placeOf);
      const proj = groups.get(g.key) ?? { ...g, sessions: [] };
      proj.sessions.push({ ...s, accountKey: acc.key, accountLabel: acc.label });
      groups.set(g.key, proj);
      if (importedKeys.has(s.key)) imported.push(s.key);
    }

    const list = [...groups.values()];
    for (const pr of list) pr.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    // 최근에 쓴 묶음부터, 단 '프로젝트 없음'은 Codex 앱처럼 프로젝트들 뒤에
    const rank = (pr: LibraryProject) => (pr.key === LOOSE.key ? 1 : 0);
    list.sort((a, b) => rank(a) - rank(b) || (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
    // 이름이 같은 다른 폴더(예: Codex 가 날짜별로 만드는 Documents\Codex\<날짜>\new-chat)는 상위 폴더 이름을 붙여 구분한다
    const nameCount = new Map<string, number>();
    for (const pr of list) nameCount.set(pr.name, (nameCount.get(pr.name) ?? 0) + 1);
    for (const pr of list) if (pr.path && (nameCount.get(pr.name) ?? 0) > 1) pr.name = `${pr.name} · ${basenameOf(path.dirname(pr.path))}`;
    return { accounts: [...accounts].map(([key, label]) => ({ key, label })), projects: list, imported };
  }

  async read(tool: ToolId, key: string): Promise<IrSession> {
    const known = this.lastListed.get(tool) ?? (this.list(tool, {}), this.lastListed.get(tool)!);
    const s = known.get(key);
    if (!s) throw new Error('알 수 없는 세션입니다');
    if (!s.file) throw new Error('대화 파일을 찾을 수 없습니다');
    try {
      return await (tool === 'codex' ? readCodexSession(s.file, s.sessionId, s.title) : readClaudeSession(s.file, s.sessionId, s.title));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error('대화 파일을 찾을 수 없습니다');
      throw e;
    }
  }

  private codexAttributor(): (s: SessionSummary) => LibraryAccount {
    const rows = new Map(this.d.db.listAccounts('codex').map((a) => [a.id, a]));
    // 계정이 삭제되면 그 계정의 switch_events.account_id 가 NULL 이 된다 — 그 이벤트를 걸러내지 않고
    // '이 시점부터는 활성 계정 없음'으로 타임라인에 남겨야, 삭제 이후 세션이 그 전 계정으로 잘못 되돌아가지 않는다.
    const events = this.d.db
      .listSwitches('codex')
      .filter((e) => e.result === 'ok' || e.result === 'saved')
      .map((e) => ({ at: Date.parse(e.switchedAt), id: e.accountRowId }))
      .sort((a, b) => a.at - b.at);
    return (s) => {
      let id: number | null = null;
      for (const e of events) { if (e.at <= s.createdAt) id = e.id; else break; }
      const row = id !== null ? rows.get(id) : undefined;
      return row ? { key: `acct:${row.id}`, label: row.label } : { key: 'unassigned', label: '미분류' };
    };
  }

  private claudeAttributor(): (s: SessionSummary) => LibraryAccount {
    return (s) => {
      if (!s.accountRef) return { key: 'cli', label: 'CLI 세션 (계정 불명)' };
      const { accountId, orgId = '', email } = s.accountRef;
      const row = this.d.db.findAccountByIdentity('claude', accountId, orgId);
      if (row) return { key: `acct:${row.id}`, label: row.label };
      return { key: `unreg:${accountId}/${orgId}`, label: `미등록 (${email ?? accountId.slice(0, 8)})` };
    };
  }
}

const LOOSE = { key: 'loose', name: '프로젝트 없음' };

interface ProjectRoot { project: CodexProject; root: string; real: string }

// Codex: 앱의 사이드바처럼 프로젝트로만 묶는다 — 앱에서 지정한 프로젝트 → 프로젝트 루트 안의 작업 폴더 순. 앱에서
// 프로젝트 밖으로 뺀 스레드와 그 밖의 대화(앱이 채팅마다 만드는 Documents\Codex\<날짜>\… 등)는 '프로젝트 없음' 한 묶음.
// Claude: Claude Code 는 폴더가 곧 프로젝트이므로 작업 폴더별로 묶는다.
// 폴더 비교는 실제 자리(placeOf: worktree → 원본 저장소, 링크 → 실제 경로)끼리 한다.
function groupOf(tool: ToolId, s: SessionSummary, projects: CodexProject[], roots: ProjectRoot[], placeOf: (cwd: string) => string): { key: string; name: string; path?: string } {
  if (s.kind === 'cowork') return { key: 'cowork', name: 'Cowork 세션' };
  if (s.remote) return { key: `remote:${s.cwd}`, name: `원격: ${s.cwd}` };
  if (s.projectless) return LOOSE;
  const assigned = s.projectId ? projects.find((p) => p.id === s.projectId) : undefined;
  if (assigned) return { key: `proj:${assigned.id}`, name: assigned.name, path: assigned.roots[0] };
  if (!s.cwd) return tool === 'codex' ? LOOSE : { key: 'unknown', name: '작업 폴더 불명' };
  const place = placeOf(s.cwd);
  let best: ProjectRoot | undefined;
  for (const r of roots) {
    if (!samePathOrInside(place, r.real)) continue;
    if (!best || r.real.length > best.real.length) best = r;
  }
  if (best) return { key: `proj:${best.project.id}`, name: best.project.name, path: best.root };
  if (tool === 'codex') return LOOSE;
  return { key: `cwd:${place.toLowerCase()}`, name: basenameOf(place), path: place };
}
