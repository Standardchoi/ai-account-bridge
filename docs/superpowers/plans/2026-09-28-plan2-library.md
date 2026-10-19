# Plan 2 — 프로젝트·세션 조회 (라이브러리) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex·Claude 의 로컬 프로젝트/세션/대화를 **읽기 전용**으로 모아, 계정별로 거르고 프로젝트 → 세션 → 대화 미리보기로 보여주는 라이브러리를 코어 + RPC + GUI 에 추가한다. (도구 간 이관은 Plan 3.)

**Architecture:** 도구별 reader(`providers/<tool>/sessions.ts`)가 원본을 `SessionSummary`(목록)와 `IrSession`(대화 본문, 공통 중간 표현)으로 바꾸고, `LibraryService` 가 계정 귀속·프로젝트 묶기·필터를 담당한다. RPC 는 읽기 전용 메서드 2개(`libraryList`, `librarySession`)를 추가하고, GUI 는 [라이브러리] 탭을 추가한다. 원본 파일/DB 는 절대 쓰지 않는다(SQLite 는 `readonly`).

**Tech Stack:** 기존과 동일 — Node 22, TypeScript 7(NodeNext ESM), better-sqlite3, Vitest, Electron(gui/ plain JS).

**관련 문서:** [설계](../specs/2026-09-23-ai-account-bridge-design.md) §4.3 · [아키텍처](../../architecture.md) §3.2, §5 · [Plan 1](2026-09-23-plan1-core-account-switching.md)

---

## 사전 검증 결과 (2026-09-28, 실제 파일 — 키/경로만 관찰)

| ID | 결과 | 설계 반영 |
|---|---|---|
| V8 Cowork | **통과.** 인덱스 `local-agent-mode-sessions\<acct>\<org>\local_<id>.json` (키: `sessionId, cliSessionId, cwd(/sessions/<name>), title, createdAt, lastActivityAt, isArchived, userSelectedFolders, emailAddress, accountName, model …`). 본문 `…\local_<id>\.claude\projects\<enc>\<cliSessionId>.jsonl` — 줄 형식은 Claude Code 와 동일 | Claude reader 가 Code 와 같은 파서로 Cowork 도 읽음. Cowork 는 별도 그룹 |
| V10 폴더 인코딩 | 로컬 경로는 `cwd.replace(/[^A-Za-z0-9]/g,'-')` 규칙 11/11 일치. 예외: (a) 세션 중 작업 폴더를 옮긴 경우 파일 첫 `cwd` 는 옛 경로, (b) SSH 원격 세션 폴더명은 `ssh-<uuid>` | 조회는 **폴더명이 아니라 파일 안 마지막 `cwd`** 로 묶고, `ssh-*` 는 "원격" 으로 표시. 인코딩 규칙은 Plan 3 writer 에서 사용 |
| Codex 경로 | `~\.codex` 는 `C:\codex_home` 으로의 **정션**. `threads.rollout_path`/`cwd` 는 `\\?\C:\…` 접두어 포함 | 경로 비교 전 `\\?\` 제거(`normalizeWinPath`) |
| Codex 세션 | `threads.source` 가 `vscode` 또는 `{"subagent":{…}}` JSON(서브에이전트, `thread_spawn.parent_thread_id` 포함). `created_at/updated_at` 은 초 단위. 사용자 메시지에 `<environment_context>`, `# AGENTS.md instructions` 등 **주입 문맥**이 role=user 로 섞임 | 서브에이전트는 기본 숨김(부모 연결), 주입 문맥은 system 으로 제외 |
| V5 (Claude 인덱스 복사) | 쓰기 검증이라 Plan 3 로 이동 | — |

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/main/core/ir.ts` | IR 타입(`IrSession/IrMessage/IrBlock/IrStats`), `truncate`, `IrBuilder`(같은 역할 연속 병합 + 도구 호출/결과 짝짓기) |
| `src/main/core/win-path.ts` | `normalizeWinPath`, `samePathOrInside`, `basenameOf` |
| `src/main/providers/types.ts` (수정) | `SessionSummary` 타입 추가 |
| `src/main/providers/codex/sessions.ts` | `listCodexSessions`, `readCodexSession` |
| `src/main/providers/claude/sessions.ts` | `listClaudeSessions`, `readClaudeSession` |
| `src/main/infra/app-db.ts` (수정) | switch_events.result 에 `'saved'` 허용, `recordSwitch` 타입 확장 |
| `src/main/services/account-service.ts` (수정) | `saveCurrent` 가 신규/갱신 모두 `saved` 이벤트 기록 |
| `src/main/services/library-service.ts` | 계정 귀속, 프로젝트 묶기, 필터, 세션 읽기 |
| `src/rpc/handlers.ts` (수정) | `libraryList`, `librarySession` (읽기 전용, 잠금 없음) |
| `gui/index.html`, `gui/renderer.js`, `gui/style.css` (수정) | [계정]/[라이브러리] 탭, 라이브러리 화면 |
| `test/fixtures/` 대신 테스트 안에서 임시 폴더에 합성 데이터 생성 | 실제 대화 데이터 커밋 금지 |

---

### Task 1: IR 타입과 경로 유틸

**Files:** Create `src/main/core/ir.ts`, `src/main/core/win-path.ts` · Test `test/unit/ir.test.ts`, `test/unit/win-path.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/win-path.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { basenameOf, normalizeWinPath, samePathOrInside } from '../../src/main/core/win-path.js';

describe('win-path', () => {
  it('strips the \\\\?\\ prefix and trailing separators', () => {
    expect(normalizeWinPath('\\\\?\\C:\\codex_home\\sessions\\')).toBe('C:\\codex_home\\sessions');
    expect(normalizeWinPath('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\srv\\share\\x');
    expect(normalizeWinPath('/home/me/x/')).toBe('/home/me/x');
  });
  it('matches a path equal to or inside a parent, case-insensitively, on a separator boundary', () => {
    expect(samePathOrInside('\\\\?\\C:\\Users\\A\\proj\\src', 'c:\\users\\a\\proj')).toBe(true);
    expect(samePathOrInside('C:\\Users\\A\\proj', 'C:\\Users\\A\\proj\\')).toBe(true);
    expect(samePathOrInside('C:\\Users\\A\\project2', 'C:\\Users\\A\\proj')).toBe(false);
  });
  it('returns the last path segment', () => {
    expect(basenameOf('\\\\?\\C:\\Users\\A\\multi-repo')).toBe('multi-repo');
    expect(basenameOf('/sessions/practical-laughing-shannon')).toBe('practical-laughing-shannon');
  });
});
```

`test/unit/ir.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { IrBuilder, truncate } from '../../src/main/core/ir.js';

describe('truncate', () => {
  it('keeps short text and marks cut text with the omitted length', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcde… (3자 생략)');
  });
});

describe('IrBuilder', () => {
  it('merges consecutive blocks of the same role into one message', () => {
    const b = new IrBuilder('codex', 's1');
    b.text('user', 'hi', 't1');
    b.text('assistant', 'a', 't2');
    b.text('assistant', 'b', 't3');
    const s = b.build();
    expect(s.messages.map((m) => [m.role, m.blocks.length])).toEqual([['user', 1], ['assistant', 2]]);
  });
  it('pairs tool calls with outputs by id and counts them', () => {
    const b = new IrBuilder('claude', 's1');
    b.toolCall('c1', 'shell', '{"cmd":"ls"}');
    b.toolOutput('c1', 'file.txt', false);
    b.toolOutput('missing', 'ignored', false);
    const s = b.build();
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: 'tool', name: 'shell', input: '{"cmd":"ls"}', output: 'file.txt', isError: false });
    expect(s.stats.toolCalls).toBe(1);
  });
  it('truncates long tool input/output', () => {
    const b = new IrBuilder('codex', 's1');
    b.toolCall('c1', 'x', 'i'.repeat(3000));
    b.toolOutput('c1', 'o'.repeat(3000), false);
    const blk = b.build().messages[0]!.blocks[0] as { input: string; output: string };
    expect(blk.input.length).toBeLessThan(2100);
    expect(blk.output).toContain('자 생략');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/unit/ir.test.ts test/unit/win-path.test.ts` → FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/main/core/win-path.ts`:
```ts
// Windows 경로 비교용 정규화. \\?\ 접두어(긴 경로 표기)와 끝 구분자를 제거한다.
export function normalizeWinPath(p: string): string {
  let s = p;
  if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
  else if (s.startsWith('\\\\?\\')) s = s.slice(4);
  const trimmed = s.replace(/[\\/]+$/, '');
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? s : trimmed;
}

export function samePathOrInside(child: string, parent: string): boolean {
  const c = normalizeWinPath(child).toLowerCase();
  const p = normalizeWinPath(parent).toLowerCase();
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

export function basenameOf(p: string): string {
  const parts = normalizeWinPath(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
```

`src/main/core/ir.ts`:
```ts
import type { ToolId } from './auth-bundle.js';

export interface IrToolBlock { kind: 'tool'; name: string; input: string; output?: string; isError?: boolean }
export type IrBlock = { kind: 'text'; text: string } | IrToolBlock | { kind: 'compactSummary'; text: string };
export interface IrMessage { role: 'user' | 'assistant'; timestamp?: string; blocks: IrBlock[] }
export interface IrStats { droppedReasoning: number; droppedSystem: number; droppedSidechain: number; unknownLines: number; toolCalls: number }
export interface IrSession { tool: ToolId; sessionId: string; title?: string; cwd?: string; model?: string; messages: IrMessage[]; stats: IrStats }

export const TOOL_TEXT_LIMIT = 2048;

export function truncate(s: string, limit = TOOL_TEXT_LIMIT): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}… (${s.length - limit}자 생략)`;
}

// reader 가 원본을 한 줄씩 읽으며 IR 을 쌓는 도우미.
export class IrBuilder {
  readonly stats: IrStats = { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 };
  title?: string;
  cwd?: string;
  model?: string;
  private readonly messages: IrMessage[] = [];
  private readonly pendingTools = new Map<string, IrToolBlock>();

  constructor(private readonly tool: ToolId, private readonly sessionId: string) {}

  private push(role: IrMessage['role'], block: IrBlock, timestamp?: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role) last.blocks.push(block);
    else this.messages.push({ role, timestamp, blocks: [block] });
  }

  text(role: IrMessage['role'], text: string, timestamp?: string): void {
    if (text.trim() === '') return;
    this.push(role, { kind: 'text', text }, timestamp);
  }

  compactSummary(text: string, timestamp?: string): void {
    this.push('user', { kind: 'compactSummary', text: truncate(text, 4096) }, timestamp);
  }

  toolCall(id: string, name: string, input: string, timestamp?: string): void {
    const block: IrToolBlock = { kind: 'tool', name, input: truncate(input) };
    this.pendingTools.set(id, block);
    this.stats.toolCalls++;
    this.push('assistant', block, timestamp);
  }

  toolOutput(id: string, output: string, isError: boolean): void {
    const block = this.pendingTools.get(id);
    if (!block) return;
    block.output = truncate(output);
    block.isError = isError;
    this.pendingTools.delete(id);
  }

  build(): IrSession {
    return { tool: this.tool, sessionId: this.sessionId, title: this.title, cwd: this.cwd, model: this.model, messages: this.messages, stats: this.stats };
  }
}
```

- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS; `npx tsc --noEmit` 깨끗
- [ ] **Step 5: Commit** — `feat(core): add IR types, IrBuilder and Windows path helpers`

---

### Task 2: `SessionSummary` 타입 + Codex reader

**Files:** Modify `src/main/providers/types.ts` · Create `src/main/providers/codex/sessions.ts`, `test/helpers/fake-sessions.ts` · Test `test/unit/codex-sessions.test.ts`

- [ ] **Step 1: 타입 추가** — `src/main/providers/types.ts` 끝에:
```ts
export type SessionKind = 'code' | 'cowork' | 'cli' | 'subagent';

export interface SessionSummary {
  tool: ToolId;
  key: string;                 // 도구 안에서 유일: codex:<threadId> / claude:<kind>:<id>
  sessionId: string;           // 원본 세션/스레드 ID (Claude 는 cliSessionId)
  title: string;
  cwd: string;                 // 정규화된 작업 폴더 (알 수 없으면 '')
  createdAt: number;           // ms
  updatedAt: number;           // ms
  archived: boolean;
  kind: SessionKind;
  parentId?: string;           // 서브에이전트의 부모 스레드
  remote?: boolean;            // Claude ssh-* 원격 세션
  accountRef?: { accountId: string; orgId?: string; email?: string }; // Claude 인덱스 폴더 기준
  file: string;                // 대화 본문 파일 (없으면 '')
  projectId?: string;          // Codex 프로젝트 ID
  gitBranch?: string;
}
```
(`ToolId` import 추가: `import type { AuthBundle, ToolId } from '../core/auth-bundle.js';` 는 이미 있음.)

- [ ] **Step 2: 테스트 도우미 작성** — `test/helpers/fake-sessions.ts`:
```ts
import Database from 'better-sqlite3';
import path from 'node:path';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { writeFile } from './tmp-paths.js';

export function codexStateDb(p: PathProvider): Database.Database {
  const db = new Database(path.join(p.home, '.codex', 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT,
             model_provider TEXT, cwd TEXT, title TEXT, archived INTEGER DEFAULT 0, git_branch TEXT, cli_version TEXT);
           CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER);
           CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);`);
  return db;
}

export const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

export async function writeRollout(p: PathProvider, name: string, rows: object[]): Promise<string> {
  const file = path.join(p.home, '.codex', 'sessions', '2026', '09', '28', name);
  await writeFile(file, jsonl(...rows));
  return file;
}
```
(`test/helpers/tmp-paths.ts` 에서 `.codex` 폴더가 필요하면 `writeFile` 이 부모를 만든다. `codexStateDb` 호출 전 `await fs.mkdir(path.join(p.home,'.codex'),{recursive:true})` 필요 — 테스트에서 처리.)

- [ ] **Step 3: 실패하는 테스트 작성** — `test/unit/codex-sessions.test.ts`:
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { listCodexSessions, readCodexSession } from '../../src/main/providers/codex/sessions.js';
import { codexStateDb, writeRollout } from '../helpers/fake-sessions.js';
import { tmpPaths } from '../helpers/tmp-paths.js';

let p: PathProvider;
beforeEach(async () => {
  p = await tmpPaths();
  await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
});

describe('listCodexSessions', () => {
  it('lists threads with normalized paths, ms timestamps, subagent parents and projects', async () => {
    const f = await writeRollout(p, 'rollout-a.jsonl', []);
    const db = codexStateDb(p);
    const ins = db.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived, git_branch) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('t1', `\\\\?\\${f}`, 1000, 2000, 'vscode', '\\\\?\\C:\\work\\proj\\src', '제목1', 0, 'main');
    ins.run('t2', `\\\\?\\${f}`, 1500, 2500, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 't1' } } }), 'C:\\work\\proj', '', 1, null);
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p1', '프로젝트', '{}', 0);
    db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p1', 0, 'C:\\work\\proj');
    db.close();

    const r = listCodexSessions(p);
    expect(r.projects).toEqual([{ id: 'p1', name: '프로젝트', roots: ['C:\\work\\proj'] }]);
    const t1 = r.sessions.find((s) => s.sessionId === 't1')!;
    expect(t1).toMatchObject({ key: 'codex:t1', title: '제목1', cwd: 'C:\\work\\proj\\src', createdAt: 1_000_000, updatedAt: 2_000_000, kind: 'code', archived: false, file: f, gitBranch: 'main' });
    const t2 = r.sessions.find((s) => s.sessionId === 't2')!;
    expect(t2).toMatchObject({ kind: 'subagent', parentId: 't1', archived: true, title: '(제목 없음)' });
  });

  it('returns empty when the Codex state DB does not exist', () => {
    expect(listCodexSessions(p)).toEqual({ sessions: [], projects: [] });
  });
});

describe('readCodexSession', () => {
  it('converts a rollout into IR, dropping reasoning/developer/injected context', async () => {
    const f = await writeRollout(p, 'rollout-b.jsonl', [
      { type: 'session_meta', payload: { id: 't1', cwd: '\\\\?\\C:\\work\\proj' } },
      { type: 'turn_context', payload: { model: 'gpt-5' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '버그 고쳐줘' }] } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'zzz' } },
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'a.txt' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** patch', call_id: 'c2' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'ok' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '고쳤어요' }] } },
      { type: 'compacted', payload: { message: '', replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '이전 요약' }] }] } },
      { type: 'event_msg', payload: { type: 'token_count' } },
      { type: 'weird_new_type', payload: {} },
      'not json' as unknown as object,
    ]);
    const s = readCodexSession(f, 't1', '제목');
    expect(s.cwd).toBe('C:\\work\\proj');
    expect(s.model).toBe('gpt-5');
    expect(s.title).toBe('제목');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(s.messages[0]!.blocks).toEqual([{ kind: 'text', text: '버그 고쳐줘' }]);
    expect(s.messages[1]!.blocks).toEqual([
      { kind: 'tool', name: 'shell', input: '{"cmd":"ls"}', output: 'a.txt', isError: false },
      { kind: 'tool', name: 'apply_patch', input: '*** patch', output: 'ok', isError: false },
      { kind: 'text', text: '고쳤어요' },
    ]);
    expect(s.messages[2]!.blocks[0]).toEqual({ kind: 'compactSummary', text: '이전 요약' });
    expect(s.stats).toMatchObject({ droppedReasoning: 1, droppedSystem: 2, toolCalls: 2, unknownLines: 2 });
  });
});
```
(`writeRollout` 에 문자열을 넣은 줄은 `JSON.stringify` 로 `"not json"` 이 되어 JSON 파싱은 되지만 객체가 아니다 → unknown 으로 센다.)

- [ ] **Step 4: 실패 확인** — `npx vitest run test/unit/codex-sessions.test.ts` → FAIL

- [ ] **Step 5: 구현** — `src/main/providers/codex/sessions.ts`:
```ts
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { IrBuilder, type IrSession } from '../../core/ir.js';
import { normalizeWinPath } from '../../core/win-path.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { SessionSummary } from '../types.js';

export interface CodexProject { id: string; name: string; roots: string[] }

const INJECTED = /^\s*(<environment_context>|<user_instructions>|# AGENTS\.md instructions|<permissions instructions>|<collaboration_mode>)/;
const IGNORED_TYPES = new Set(['session_meta', 'turn_context', 'event_msg', 'world_state', 'token_usage_record', 'inter_agent_communication_metadata']);

interface ThreadRow { id: string; rollout_path: string; created_at: number; updated_at: number; source: string | null; cwd: string | null; title: string | null; archived: number; git_branch: string | null }

function parentOf(source: string | null): { subagent: boolean; parentId?: string } {
  if (!source || !source.startsWith('{')) return { subagent: false };
  try {
    const s = JSON.parse(source) as { subagent?: { thread_spawn?: { parent_thread_id?: string } } };
    if (!s.subagent) return { subagent: false };
    return { subagent: true, parentId: s.subagent.thread_spawn?.parent_thread_id };
  } catch {
    return { subagent: false };
  }
}

export function listCodexSessions(paths: PathProvider): { sessions: SessionSummary[]; projects: CodexProject[] } {
  const file = path.join(paths.home, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(file)) return { sessions: [], projects: [] };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare('SELECT id, rollout_path, created_at, updated_at, source, cwd, title, archived, git_branch FROM threads')
      .all() as ThreadRow[];
    const sessions: SessionSummary[] = rows.map((r) => {
      const { subagent, parentId } = parentOf(r.source);
      return {
        tool: 'codex',
        key: `codex:${r.id}`,
        sessionId: r.id,
        title: r.title?.trim() || '(제목 없음)',
        cwd: r.cwd ? normalizeWinPath(r.cwd) : '',
        createdAt: r.created_at * 1000,
        updatedAt: r.updated_at * 1000,
        archived: r.archived === 1,
        kind: subagent ? 'subagent' : 'code',
        parentId,
        file: r.rollout_path ? normalizeWinPath(r.rollout_path) : '',
        gitBranch: r.git_branch ?? undefined,
      };
    });
    const roots = db
      .prepare('SELECT p.id AS id, p.name AS name, r.path AS path FROM projects p JOIN project_roots r ON r.project_id = p.id ORDER BY p.position, r.position')
      .all() as { id: string; name: string; path: string }[];
    const byId = new Map<string, CodexProject>();
    for (const r of roots) {
      const proj = byId.get(r.id) ?? { id: r.id, name: r.name, roots: [] };
      proj.roots.push(normalizeWinPath(r.path));
      byId.set(r.id, proj);
    }
    return { sessions, projects: [...byId.values()] };
  } finally {
    db.close();
  }
}

type Content = { type?: string; text?: string }[] | undefined;
const joinText = (c: Content, type: string) => (c ?? []).filter((x) => x.type === type && typeof x.text === 'string').map((x) => x.text).join('\n');

export function readCodexSession(file: string, sessionId: string, title?: string): IrSession {
  const b = new IrBuilder('codex', sessionId);
  b.title = title;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      o = JSON.parse(line);
    } catch {
      b.stats.unknownLines++;
      continue;
    }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') { b.stats.unknownLines++; continue; }
    const p = (o.payload ?? {}) as Record<string, any>;
    const ts = o.timestamp;
    if (o.type === 'session_meta') { if (typeof p.cwd === 'string') b.cwd = normalizeWinPath(p.cwd); continue; }
    if (o.type === 'turn_context') { if (typeof p.model === 'string') b.model = p.model; continue; }
    if (o.type === 'compacted') {
      const hist = (p.replacement_history ?? []) as { role?: string; content?: Content }[];
      b.compactSummary(hist.map((h) => joinText(h.content, h.role === 'assistant' ? 'output_text' : 'input_text')).filter(Boolean).join('\n\n'), ts);
      continue;
    }
    if (IGNORED_TYPES.has(o.type)) continue;
    if (o.type !== 'response_item') { b.stats.unknownLines++; continue; }
    switch (p.type) {
      case 'message':
        if (p.role === 'developer' || p.role === 'system') { b.stats.droppedSystem++; break; }
        if (p.role === 'user') {
          const t = joinText(p.content, 'input_text');
          if (INJECTED.test(t)) b.stats.droppedSystem++;
          else b.text('user', t, ts);
        } else if (p.role === 'assistant') b.text('assistant', joinText(p.content, 'output_text'), ts);
        break;
      case 'reasoning': b.stats.droppedReasoning++; break;
      case 'function_call': b.toolCall(String(p.call_id), String(p.name), String(p.arguments ?? ''), ts); break;
      case 'custom_tool_call': b.toolCall(String(p.call_id), String(p.name), String(p.input ?? ''), ts); break;
      case 'function_call_output': b.toolOutput(String(p.call_id), typeof p.output === 'string' ? p.output : JSON.stringify(p.output), false); break;
      case 'custom_tool_call_output': b.toolOutput(String(p.call_id), Array.isArray(p.output) ? joinText(p.output, 'input_text') : String(p.output ?? ''), false); break;
      case 'agent_message': b.stats.droppedSidechain++; break;
      default: b.stats.unknownLines++;
    }
  }
  return b.build();
}
```

- [ ] **Step 6: 통과 확인** — 테스트 PASS, `npx tsc --noEmit` 깨끗, `npx vitest run` 전체 PASS
- [ ] **Step 7: 실제 데이터 읽기 전용 스모크** — 아래 명령이 예외 없이 세션 수·프로젝트 수와 **가장 최근 세션의 통계만**(대화 내용 출력 금지) 출력하는지 확인:
```bash
npx tsx -e "import('./src/main/providers/codex/sessions.ts').then(async m => { const { systemPaths } = await import('./src/main/infra/path-provider.ts'); const r = m.listCodexSessions(systemPaths()); console.log(r.sessions.length, r.projects.length); const s = r.sessions.filter(x => x.kind==='code').sort((a,b)=>b.updatedAt-a.updatedAt)[0]; const ir = m.readCodexSession(s.file, s.sessionId); console.log(ir.messages.length, ir.stats); })"
```
- [ ] **Step 8: Commit** — `feat(codex): read Codex threads, projects and rollout transcripts`

---

### Task 3: Claude reader (Code 인덱스 · Cowork · CLI 전용)

**Files:** Create `src/main/providers/claude/sessions.ts` · Test `test/unit/claude-sessions.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성** — `test/unit/claude-sessions.test.ts`:
```ts
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { listClaudeSessions, readClaudeSession } from '../../src/main/providers/claude/sessions.js';
import { jsonl } from '../helpers/fake-sessions.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
const A = 'acct-1', O = 'org-1';
beforeEach(async () => { p = await tmpPaths(); });

async function setup() {
  const proj = path.join(p.home, '.claude', 'projects');
  // Code 세션(인덱스 있음)
  await writeFile(path.join(proj, 'C--work-app', 'cli-1.jsonl'), jsonl({ type: 'user', cwd: 'C:\\work\\app', message: { role: 'user', content: 'hi' } }));
  await writeFile(path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'local_aaa.json'),
    JSON.stringify({ sessionId: 'local_aaa', cliSessionId: 'cli-1', cwd: 'C:\\work\\app', title: '코드 세션', createdAt: '1000', lastActivityAt: '2000', isArchived: false }));
  await writeFile(path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'deleted_zzz'), 'x');
  // CLI 전용(인덱스 없음) + 원격
  await writeFile(path.join(proj, 'C--work-lib', 'cli-2.jsonl'), jsonl(
    { type: 'user', cwd: 'C:\\old', message: { role: 'user', content: '첫 질문입니다' } },
    { type: 'custom-title', customTitle: '직접 붙인 제목' },
    { type: 'assistant', cwd: 'C:\\work\\lib', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
  await writeFile(path.join(proj, 'ssh-1234', 'cli-3.jsonl'), jsonl({ type: 'user', cwd: '/home/u/x', message: { role: 'user', content: 'remote' } }));
  // Cowork
  const cw = path.join(p.appData, 'Claude', 'local-agent-mode-sessions', A, O);
  await writeFile(path.join(cw, 'local_ccc.json'), JSON.stringify({ sessionId: 'local_ccc', cliSessionId: 'cli-4', cwd: '/sessions/happy-cat', title: '코워크', createdAt: '3000', lastActivityAt: '4000', isArchived: 'true', emailAddress: 'a@x.com' }));
  await writeFile(path.join(cw, 'local_ccc', '.claude', 'projects', '-sessions-happy-cat', 'cli-4.jsonl'), jsonl({ type: 'user', message: { role: 'user', content: 'cw' } }));
}

describe('listClaudeSessions', () => {
  it('lists Code (indexed), CLI-only, remote and Cowork sessions', async () => {
    await setup();
    const list = listClaudeSessions(p);
    const byId = Object.fromEntries(list.map((s) => [s.sessionId, s]));
    expect(byId['cli-1']).toMatchObject({ key: 'claude:code:local_aaa', kind: 'code', title: '코드 세션', cwd: 'C:\\work\\app', createdAt: 1000, updatedAt: 2000, archived: false, accountRef: { accountId: A, orgId: O } });
    expect(byId['cli-1']!.file.endsWith(path.join('C--work-app', 'cli-1.jsonl'))).toBe(true);
    expect(byId['cli-2']).toMatchObject({ key: 'claude:cli:cli-2', kind: 'cli', title: '직접 붙인 제목', cwd: 'C:\\work\\lib', remote: false });
    expect(byId['cli-2']!.accountRef).toBeUndefined();
    expect(byId['cli-3']).toMatchObject({ kind: 'cli', remote: true, cwd: '/home/u/x' });
    expect(byId['cli-4']).toMatchObject({ key: 'claude:cowork:local_ccc', kind: 'cowork', archived: true, accountRef: { accountId: A, orgId: O, email: 'a@x.com' } });
    expect(byId['cli-4']!.file.endsWith('cli-4.jsonl')).toBe(true);
    expect(list).toHaveLength(4);
  });

  it('returns empty when nothing exists', () => {
    expect(listClaudeSessions(p)).toEqual([]);
  });
});

describe('readClaudeSession', () => {
  it('converts a Claude transcript into IR', async () => {
    const f = path.join(p.home, 'x.jsonl');
    await writeFile(f, jsonl(
      { type: 'user', cwd: 'C:\\a', message: { role: 'user', content: '질문' }, timestamp: 't1' },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [
        { type: 'thinking', thinking: '...' },
        { type: 'text', text: '볼게요' },
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'a.ts' } },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: '파일내용' }, { type: 'image' }] }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'err', is_error: true }] } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } },
      { type: 'ai-title', aiTitle: 'AI 제목' },
      { type: 'system', subtype: 'x' },
      'broken' as unknown as object,
    ));
    const s = readClaudeSession(f, 's1');
    expect(s.title).toBe('AI 제목');
    expect(s.cwd).toBe('C:\\a');
    expect(s.model).toBe('claude-x');
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[1]!.blocks).toEqual([
      { kind: 'text', text: '볼게요' },
      { kind: 'tool', name: 'Read', input: '{"file_path":"a.ts"}', output: '파일내용\n[image]', isError: false },
    ]);
    expect(s.stats).toMatchObject({ droppedReasoning: 1, droppedSystem: 1, droppedSidechain: 1, toolCalls: 1, unknownLines: 1 });
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run test/unit/claude-sessions.test.ts` → FAIL

- [ ] **Step 3: 구현** — `src/main/providers/claude/sessions.ts`:
```ts
import fs from 'node:fs';
import path from 'node:path';
import { IrBuilder, type IrSession } from '../../core/ir.js';
import { normalizeWinPath } from '../../core/win-path.js';
import type { PathProvider } from '../../infra/path-provider.js';
import type { SessionKind, SessionSummary } from '../types.js';

const HEAD_BYTES = 2 * 1024 * 1024; // CLI 전용 세션 메타 추출 시 읽는 최대 크기

const listDir = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const toMs = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const toBool = (v: unknown) => v === true || v === 'true';

// ~/.claude/projects/<dir>/<sessionId>.jsonl 전체를 sessionId → 경로로 모은다
function projectFiles(root: string): Map<string, { file: string; dir: string }> {
  const map = new Map<string, { file: string; dir: string }>();
  for (const d of listDir(root)) {
    if (!d.isDirectory()) continue;
    for (const f of listDir(path.join(root, d.name))) {
      if (f.isFile() && f.name.endsWith('.jsonl')) map.set(f.name.slice(0, -6), { file: path.join(root, d.name, f.name), dir: d.name });
    }
  }
  return map;
}

interface Meta { cwd: string; title?: string; firstPrompt?: string }

// 파일 앞부분만 읽어 마지막 cwd, 제목(custom > ai), 첫 사용자 문장을 뽑는다
function scanMeta(file: string): Meta {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const meta: Meta = { cwd: '' };
    let custom: string | undefined, ai: string | undefined;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"cwd"') && !line.includes('title') && meta.firstPrompt) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      if (typeof o?.cwd === 'string') meta.cwd = o.cwd;
      if (o?.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle;
      if (o?.type === 'ai-title' && typeof o.aiTitle === 'string') ai = o.aiTitle;
      if (!meta.firstPrompt && o?.type === 'user' && !o.isMeta && typeof o.message?.content === 'string') meta.firstPrompt = o.message.content.slice(0, 60);
    }
    meta.title = custom ?? ai;
    return meta;
  } finally {
    fs.closeSync(fd);
  }
}

function indexEntries(base: string): { accountId: string; orgId: string; dir: string; file: string; data: Record<string, unknown> }[] {
  const out = [];
  for (const a of listDir(base)) {
    if (!a.isDirectory()) continue;
    for (const o of listDir(path.join(base, a.name))) {
      if (!o.isDirectory()) continue;
      const dir = path.join(base, a.name, o.name);
      for (const f of listDir(dir)) {
        if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
        try {
          out.push({ accountId: a.name, orgId: o.name, dir, file: path.join(dir, f.name), data: JSON.parse(fs.readFileSync(path.join(dir, f.name), 'utf8')) });
        } catch { /* 깨진 인덱스는 건너뛴다 */ }
      }
    }
  }
  return out;
}

function fromIndex(kind: SessionKind, e: ReturnType<typeof indexEntries>[number], file: string): SessionSummary {
  const d = e.data;
  const cli = String(d.cliSessionId ?? '');
  return {
    tool: 'claude',
    key: `claude:${kind}:${String(d.sessionId ?? path.basename(e.file, '.json'))}`,
    sessionId: cli,
    title: (typeof d.title === 'string' && d.title.trim()) || '(제목 없음)',
    cwd: typeof d.cwd === 'string' ? normalizeWinPath(d.cwd) : '',
    createdAt: toMs(d.createdAt),
    updatedAt: toMs(d.lastActivityAt) || toMs(d.createdAt),
    archived: toBool(d.isArchived),
    kind,
    accountRef: { accountId: e.accountId, orgId: e.orgId, email: typeof d.emailAddress === 'string' ? d.emailAddress : undefined },
    file,
  };
}

export function listClaudeSessions(paths: PathProvider): SessionSummary[] {
  const projectsRoot = path.join(paths.home, '.claude', 'projects');
  const files = projectFiles(projectsRoot);
  const out: SessionSummary[] = [];
  const indexed = new Set<string>();

  for (const e of indexEntries(path.join(paths.appData, 'Claude', 'claude-code-sessions'))) {
    const cli = String(e.data.cliSessionId ?? '');
    indexed.add(cli);
    out.push(fromIndex('code', e, files.get(cli)?.file ?? ''));
  }

  for (const e of indexEntries(path.join(paths.appData, 'Claude', 'local-agent-mode-sessions'))) {
    const cli = String(e.data.cliSessionId ?? '');
    const sessionDir = path.join(e.dir, String(e.data.sessionId ?? path.basename(e.file, '.json')));
    const own = projectFiles(path.join(sessionDir, '.claude', 'projects')).get(cli);
    out.push(fromIndex('cowork', e, own?.file ?? ''));
  }

  for (const [id, { file, dir }] of files) {
    if (indexed.has(id)) continue;
    const st = fs.statSync(file);
    const meta = scanMeta(file);
    out.push({
      tool: 'claude',
      key: `claude:cli:${id}`,
      sessionId: id,
      title: meta.title ?? meta.firstPrompt ?? '(제목 없음)',
      cwd: meta.cwd ? normalizeWinPath(meta.cwd) : '',
      createdAt: st.birthtimeMs || st.mtimeMs,
      updatedAt: st.mtimeMs,
      archived: false,
      kind: 'cli',
      remote: dir.startsWith('ssh-'),
      file,
    });
  }
  return out;
}

const resultText = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((x: any) => (x?.type === 'text' && typeof x.text === 'string' ? x.text : `[${x?.type ?? '?'}]`)).join('\n');
};

export function readClaudeSession(file: string, sessionId: string, title?: string): IrSession {
  const b = new IrBuilder('claude', sessionId);
  let custom: string | undefined, ai: string | undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { b.stats.unknownLines++; continue; }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') { b.stats.unknownLines++; continue; }
    if (typeof o.cwd === 'string') b.cwd = normalizeWinPath(o.cwd);
    if (o.type === 'custom-title') { custom = o.customTitle; continue; }
    if (o.type === 'ai-title') { ai = o.aiTitle; continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue; // system/attachment/queue-operation 등 부가 정보
    if (o.isSidechain) { b.stats.droppedSidechain++; continue; }
    if (o.isMeta) { b.stats.droppedSystem++; continue; }
    const c = o.message?.content;
    const ts = typeof o.timestamp === 'string' ? o.timestamp : undefined;
    if (o.type === 'user') {
      if (typeof c === 'string') { b.text('user', c, ts); continue; }
      for (const blk of Array.isArray(c) ? c : []) {
        if (blk?.type === 'text') b.text('user', String(blk.text ?? ''), ts);
        else if (blk?.type === 'tool_result') b.toolOutput(String(blk.tool_use_id), resultText(blk.content), blk.is_error === true);
        else if (blk?.type === 'image') b.text('user', '[이미지]', ts);
      }
    } else {
      if (typeof o.message?.model === 'string') b.model = o.message.model;
      for (const blk of Array.isArray(c) ? c : []) {
        if (blk?.type === 'text') b.text('assistant', String(blk.text ?? ''), ts);
        else if (blk?.type === 'tool_use') b.toolCall(String(blk.id), String(blk.name), JSON.stringify(blk.input ?? {}), ts);
        else if (blk?.type === 'thinking' || blk?.type === 'redacted_thinking') b.stats.droppedReasoning++;
      }
    }
  }
  b.title = title ?? custom ?? ai;
  return b.build();
}
```

- [ ] **Step 4: 통과 확인** — 테스트 PASS, tsc 깨끗, 전체 PASS
- [ ] **Step 5: 실제 데이터 읽기 전용 스모크** — Task 2 Step 7 과 같은 방식으로 `listClaudeSessions(systemPaths())` 의 kind 별 개수와 가장 최근 세션의 `stats` 만 출력(대화 내용 출력 금지)
- [ ] **Step 6: Commit** — `feat(claude): read Claude Code, Cowork and CLI-only sessions`

---

### Task 4: `saved` 이벤트 — 등록 시점부터 그 계정이 활성이었음을 기록

**Why:** Codex 세션의 계정 귀속은 "세션 생성 시각에 활성이던 계정"(switch_events) 기준이다. 계정을 처음 등록(save)한 순간에도 그 계정이 활성이므로 이를 기록해야, 첫 전환 전에 만든 세션도 귀속된다.

**Files:** Modify `src/main/infra/app-db.ts`, `src/main/services/account-service.ts` · Test `test/unit/app-db.test.ts`, `test/unit/account-service.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `account-service.test.ts` 에 추가:
```ts
it('records a saved event so later sessions can be attributed to this account', async () => {
  await writeCodexAuth(p, 'acct-A', 'a@x.com');
  const { row } = await svc.saveCurrent('codex', 'work');
  expect(db.listSwitches('codex')).toEqual([expect.objectContaining({ accountRowId: row.id, result: 'saved' })]);
});
```
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `app-db.ts`: `export type SwitchResultCode = 'ok' | 'rolled_back' | 'saved';` (DB 컬럼은 TEXT 라 마이그레이션 불필요). `account-service.ts` 의 `saveCurrent` 에서 `storeSnapshot` 성공 후 `this.d.db.recordSwitch(tool, result.row.id, 'saved');` 를 호출하고 결과를 반환. (`storeSnapshot` 은 SwitchService 의 outgoing 갱신에도 쓰이므로 거기엔 넣지 않는다.)
- [ ] **Step 4: 통과 확인** — 기존 `listSwitches` 를 정확히 비교하던 테스트가 있으면 `saved` 행을 반영해 수정
- [ ] **Step 5: Commit** — `feat: record a saved event when an account is registered`

---

### Task 5: `LibraryService` — 계정 귀속 · 프로젝트 묶기 · 필터 · 읽기

**Files:** Create `src/main/services/library-service.ts` · Test `test/unit/library-service.test.ts`

**규칙**
- 계정 키: 등록 계정 `acct:<rowId>`(라벨 표시) / Claude 미등록 `unreg:<accountId>/<orgId>`(라벨 `미등록 (<email 또는 accountId 앞 8자>)`) / Codex 미귀속 `unassigned`(라벨 `미분류`) / Claude CLI 전용 `cli`(라벨 `CLI 세션 (계정 불명)`).
- Codex 귀속: `listSwitches('codex')` 중 `result ∈ {ok, saved}` 이고 `accountRowId != null` 인 이벤트를 시각순으로 정렬, 세션 `createdAt` 이하의 마지막 이벤트의 계정. 없으면 `unassigned`. 삭제된 계정(행 없음)이면 `unassigned`.
- Claude 귀속: `accountRef` 로 `findAccountByIdentity('claude', accountId, orgId)` → 있으면 `acct:`, 없으면 `unreg:`; `accountRef` 없으면 `cli`.
- 프로젝트: Codex 는 `roots` 중 `samePathOrInside(cwd, root)` 인 첫 프로젝트 → `proj:<id>`(이름 = 프로젝트명, path = root); 아니면 `cwd:<소문자 정규화>`(이름 = `basenameOf(cwd)`, path = cwd). Claude 는 `cowork` → `cowork`(이름 `Cowork 세션`), `remote` → `remote:<cwd>`(이름 `원격: <cwd>`), 그 외 `cwd:`. cwd 가 '' 이면 `unknown`(이름 `작업 폴더 불명`).
- 필터: `account`(키, 없으면 전체), `includeSubagents`(기본 false), `includeArchived`(기본 false).
- 정렬: 세션은 `updatedAt` 내림차순, 프로젝트는 가장 최근 세션 순.
- `read(tool, key)`: 최근 `list` 결과(없으면 새로 목록 생성)에서 key 로 찾고, `file` 이 없으면 `대화 파일을 찾을 수 없습니다` 오류. 목록에 없는 key 는 `알 수 없는 세션` 오류(임의 경로 읽기 차단).

- [ ] **Step 1: 실패하는 테스트** — `test/unit/library-service.test.ts` (Task 2·3 의 fake 도우미로 Codex 스레드 3개(프로젝트 안/밖/서브에이전트), Claude Code 1·CLI 1·Cowork 1 구성):
```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDb } from '../../src/main/infra/app-db.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { LibraryService } from '../../src/main/services/library-service.js';
import { codexStateDb, jsonl, writeRollout } from '../helpers/fake-sessions.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
let db: AppDb;
let lib: LibraryService;

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  lib = new LibraryService({ paths: p, db });
  await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
});

async function codexFixture() {
  const f = await writeRollout(p, 'r.jsonl', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } }]);
  const sdb = codexStateDb(p);
  const ins = sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)');
  ins.run('early', f, 100, 900, 'vscode', 'C:\\work\\proj\\a', '첫 세션', 0);      // 등록 전
  ins.run('late', f, 300, 400, 'vscode', 'C:\\other', '나중 세션', 0);            // 등록 후
  ins.run('sub', f, 350, 350, JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'late' } } }), 'C:\\other', 's', 0);
  sdb.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p1', '프로젝트', '{}', 0);
  sdb.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p1', 0, 'C:\\work\\proj');
  sdb.close();
  const { row } = db.upsertAccount({ tool: 'codex', accountId: 'A', orgId: '', email: 'a@x', displayName: null, label: 'work', snapshotPath: 'x', snapshotAt: 'x' });
  db.recordSwitch('codex', row.id, 'saved', new Date(200_000).toISOString());
  return row;
}

describe('LibraryService codex', () => {
  it('attributes sessions by the account active at creation time and groups by project', async () => {
    const row = await codexFixture();
    const r = lib.list('codex', {});
    expect(r.accounts).toEqual(expect.arrayContaining([{ key: `acct:${row.id}`, label: 'work' }, { key: 'unassigned', label: '미분류' }]));
    const proj = r.projects.find((x) => x.key === 'proj:p1')!;
    expect(proj.name).toBe('프로젝트');
    expect(proj.sessions.map((s) => [s.sessionId, s.accountKey])).toEqual([['early', 'unassigned']]);
    const other = r.projects.find((x) => x.name === 'other')!;
    expect(other.sessions.map((s) => [s.sessionId, s.accountKey])).toEqual([['late', `acct:${row.id}`]]);
    expect(r.projects[0]!.key).toBe('proj:p1'); // 가장 최근(updatedAt 900) 프로젝트가 먼저
  });

  it('filters by account and optionally includes subagents', async () => {
    const row = await codexFixture();
    const onlyWork = lib.list('codex', { account: `acct:${row.id}` });
    expect(onlyWork.projects.flatMap((x) => x.sessions.map((s) => s.sessionId))).toEqual(['late']);
    const withSub = lib.list('codex', { account: `acct:${row.id}`, includeSubagents: true });
    expect(withSub.projects.flatMap((x) => x.sessions.map((s) => s.sessionId)).sort()).toEqual(['late', 'sub']);
  });

  it('reads a listed session and refuses unknown keys', async () => {
    await codexFixture();
    lib.list('codex', {});
    expect(lib.read('codex', 'codex:late').messages[0]!.blocks[0]).toEqual({ kind: 'text', text: 'q' });
    expect(() => lib.read('codex', 'codex:nope')).toThrow('알 수 없는 세션');
  });
});

describe('LibraryService claude', () => {
  it('attributes by index folder: registered, unregistered and CLI-only', async () => {
    const proj = path.join(p.home, '.claude', 'projects');
    await writeFile(path.join(proj, 'C--a', 'c1.jsonl'), jsonl({ type: 'user', cwd: 'C:\\a', message: { role: 'user', content: 'x' } }));
    await writeFile(path.join(proj, 'C--b', 'c2.jsonl'), jsonl({ type: 'user', cwd: 'C:\\b', message: { role: 'user', content: 'y' } }));
    await writeFile(path.join(proj, 'C--c', 'c3.jsonl'), jsonl({ type: 'user', cwd: 'C:\\c', message: { role: 'user', content: 'z' } }));
    const idx = (acct: string, id: string, cli: string) => writeFile(path.join(p.appData, 'Claude', 'claude-code-sessions', acct, 'org', `${id}.json`),
      JSON.stringify({ sessionId: id, cliSessionId: cli, cwd: `C:\\${cli === 'c1' ? 'a' : 'b'}`, title: id, createdAt: '1', lastActivityAt: '2' }));
    await idx('acctReg', 'local_1', 'c1');
    await idx('acctUnreg', 'local_2', 'c2');
    const { row } = db.upsertAccount({ tool: 'claude', accountId: 'acctReg', orgId: 'org', email: 'r@x', displayName: null, label: '개인', snapshotPath: 'x', snapshotAt: 'x' });
    const r = lib.list('claude', {});
    const keyOf = (id: string) => r.projects.flatMap((x) => x.sessions).find((s) => s.sessionId === id)!.accountKey;
    expect(keyOf('c1')).toBe(`acct:${row.id}`);
    expect(keyOf('c2')).toBe('unreg:acctUnreg/org');
    expect(keyOf('c3')).toBe('cli');
    expect(r.accounts.find((a) => a.key === 'unreg:acctUnreg/org')!.label).toMatch(/^미등록/);
  });
});
```

- [ ] **Step 2: 실패 확인**

- [ ] **Step 3: 구현** — `src/main/services/library-service.ts`:
```ts
import type { ToolId } from '../core/auth-bundle.js';
import type { IrSession } from '../core/ir.js';
import { basenameOf, samePathOrInside } from '../core/win-path.js';
import type { AppDb } from '../infra/app-db.js';
import type { PathProvider } from '../infra/path-provider.js';
import { listClaudeSessions, readClaudeSession } from '../providers/claude/sessions.js';
import { listCodexSessions, readCodexSession, type CodexProject } from '../providers/codex/sessions.js';
import type { SessionSummary } from '../providers/types.js';

export interface LibraryAccount { key: string; label: string }
export interface LibrarySession extends SessionSummary { accountKey: string; accountLabel: string }
export interface LibraryProject { key: string; name: string; path?: string; sessions: LibrarySession[] }
export interface LibraryListOptions { account?: string; includeSubagents?: boolean; includeArchived?: boolean }
export interface LibraryList { accounts: LibraryAccount[]; projects: LibraryProject[] }

export class LibraryService {
  private readonly lastListed = new Map<ToolId, Map<string, SessionSummary>>();

  constructor(private readonly d: { paths: PathProvider; db: AppDb }) {}

  list(tool: ToolId, opts: LibraryListOptions): LibraryList {
    const { sessions, projects } = tool === 'codex' ? listCodexSessions(this.d.paths) : { sessions: listClaudeSessions(this.d.paths), projects: [] as CodexProject[] };
    this.lastListed.set(tool, new Map(sessions.map((s) => [s.key, s])));

    const attribute = tool === 'codex' ? this.codexAttributor() : this.claudeAttributor();
    const accounts = new Map<string, string>();
    const groups = new Map<string, LibraryProject>();

    for (const s of sessions) {
      const acc = attribute(s);
      accounts.set(acc.key, acc.label);
      if (!opts.includeSubagents && s.kind === 'subagent') continue;
      if (!opts.includeArchived && s.archived) continue;
      if (opts.account && opts.account !== acc.key) continue;
      const g = groupOf(s, projects);
      const proj = groups.get(g.key) ?? { ...g, sessions: [] };
      proj.sessions.push({ ...s, accountKey: acc.key, accountLabel: acc.label });
      groups.set(g.key, proj);
    }

    const list = [...groups.values()];
    for (const pr of list) pr.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    list.sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
    return { accounts: [...accounts].map(([key, label]) => ({ key, label })), projects: list };
  }

  read(tool: ToolId, key: string): IrSession {
    const known = this.lastListed.get(tool) ?? (this.list(tool, {}), this.lastListed.get(tool)!);
    const s = known.get(key);
    if (!s) throw new Error('알 수 없는 세션입니다');
    if (!s.file) throw new Error('대화 파일을 찾을 수 없습니다');
    return tool === 'codex' ? readCodexSession(s.file, s.sessionId, s.title) : readClaudeSession(s.file, s.sessionId, s.title);
  }

  private codexAttributor(): (s: SessionSummary) => LibraryAccount {
    const rows = new Map(this.d.db.listAccounts('codex').map((a) => [a.id, a]));
    const events = this.d.db
      .listSwitches('codex')
      .filter((e) => (e.result === 'ok' || e.result === 'saved') && e.accountRowId !== null)
      .map((e) => ({ at: Date.parse(e.switchedAt), id: e.accountRowId! }))
      .sort((a, b) => a.at - b.at);
    return (s) => {
      let id: number | undefined;
      for (const e of events) { if (e.at <= s.createdAt) id = e.id; else break; }
      const row = id !== undefined ? rows.get(id) : undefined;
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

function groupOf(s: SessionSummary, projects: CodexProject[]): { key: string; name: string; path?: string } {
  if (s.kind === 'cowork') return { key: 'cowork', name: 'Cowork 세션' };
  if (s.remote) return { key: `remote:${s.cwd}`, name: `원격: ${s.cwd}` };
  if (!s.cwd) return { key: 'unknown', name: '작업 폴더 불명' };
  for (const p of projects) {
    const root = p.roots.find((r) => samePathOrInside(s.cwd, r));
    if (root) return { key: `proj:${p.id}`, name: p.name, path: root };
  }
  return { key: `cwd:${s.cwd.toLowerCase()}`, name: basenameOf(s.cwd), path: s.cwd };
}
```

- [ ] **Step 4: 통과 확인** — 테스트 PASS, tsc, 전체 PASS
- [ ] **Step 5: Commit** — `feat(services): add LibraryService with account attribution and project grouping`

---

### Task 6: RPC — `libraryList`, `librarySession`

**Files:** Modify `src/rpc/handlers.ts`, `src/rpc/server.ts` · Test `test/unit/rpc-handlers.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `rpc-handlers.test.ts` 에 추가:
  - `libraryList { tool: 'codex' }` 가 `{ accounts, projects }` 를 반환(위 fake 도우미로 스레드 1개).
  - `libraryList { tool: 'bogus' }` → 도구 검증 오류.
  - `librarySession { tool: 'codex', key: 'codex:<id>' }` → `{ session }` 반환, `messages` 는 최대 300개·텍스트 블록 8000자까지 잘림(`messagesTruncated: boolean` 포함).
  - `librarySession` 이 목록에 없는 key 면 '알 수 없는 세션' 오류.
  - 두 메서드는 mutating 잠금과 무관: `switch` 진행 중에도 `libraryList` 가 성공.
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**
  - `createHandlers(deps)` 가 `new LibraryService({ paths: deps.paths, db: deps.db })` 를 하나 만들어 둔다.
  - `libraryList(params)`: `tool` 검증(기존 헬퍼 재사용), `account` 는 선택 문자열(≤ 200자), `includeSubagents`/`includeArchived` 는 선택 boolean. `library.list(tool, opts)` 반환.
  - `librarySession(params)`: `tool` 검증, `key` 는 필수 문자열(≤ 300자). `const s = library.read(tool, key)`; 반환 `{ session: { ...s, messages: s.messages.slice(0, 300).map(clip) }, messagesTruncated: s.messages.length > 300 }` — `clip` 은 `text`/`compactSummary` 블록의 text 를 `truncate(text, 8000)` 로 자른다.
  - server.ts 는 메서드 디스패치 테이블에 두 메서드를 추가(잠금 밖에서 실행).
- [ ] **Step 4: 통과 확인** — 전체 PASS, tsc
- [ ] **Step 5: 실제 백엔드 읽기 전용 스모크** — `node --import tsx src/rpc/server.ts` 에 `{"type":"request","id":1,"method":"libraryList","params":{"tool":"codex"}}` 한 줄을 보내 응답의 프로젝트 수·세션 수만 확인(제목/내용 출력 금지)
- [ ] **Step 6: Commit** — `feat(rpc): expose read-only library list and session preview`

---

### Task 7: GUI — [라이브러리] 탭

**Files:** Modify `gui/index.html`, `gui/renderer.js`, `gui/style.css`

**요구사항**
- 상단에 탭 2개: [계정] (기존 화면 전체) / [라이브러리]. 탭 전환은 `hidden` 클래스로.
- 라이브러리 툴바: 도구 선택(ChatGPT(Codex) / Claude 라디오), 계정 선택(`<select>`: "전체" + `accounts`), 체크박스 "서브에이전트 포함", "보관됨 포함", [새로고침].
- 본문 2단: 왼쪽 목록(프로젝트 제목 행 — 이름, 세션 수, 경로는 `title` 속성 — 클릭 시 접기/펼치기; 그 아래 세션 행 — 제목, 최근 활동(`YYYY-MM-DD HH:mm`), 계정 라벨, 배지: `보관됨`/`서브에이전트`/`원격`/`Cowork`/`CLI`), 오른쪽 미리보기.
- 미리보기: 상단에 제목·작업 폴더·모델·통계(`도구 호출 N · 추론 제외 N · 시스템 제외 N · 알 수 없는 줄 N`), 아래 메시지 목록: 사용자/어시스턴트 말풍선(역할별 색), 도구 블록은 접힌 `<details>` (`🔧 이름` 요약, 펼치면 입력/출력 `<pre>`, 오류면 붉은 테두리), `compactSummary` 는 회색 "이전 대화 요약" 상자. `messagesTruncated` 면 하단에 "앞 300개 메시지만 표시" 안내.
- **모든 동적 문자열은 `textContent`/`createElement` 로 넣는다(innerHTML 금지).**
- 목록/미리보기 요청 중에는 "불러오는 중…" 표시, 오류는 로그 영역과 미리보기에 표시. 계정 탭의 버튼 잠금(`setBusy`)과는 독립 — 라이브러리 조회는 전환 중에도 가능.
- 탭을 처음 열 때 한 번 자동 조회, 도구/필터 변경 시 재조회.

- [ ] **Step 1: 구현** (위 요구사항)
- [ ] **Step 2: 수동 확인** — `node --check gui/renderer.js`; 컨트롤러가 GUI 를 띄워 확인(구현자는 GUI 를 띄우지 않음)
- [ ] **Step 3: Commit** — `feat(gui): add library tab with project/session list and transcript preview`

---

### Task 8: 문서

**Files:** Modify `docs/superpowers/specs/2026-09-23-ai-account-bridge-design.md`, `docs/architecture.md`, `README.md`, 이 계획서

- [ ] 설계 §6 표의 V8, V10 행에 결과(위 "사전 검증 결과") 기록, V5 는 Plan 3 로 이동 표기
- [ ] 아키텍처 §5.1 에 `~\.codex` → `C:\codex_home` 정션과 `\\?\` 접두어, `threads.source` 서브에이전트 JSON, 주입 문맥 필터 규칙 추가; §5.2 에 Cowork 구조(V8)와 폴더 인코딩 예외(V10) 추가; §3.2 IR 을 실제 `ir.ts` 에 맞게 갱신(`importNotice` 는 Plan 3)
- [ ] 설계 §4.3 계정 귀속 규칙에 `saved` 이벤트 반영
- [ ] README 에 라이브러리 탭 설명 추가, 상태 문구를 "Plan 2(조회) 구현" 으로 갱신
- [ ] Commit — `docs: record V8/V10 and document the library`

---

## 자체 점검 (계획 작성자)
- 설계 §4.3 요구(계정 필터 → 프로젝트 → 세션 → 미리보기, Codex 태그/미분류, Claude 폴더 귀속·CLI 세션 그룹, 읽기 전용) → Task 2~7 에 대응. §2.1 F3 의 Cowork 읽기 → Task 3.
- 타입/이름 일관성: `SessionSummary`(Task 2) → reader(Task 2·3) → `LibraryService`(Task 5) → RPC(Task 6) → GUI(Task 7). `IrBuilder` 메서드 `text/toolCall/toolOutput/compactSummary/build` 는 Task 1 정의와 동일.
- 원본 파일 쓰기 없음: Codex DB 는 `readonly: true`, 나머지는 `readFileSync`/`readdirSync` 만 사용.

---

## 구현 중 변경 사항 (2026-09-28)

계획 작성 시점의 코드 스케치와 실제 구현(`f7c46ae..HEAD`, Task 1~7)이 갈라진 지점과, 실 데이터로 확인한 결과를 기록한다.

**Reader — 스트리밍(비동기)으로 변경**
- `readCodexSession`/`readClaudeSession` 은 계획의 `fs.readFileSync` + `split('\n')` 대신 `readline.createInterface` 로 한 줄씩 비동기 스트리밍한다(`for await`). rollout/세션 파일이 실사용 환경에서 최대 ~120MB 까지 커져, 전체를 메모리에 올려 문자열로 쪼개는 방식은 부담이 크다고 판단했다. `LibraryService.read`/RPC `librarySession` 도 이에 맞춰 `async`.

**Codex reader**
- 주입 문맥 필터를 메시지 단위가 아니라 **content 항목 단위**로 바꿨다 — 실제 파일에서 `# AGENTS.md instructions` 같은 주입 문맥과 사용자의 진짜 프롬프트가 **같은 user 메시지의 서로 다른 content 항목**으로 함께 온다. 메시지 전체를 버리면 진짜 프롬프트까지 사라지므로, 주입 문맥 항목만 걸러내고 나머지를 합친다(걸러낸 게 있으면 메시지당 `droppedSystem` 1회만 증가).
- `function_call_output`(및 `tool_search_output`) 의 `output` 이 문자열이 아니라 `{type:'input_text',text}[]` 배열로 오는 경우를 관찰해 `outputText` 헬퍼로 두 형태 모두 처리하도록 확장했다.
- `web_search_call`(결과 없이 호출만 있을 수 있음)과 `tool_search_call`/`tool_search_output` 줄 타입을 추가로 tool 블록에 매핑했다 — 계획에는 없던 실측 타입.
- Codex 세션 DB(`state_5.sqlite`)는 `readonly: true` 로 열되, `fileMustExist` 만으로는 손상된/버전이 다른 SQLite 파일을 걸러내지 못해 여는 직후 `SELECT 1` 프로브 쿼리를 한 번 던지고, 실패하면 "Codex 세션 DB를 열 수 없습니다: …" 로 사용자 친화적인 오류로 감싼다.

**Claude reader**
- `IrBuilder.toolOutput` 이 아직 보지 못한 `tool_use` 의 결과를 `pendingOutputs` 에 임시 보관하도록 확장했다 — 실 데이터에서 `tool_result` 가 짝인 `tool_use` 보다 **파일 앞쪽에** 나오는 경우를 발견했다(계획의 "직전 tool 블록의 output" 가정이 항상 성립하지 않음). `toolCall` 이 나중에 오면 대기 중이던 출력과 즉시 짝짓는다.
- Desktop 인덱스 항목 중 `cliSessionId` 가 빈 경우가 있어, 이때는 인덱스 자체의 `sessionId`(또는 파일명)를 세션 ID 로 대신 써서 다른 세션과 키 충돌을 피한다(`fromIndex` 의 `fallbackId`).
- 슬래시 명령 실행 시 Claude Code 가 user 메시지로 끼워 넣는 합성 텍스트(`<command-name>`, `<command-message>`, `<command-args>`, `<local-command-stdout/stderr>`, `<system-reminder>` 로 시작)를 실제 대화가 아닌 system 으로 분류해 폐기하도록 `SYNTHETIC_USER_TEXT` 필터를 추가했다 — 계획에는 없던 실측 케이스.
- 실 데이터에서 인덱스는 있지만 `~\.claude\projects\` 에 원본 JSONL 이 없는 세션이 **약 34개** 관찰됐다(Claude Code 의 30일 지난 로컬 대화 자동 정리로 추정). 목록에는 노출하되 "대화 기록 없음" 배지를 달아 미리보기를 막고, 이관(Plan 3) 대상에서는 제외하기로 했다(설계 §4.3 갱신).

**LibraryService / RPC**
- 계정 등록(`save`) 시 `saved` switch 이벤트를 남기는 것은 계획대로 구현했고(Task 4), Codex 귀속 판정은 `result ∈ {ok, saved}` 이벤트의 타임라인을 따른다.
- 계정 **삭제** 시 그 계정을 가리키던 `switch_events.account_id` 가 NULL 로 남는데(§4.1 규칙), 귀속 판정에서 이 NULL 이벤트를 걸러내지 않고 타임라인에 그대로 유지하도록 했다 — 그래야 삭제 이후에 만든 세션이 삭제된 계정보다 앞선 다른 계정으로 잘못 되돌아가 귀속되지 않는다(계획에는 없던 세부 규칙, `codexAttributor` 주석 참고).
- Codex 프로젝트 귀속은 계획의 "첫 번째로 일치하는 루트" 대신, 일치하는 루트 중 **경로가 가장 깊은(긴) 프로젝트**를 우선하도록 `groupOf` 를 바꿨다 — 여러 프로젝트의 루트가 중첩된 경우 더 구체적인 프로젝트로 묶기 위함.
- RPC `libraryList` 는 세션 원본 파일 경로를 렌더러에 그대로 보내지 않고 `hasTranscript: boolean` 으로만 바꿔 보낸다(`toLibrarySessionView`, `file` 필드 제거) — 렌더러가 임의 경로를 알 필요가 없고, "대화 기록 없음" 배지도 이 값으로 그린다.
- RPC `librarySession` 은 계획의 메시지 300개 자르기에 더해, 도구 블록까지 포함해 **최대 2000블록**으로 한 번 더 자르고(`blocksTruncated`), `text`/`compactSummary` 블록의 글자 수도 **8000자**로 자른다 — 도구 호출이 많은 세션 하나가 응답을 지나치게 키우는 것을 막기 위한 계획 대비 추가 안전장치.

**E2E 확인 (2026-09-28, 실 데이터, GUI 를 통해 수동 확인)**
- Codex: 기본 필터(서브에이전트/보관됨 제외)로 프로젝트 37개 · 세션 61개 표시.
- Claude: 프로젝트 21개 · 세션 107개 표시, 이 중 43개가 "대화 기록 없음"(원본 파일 없음).
- 목록/미리보기 정상 렌더링, 페이지 오류 없음.
