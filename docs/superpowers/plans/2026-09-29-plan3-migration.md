# Plan 3 — 도구 간·계정 간 세션 이관 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 라이브러리에서 고른 세션(또는 프로젝트의 세션들)을 **Codex → Claude Code**, **Claude Code/Cowork → Codex** 로 변환해 대상 앱 목록에 등록하고, **Claude 계정 A → B** 로 공유(인덱스 복사)한다. 원본은 절대 수정하지 않는다.

**Architecture:** 원본 reader(Plan 2) → `IrSession` → 도구별 **순수 빌더**(IR + 템플릿 → 대상 파일 내용) → **쓰기 모듈**(새 파일 생성·기존 파일 백업·실패 시 되돌림) → `ImportService` 가 대상 앱을 `SwitchService.runWithAppStopped` 로 종료한 상태에서 실행하고 이관 이력을 기록. 대상 앱의 필수 필드를 전부 알 수 없으므로 **대상 앱의 기존 항목(Claude Desktop 인덱스 JSON, Codex `threads` 행·`session_meta`)을 템플릿으로 복제**한 뒤 식별자·경로·제목·시각·본문만 바꾼다.

**Tech Stack:** 기존과 동일(Node 22, TypeScript 7 NodeNext ESM, better-sqlite3, Vitest, Electron gui/).

**관련 문서:** [설계](../specs/2026-09-23-ai-account-bridge-design.md) §4.4, §5 · [아키텍처](../../architecture.md) §5, §6 · [Plan 2](2026-09-28-plan2-library.md)

---

## 쓰기 대상 형식 (2026-09-29 관찰 — 키/고정값만)

**Claude Code 세션 JSONL** (`~\.claude\projects\<enc(cwd)>\<uuid>.jsonl`, `enc = cwd.replace(/[^A-Za-z0-9]/g,'-')` — V10)
- 공통: `parentUuid`(첫 줄 null, 이후 직전 줄 uuid), `isSidechain:false`, `type`, `uuid`, `timestamp`(ISO), `userType:'external'`, `entrypoint:'claude-desktop'`, `cwd`, `sessionId`, `version`(예 `2.1.247`), `gitBranch`
- user: `message:{role:'user', content:string}` (+ `promptId`, `permissionMode`, `origin:{kind:'human'}`, `promptSource` — 선택)
- assistant: `message:{model, id:'msg_…', type:'message', role:'assistant', content:[{type:'text',text}], stop_reason:'end_turn', stop_sequence:null, usage:{…}}` (+ `requestId` — 선택)
- 제목: `{type:'custom-title', customTitle, sessionId}`

**Claude Desktop 인덱스** (`%APPDATA%\Claude\claude-code-sessions\<accountUuid>\<orgUuid>\local_<uuid>.json`) — 같은 폴더의 기존 `local_*.json` 하나를 템플릿으로 복제하고 `sessionId, cliSessionId, cwd, originCwd, title, titleSource, createdAt, lastActivityAt, lastFocusedAt, isArchived, completedTurns` 만 교체(템플릿 필드 타입 유지).

**Codex** — `state_5.sqlite` `threads`: 필수(NOT NULL) `rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode` + 기본값 있는 다수. 경로 컬럼은 `\\?\` 접두어 사용. 최신 행은 `history_mode:'paginated'` + 봉투 `ordinal` 을 쓰지만 과거 행 `legacy` 도 앱이 계속 읽으므로 **`legacy` 형식으로 쓴다**(`{timestamp,type,payload}` 봉투, `history_mode='legacy'`). rollout 첫 줄 `session_meta` 는 템플릿 rollout 의 것을 복제(`base_instructions, dynamic_tools, originator, cli_version, model_provider` 유지)하고 `id/session_id/timestamp/cwd` 교체, `history_mode/context_window/git` 제거. 메시지: `response_item/message` role user(`input_text`)/assistant(`output_text`), id `msg_<hex>`. `session_index.jsonl` 에 `{id, thread_name, updated_at}` 추가. `thread_history_1.sqlite` 는 건드리지 않음(V7 에서 앱의 재구성 확인).

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/main/core/ir.ts` (수정) | `importNotice` 블록 타입 |
| `src/main/core/render.ts` | IR 블록 → 대상 도구용 텍스트(도구 요약·압축 요약·이관 안내), 역할 교대 정규화 |
| `src/main/providers/claude/writer.ts` | 순수: `encodeProjectDir`, `buildClaudeTranscript`, `buildClaudeIndex` / IO: `writeClaudeSession`, `shareClaudeIndex` |
| `src/main/providers/codex/writer.ts` | 순수: `buildCodexRollout`, `buildThreadRow` / IO: `writeCodexSession` |
| `src/main/infra/fs-transaction.ts` | 생성 파일 추적·수정 파일 백업·rollback |
| `src/main/infra/app-db.ts` (수정) | 마이그레이션 2: `imports` 테이블 |
| `src/main/services/switch-service.ts` (수정) | `runWithAppStopped(tool, label, fn)` — 기존 종료/재실행/진행/동시실행 방지 재사용 |
| `src/main/services/import-service.ts` | 이관 오케스트레이션, 중복 확인, 이력 |
| `src/rpc/handlers.ts`, `src/cli/index.ts`, `gui/*` (수정) | 가져오기 UI/명령 |

---

### Task 1: IR `importNotice` + 텍스트 렌더링

**Files:** Modify `src/main/core/ir.ts` · Create `src/main/core/render.ts` · Test `test/unit/render.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/render.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { IrSession } from '../../src/main/core/ir.js';
import { blockToText, prepareForImport } from '../../src/main/core/render.js';

const ir = (messages: IrSession['messages']): IrSession => ({
  tool: 'codex', sessionId: 's1', title: '버그 수정', cwd: 'C:\\w', messages,
  stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 },
});

describe('blockToText', () => {
  it('renders tool blocks as a readable summary', () => {
    expect(blockToText({ kind: 'tool', name: 'shell', input: '{"cmd":"ls"}', output: 'a.txt', isError: false }, 'codex'))
      .toBe('🔧 [Codex: shell] {"cmd":"ls"}\n→ a.txt');
    expect(blockToText({ kind: 'tool', name: 'Read', input: '{}', output: 'boom', isError: true }, 'claude'))
      .toBe('🔧 [Claude: Read] {}\n→ (오류) boom');
    expect(blockToText({ kind: 'tool', name: 'x', input: 'i' }, 'codex')).toBe('🔧 [Codex: x] i\n→ (결과 없음)');
  });
  it('renders compact summaries and import notices', () => {
    expect(blockToText({ kind: 'compactSummary', text: '요약' }, 'codex')).toBe('[이전 대화 요약]\n요약');
    expect(blockToText({ kind: 'importNotice', fromTool: 'codex', title: 't', sessionId: 'id1', createdAt: '2026-09-01T00:00:00.000Z' }, 'codex'))
      .toBe("이 세션은 Codex 의 't' 에서 가져왔습니다 (원본 ID id1, 2026-09-01T00:00:00.000Z)");
  });
});

describe('prepareForImport', () => {
  it('starts with a user message containing the import notice, merged with a leading user message', () => {
    const out = prepareForImport(ir([{ role: 'user', blocks: [{ kind: 'text', text: '고쳐줘' }] }, { role: 'assistant', blocks: [{ kind: 'text', text: 'ok' }] }]), '2026-09-01T00:00:00.000Z');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[0]!.text).toBe("이 세션은 Codex 의 '버그 수정' 에서 가져왔습니다 (원본 ID s1, 2026-09-01T00:00:00.000Z)\n\n고쳐줘");
  });
  it('inserts the notice as its own user message when the transcript starts with the assistant', () => {
    const out = prepareForImport(ir([{ role: 'assistant', blocks: [{ kind: 'text', text: 'hi' }] }]), 'T');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
  it('joins blocks of one message with blank lines and drops empty messages', () => {
    const out = prepareForImport(ir([
      { role: 'user', blocks: [{ kind: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'a' }, { kind: 'tool', name: 'n', input: 'i', output: 'o' }] },
      { role: 'user', blocks: [{ kind: 'text', text: '   ' }] },
    ]), 'T');
    expect(out).toHaveLength(2);
    expect(out[1]!.text).toBe('a\n\n🔧 [Codex: n] i\n→ o');
  });
});
```
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**

`src/main/core/ir.ts` 의 `IrBlock` 에 추가:
```ts
  | { kind: 'importNotice'; fromTool: ToolId; title?: string; sessionId: string; createdAt: string };
```

`src/main/core/render.ts`:
```ts
import type { ToolId } from './auth-bundle.js';
import type { IrBlock, IrSession } from './ir.js';

const TOOL_NAME: Record<ToolId, string> = { codex: 'Codex', claude: 'Claude' };

export function blockToText(b: IrBlock, source: ToolId): string {
  switch (b.kind) {
    case 'text': return b.text;
    case 'tool': {
      const out = b.output === undefined ? '(결과 없음)' : b.isError ? `(오류) ${b.output}` : b.output;
      return `🔧 [${TOOL_NAME[source]}: ${b.name}] ${b.input}\n→ ${out}`;
    }
    case 'compactSummary': return `[이전 대화 요약]\n${b.text}`;
    case 'importNotice': return `이 세션은 ${TOOL_NAME[b.fromTool]} 의 '${b.title ?? '(제목 없음)'}' 에서 가져왔습니다 (원본 ID ${b.sessionId}, ${b.createdAt})`;
  }
}

export interface PreparedMessage { role: 'user' | 'assistant'; text: string; timestamp?: string }

// 대상 도구에 쓸 메시지 목록: 텍스트로 렌더링, 빈 메시지 제거, 같은 역할 연속 병합, 첫 메시지는 이관 안내를 포함한 user.
export function prepareForImport(ir: IrSession, sourceCreatedAt: string): PreparedMessage[] {
  const notice = blockToText({ kind: 'importNotice', fromTool: ir.tool, title: ir.title, sessionId: ir.sessionId, createdAt: sourceCreatedAt }, ir.tool);
  const out: PreparedMessage[] = [{ role: 'user', text: notice }];
  for (const m of ir.messages) {
    const text = m.blocks.map((b) => blockToText(b, ir.tool)).filter((t) => t.trim() !== '').join('\n\n');
    if (text.trim() === '') continue;
    const last = out[out.length - 1]!;
    if (last.role === m.role) last.text = `${last.text}\n\n${text}`;
    else out.push({ role: m.role, text, timestamp: m.timestamp });
  }
  return out;
}
```
- [ ] **Step 4: 통과 확인** (tsc, 전체 PASS — `IrBlock` 확장으로 GUI/handlers 의 switch 가 깨지면 `importNotice` 를 무시하도록 보완)
- [ ] **Step 5: Commit** — `feat(core): add import notice block and text rendering for migration`

---

### Task 2: `imports` 이력 테이블

**Files:** Modify `src/main/infra/app-db.ts` · Test `test/unit/app-db.test.ts`

- [ ] **Step 1: 실패하는 테스트** — 추가:
```ts
describe('AppDb imports', () => {
  it('records imports and finds previous ones by source and target', () => {
    const at = '2026-09-29T00:00:00.000Z';
    db.recordImport({ srcTool: 'codex', srcKey: 'codex:t1', dstTool: 'claude', dstAccountKey: 'acctA/orgA', dstSessionId: 'new-1', importedAt: at, statsJson: '{}' });
    expect(db.findImports('codex', 'codex:t1', 'claude', 'acctA/orgA')).toEqual([
      { srcTool: 'codex', srcKey: 'codex:t1', dstTool: 'claude', dstAccountKey: 'acctA/orgA', dstSessionId: 'new-1', importedAt: at, statsJson: '{}' },
    ]);
    expect(db.findImports('codex', 'codex:t1', 'claude', 'other')).toEqual([]);
  });
  it('migrates an existing v1 database', () => {
    // 새 AppDb 는 user_version 2 로 올라가야 한다
    expect((db as unknown as { db: { pragma(s: string, o: object): unknown } }).db.pragma('user_version', { simple: true })).toBe(2);
  });
});
```
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — `MIGRATIONS` 에 두 번째 항목 추가(첫 항목은 절대 수정하지 않음):
```sql
CREATE TABLE imports (
  id               INTEGER PRIMARY KEY,
  src_tool         TEXT NOT NULL,
  src_key          TEXT NOT NULL,
  dst_tool         TEXT NOT NULL,
  dst_account_key  TEXT NOT NULL,   -- claude: '<accountUuid>/<orgUuid>', codex: ''
  dst_session_id   TEXT NOT NULL,
  imported_at      TEXT NOT NULL,
  stats_json       TEXT NOT NULL
);
CREATE INDEX imports_src ON imports (src_tool, src_key, dst_tool, dst_account_key);
```
`ImportRecord` 인터페이스(camelCase), `recordImport(r)`, `findImports(srcTool, srcKey, dstTool, dstAccountKey)`(imported_at 순).
- [ ] **Step 4: 통과 확인** — `db` 필드가 private 이면 테스트는 `// @ts-expect-error` 없이 위 캐스팅으로 접근
- [ ] **Step 5: Commit** — `feat(infra): add imports history table`

---

### Task 3: `FsTransaction`

**Files:** Create `src/main/infra/fs-transaction.ts` · Test `test/unit/fs-transaction.test.ts`

**동작:** `createFile(path, data)`(이미 있으면 오류, 부모 폴더 생성, 생성 기록), `backupThenModify(path, fn)`(원본 바이트를 메모리+`<backupDir>` 에 저장한 뒤 fn 실행), `rollback()`(생성 파일 삭제 → 수정 파일 원본 복원, 역순), `commit()`(기록 비움). rollback 은 개별 실패를 모아 마지막에 하나의 오류로 던진다.

- [ ] **Step 1: 테스트** — 생성 후 rollback 하면 파일 없음 / 수정 후 rollback 하면 원본 복원 / createFile 이 기존 파일이면 거부 / commit 후 rollback 은 아무것도 안 함.
- [ ] **Step 2~4:** 구현, 통과
- [ ] **Step 5: Commit** — `feat(infra): add FsTransaction for migration writes`

---

### Task 4: Claude writer

**Files:** Create `src/main/providers/claude/writer.ts` · Test `test/unit/claude-writer.test.ts`

**순수 함수**
```ts
export function encodeProjectDir(cwd: string): string { return normalizeWinPath(cwd).replace(/[^A-Za-z0-9]/g, '-'); }

export interface ClaudeTranscriptOptions {
  sessionId: string;          // 새 cliSessionId (uuid)
  cwd: string;
  version: string;            // 대상 기기의 최신 Claude Code 버전(가장 최근 세션 줄의 version), 없으면 '2.1.0'
  gitBranch?: string;
  title: string;              // '[Codex] 원제목'
  now: () => string;          // ISO, 테스트 주입
  uuid: () => string;         // 테스트 주입
}

// PreparedMessage[] → JSONL 줄(문자열 배열). 첫 줄 parentUuid null, 이후 직전 uuid. 끝에 custom-title 줄.
export function buildClaudeTranscript(messages: PreparedMessage[], model: string | undefined, o: ClaudeTranscriptOptions): string[]

// 템플릿 인덱스(JSON 객체)를 깊은 복사해 필드만 교체. createdAt 등은 템플릿의 타입(number|string)을 유지.
export function buildClaudeIndex(template: Record<string, unknown>, o: { indexId: string; cliSessionId: string; cwd: string; title: string; nowMs: number; turns: number }): Record<string, unknown>
```
- user 줄: `{ parentUuid, isSidechain:false, type:'user', message:{ role:'user', content:text }, uuid, timestamp, userType:'external', entrypoint:'claude-desktop', cwd, sessionId, version, gitBranch: gitBranch ?? '' }`
- assistant 줄: `{ parentUuid, isSidechain:false, type:'assistant', message:{ model: model ?? 'imported', id:'msg_imported_'+uuid 앞 12자, type:'message', role:'assistant', content:[{type:'text', text}], stop_reason:'end_turn', stop_sequence:null, usage:{ input_tokens:0, output_tokens:0 } }, uuid, timestamp, userType, entrypoint, cwd, sessionId, version, gitBranch }`
- timestamp: 메시지의 원래 timestamp 가 있으면 그대로, 없으면 `now()`.
- 인덱스 교체 필드: `sessionId=indexId`(`local_<uuid>`), `cliSessionId`, `cwd`, `originCwd`, `title`, `titleSource:'user'`, `createdAt/lastActivityAt/lastFocusedAt = nowMs`(템플릿이 문자열이면 `String(nowMs)`), `isArchived:false`, `completedTurns = turns`. 템플릿에 해당 키가 없으면 추가하지 않는다(단 sessionId/cliSessionId/cwd/title 은 항상 설정).

**IO 함수**
```ts
// 대상 계정 폴더의 최신 local_*.json 을 템플릿으로 사용. 없으면 오류(대상 계정에서 Code 세션을 하나 만든 뒤 다시 시도).
export async function writeClaudeSession(paths: PathProvider, tx: FsTransaction, input: {
  ir: IrSession; sourceCreatedAt: string; account: { accountId: string; orgId: string };
  cwd: string; now?: () => Date; uuid?: () => string;
}): Promise<{ cliSessionId: string; indexId: string; transcriptPath: string; indexPath: string }>

// Claude A → B 공유: 원본 인덱스를 복제해 B 폴더에 새 sessionId 로 저장(cliSessionId·본문 공유). 원본 인덱스가 없으면 오류.
export async function shareClaudeIndex(paths: PathProvider, tx: FsTransaction, input: {
  sourceIndexPath: string; to: { accountId: string; orgId: string }; uuid?: () => string; now?: () => Date;
}): Promise<{ indexId: string; indexPath: string }>
```
- 전사 파일: `~\.claude\projects\<encodeProjectDir(cwd)>\<cliSessionId>.jsonl` — `tx.createFile`.
- 인덱스: `%APPDATA%\Claude\claude-code-sessions\<acct>\<org>\<indexId>.json` — `tx.createFile`.
- version: `~\.claude\projects` 에서 가장 최근 수정된 `.jsonl` 의 마지막 `version` 값(앞 2MB 스캔), 없으면 `'2.1.0'`.

- [ ] **Step 1: 테스트** — (a) `encodeProjectDir('\\\\?\\C:\\Users\\a b\\x')` = `C--Users-a-b-x`; (b) `buildClaudeTranscript` 가 user/assistant 줄과 parentUuid 체인, custom-title 줄을 만들고 모든 줄이 `JSON.parse` 가능; (c) `buildClaudeIndex` 가 템플릿 타입을 유지(문자열 createdAt 템플릿 → 문자열)하고 원본 템플릿 객체는 변경하지 않음; (d) `writeClaudeSession` 이 임시 폴더에 두 파일을 만들고, 이후 `listClaudeSessions` 가 그 세션을 kind 'code' 로, `readClaudeSession` 이 이관 안내 + 원문 텍스트로 읽음(왕복); (e) 대상 계정 폴더에 템플릿이 없으면 오류; (f) `tx.rollback()` 후 두 파일이 모두 없음; (g) `shareClaudeIndex` 가 B 폴더에 cliSessionId 가 같은 새 인덱스를 만듦.
- [ ] **Step 2~4:** 구현, 통과
- [ ] **Step 5: Commit** — `feat(claude): write imported sessions and share indexes`

---

### Task 5: Codex writer

**Files:** Create `src/main/providers/codex/writer.ts` · Test `test/unit/codex-writer.test.ts`

**순수 함수**
```ts
// 템플릿 session_meta payload(객체)를 복제해 교체. history_mode/context_window/git 제거.
export function buildCodexRollout(messages: PreparedMessage[], metaTemplate: Record<string, unknown>, o: {
  threadId: string; cwd: string; now: () => string; hex: () => string;
}): string[]
// 줄: {timestamp, type:'session_meta', payload:{...template, id, session_id, timestamp, cwd:'\\\\?\\'+cwd}} 다음 각 메시지
//   user → {timestamp, type:'response_item', payload:{type:'message', id:'msg_'+hex(), role:'user', content:[{type:'input_text', text}]}}
//   assistant → {…, role:'assistant', content:[{type:'output_text', text}]}

// 템플릿 threads 행(객체)을 복제해 교체. 템플릿에 없는 컬럼은 추가하지 않는다.
export function buildThreadRow(template: Record<string, unknown>, o: {
  threadId: string; rolloutPath: string; cwd: string; title: string; firstUserMessage: string; nowMs: number;
  projectId: string | null; templateCwd: string;
}): Record<string, unknown>
```
- 교체: `id, rollout_path('\\\\?\\'+path), cwd('\\\\?\\'+cwd), title, name(=title), preview(첫 사용자 메시지 앞 200자), first_user_message(앞 200자), created_at/updated_at(초), created_at_ms/updated_at_ms/recency_at_ms(ms), recency_at(초), tokens_used:0, archived:0, archived_at:null, git_sha/git_branch/git_origin_url:null, history_mode:'legacy', thread_source:'user', source:'vscode', agent_nickname/agent_role/agent_path:null, is_pinned:0, thread_section_id/section_position/section_entered_at_ms:null, project_id`.
- `sandbox_policy`: 템플릿 문자열 안의 템플릿 cwd(JSON 이스케이프된 형태, `\\?\` 유무 모두)를 새 cwd 로 치환. 치환 결과가 JSON 파싱 불가면 오류.

**IO 함수**
```ts
export async function writeCodexSession(paths: PathProvider, tx: FsTransaction, input: {
  ir: IrSession; sourceCreatedAt: string; cwd: string; now?: () => Date; uuid?: () => string;
}): Promise<{ threadId: string; rolloutPath: string }>
```
- 템플릿: `threads` 중 `source='vscode'` 이고 **cwd 가 같은 행**(정규화 비교) 우선, 없으면 가장 최근 `vscode` 행. 없으면 오류(Codex 에서 세션을 하나 만든 뒤 다시 시도). 템플릿 rollout 의 첫 `session_meta` payload 사용(읽기 실패 시 오류).
- threadId: UUID v7 형식(시간 기반) — `crypto.randomUUID()` 대신 현재 ms 를 앞 48비트로 넣은 v7 을 생성(Codex ID 와 정렬 일관성). 테스트에서 주입 가능.
- 파일: `~\.codex\sessions\YYYY\MM\DD\rollout-<YYYY-MM-DDTHH-mm-ss>-<threadId>.jsonl` — `tx.createFile`.
- `session_index.jsonl`: `tx.backupThenModify` 로 한 줄 추가.
- `state_5.sqlite`: 쓰기 모드로 열고 **트랜잭션 안에서** `PRAGMA table_info(threads)` 로 컬럼 확인 → 템플릿 행 컬럼 중 실제 컬럼만 INSERT. 프로젝트: `project_roots` 중 cwd 를 포함하는 가장 깊은 루트의 project_id. 실패 시 SQLite 트랜잭션 롤백 + 예외(호출자가 tx.rollback). 이 단계는 반드시 마지막.

- [ ] **Step 1: 테스트** (Plan 2 의 `codexStateDb` 픽스처를 컬럼을 늘려 사용: `sandbox_policy, approval_mode, history_mode, name, preview, first_user_message, created_at_ms, updated_at_ms, recency_at, recency_at_ms, tokens_used, project_id` 추가) — (a) `buildCodexRollout` 줄이 모두 JSON, 첫 줄 session_meta 에 템플릿의 `base_instructions` 유지·`context_window` 제거; (b) `buildThreadRow` 가 sandbox_policy 의 템플릿 경로를 새 cwd 로 바꾸고 템플릿 객체는 불변; (c) `writeCodexSession` 후 `listCodexSessions` 가 새 스레드를 보여주고 `readCodexSession` 이 안내+원문으로 읽음(왕복), `session_index.jsonl` 에 한 줄 추가; (d) 템플릿 행이 없으면 오류; (e) INSERT 실패(예: threads 에 NOT NULL 컬럼을 추가한 픽스처)면 rollout 파일 삭제·session_index 원복(tx.rollback 호출 시).
- [ ] **Step 2~4:** 구현, 통과
- [ ] **Step 5: Commit** — `feat(codex): write imported sessions into the Codex state`

---

### Task 6: `SwitchService.runWithAppStopped`

**Files:** Modify `src/main/services/switch-service.ts` · Test `test/unit/switch-service.test.ts`

- [ ] 공개 메서드 `runWithAppStopped<T>(tool, fn: (progress: (step: string) => void) => Promise<T>): Promise<{ status: 'done'; value: T; launchWarning?: string } | { status: 'aborted'; reason: string; launchWarning?: string }>` 추가: inFlight 가드, stray-CLI 확인, 앱 종료(autoKill 설정 존중), `fn` 실행, 앱이 실행 중이었으면 재실행+확인(`launchAndVerify`). `fn` 이 던지면 재실행 후 `aborted`(사유 = 오류 메시지). 기존 `switchTo/restoreBackup/prepareNewLogin` 동작은 바꾸지 않는다(내부 공통화는 선택).
- [ ] 테스트: 앱 실행 중 → 종료 → fn 호출 시점에 프로세스 없음 → 재실행 / fn 예외 → aborted + 재실행 / 동시 호출 → '다른 전환이 진행 중입니다'.
- [ ] Commit — `feat(services): add runWithAppStopped for migration writes`

---

### Task 7: `ImportService`

**Files:** Create `src/main/services/import-service.ts` · Test `test/unit/import-service.test.ts`

```ts
export type ImportTarget =
  | { tool: 'claude'; account: { accountId: string; orgId: string } }   // Codex→Claude, Claude→Claude(공유)
  | { tool: 'codex' };                                                  // Claude→Codex
export type DuplicatePolicy = 'skip' | 'copy';
export interface ImportItemResult { key: string; status: 'imported' | 'shared' | 'skipped' | 'failed'; reason?: string; dstSessionId?: string }

export class ImportService {
  constructor(d: { paths; db: AppDb; library: LibraryService; switcher: SwitchService; backupsDir: string; now?: () => Date });
  run(srcTool: ToolId, keys: string[], target: ImportTarget, policy: DuplicatePolicy, onProgress?: (step: string) => void):
    Promise<{ status: 'done'; results: ImportItemResult[]; launchWarning?: string } | { status: 'aborted'; reason: string }>;
}
```
- 대상 앱을 `switcher.runWithAppStopped(target.tool, …)` 안에서 처리(원본 앱은 종료하지 않음 — 읽기만 함).
- 세션마다 독립: `library.read(srcTool, key)` → (Claude→Claude 는 IR 변환 없이 `shareClaudeIndex`, 원본이 Code 인덱스가 아닌 CLI/Cowork 세션이면 `failed: 'Claude 계정 간 공유는 Code 세션만 가능합니다'`) → `prepareForImport` → writer → 성공 시 `tx.commit()` + `db.recordImport`, 실패 시 `tx.rollback()` + `failed`.
- 중복: `db.findImports(...)` 가 있으면 `policy==='skip'` → `skipped`, `'copy'` → 새로 생성.
- 원본 요약에서 `sourceCreatedAt = new Date(summary.createdAt).toISOString()`, cwd = 원본 cwd(없으면 `failed: '작업 폴더를 알 수 없습니다'`). `hasTranscript` 없는(file '') 세션은 `failed: '대화 기록이 없습니다'`. Cowork 세션(cwd `/sessions/…`)을 Codex 로 보낼 때는 인덱스의 `userSelectedFolders[0]` 이 있으면 그 폴더, 없으면 `failed`(→ LibraryService 가 SessionSummary 에 `hostFolder?` 를 채우도록 Claude reader 를 소폭 확장).
- 진행 단계: '세션 읽는 중 (i/n)', '변환', '대상 앱에 등록', '이력 기록'.
- 테스트(임시 폴더, FakeProcs, fake 인증): Codex→Claude 왕복, Claude→Codex 왕복, Claude A→B 공유, 중복 skip/copy, 한 세션 실패 시 다른 세션은 성공하고 실패 세션의 파일은 남지 않음, 대상 앱 종료/재실행.
- [ ] Commit — `feat(services): add ImportService for cross-tool and cross-account migration`

---

### Task 8: CLI · RPC · GUI

**Files:** Modify `src/cli/index.ts`, `src/rpc/handlers.ts`, `gui/index.html`, `gui/renderer.js`, `gui/style.css`

- CLI: `sessions <tool> [--all]` (키·제목 앞 40자·갱신일·hasTranscript 목록 — 검증용), `import <srcTool> <key...> --to <codex|claude> [--account <라벨>] [--copy]` (Claude 대상 계정: 라벨로 등록 계정 선택, 없으면 현재 로그인 계정). 결과를 세션별로 출력.
- RPC: `importSessions { srcTool, keys (1~200개), target: { tool, accountKey? }, policy }` — mutating 잠금 안에서, 진행 이벤트 전달. `accountKey` 는 `acct:<rowId>`(등록 Claude 계정) 또는 `current`(현재 Claude 로그인). `importHistory { srcTool, key }`(읽기 전용).
- GUI 라이브러리 탭: 대화 기록이 있는 세션 행에 체크박스, 프로젝트 제목 행에 "전체 선택" 체크박스, 툴바에 [가져오기… (N)] 버튼. 대화상자: 대상 도구(Codex 원본 → Claude 만 / Claude 원본 → Codex 또는 Claude(다른 계정 공유)), Claude 대상 계정 선택(등록 계정 + 현재 로그인), 중복 처리(건너뛰기/새 복사본), 안내("대상 앱이 종료되었다가 다시 실행됩니다. 원본은 바뀌지 않습니다."). 실행 중 진행 표시, 완료 후 세션별 결과(가져옴/공유/건너뜀/실패+사유)를 로그와 대화상자에 표시하고 목록 새로고침. 이미 이관한 세션은 행에 `이관됨` 배지(importHistory 또는 libraryList 응답에 `imported: string[]` 포함 — 구현자 선택, 문서화).
- 테스트: handlers 검증·잠금·진행 이벤트, CLI 는 `node --check`/타입체크.
- [ ] Commit — `feat: import sessions from CLI, RPC and the library tab`

---

### Task 9: 실제 앱 검증 (사용자와 함께) + 문서

- [ ] **V6 Codex → Claude:** Claude Desktop 은 이 세션이 도는 곳이므로 사용자가 별도 터미널/GUI 에서 실행. 작은 Codex 세션 1개를 선택 → 가져오기 → Claude Desktop 재실행 후 Code 탭 목록에 `[Codex] 제목` 표시, 열었을 때 이관 안내+대화 표시, **이어서 메시지 1회 전송 가능** 확인.
- [ ] **V7 Claude → Codex:** 작은 Claude Code 세션 1개 → 가져오기 → ChatGPT 앱 목록에 표시, 열기, 이어서 1회 전송. `thread_history_1.sqlite` 가 자동 재구성되는지(목록/본문 표시) 확인.
- [ ] **V5 Claude A → B 공유:** Claude 계정 2개 등록 후, A 의 Code 세션을 B 로 공유 → B 로 전환 → 목록에 표시·열기 확인.
- [ ] **V9:** Codex 세션을 다른 GPT 계정에서 이어쓰기 — 이관이 아닌 공유 폴더 이어쓰기이므로, GPT 계정 전환 후 기존 세션에서 메시지 1회 전송 시 오류 여부 기록.
- [ ] 결과를 `docs/verification/phase0-migration.md` 에 기록, 실패 항목은 원인·수정 계획 기록. 설계 §4.4/§5/§6, 아키텍처 §6, README 갱신.
- [ ] Commit — `docs: record migration verification and document import`

---

## 자체 점검
- 설계 §4.4 경로별 동작(Codex→Claude, Claude→Codex, Claude A→B, Codex A→B=불필요) → Task 4·5·7. 프로젝트 단위 = GUI 프로젝트 전체 선택(Task 8). 이력·중복(F6) → Task 2·7. `AGENTS.md ↔ CLAUDE.md` 복사 제안은 **이번 범위에서 제외**(후속) — 문서에 명시.
- 원본 불변: reader 만 사용. 대상 쓰기는 새 파일 생성 + `session_index.jsonl`(백업 후 추가) + `threads` INSERT(트랜잭션).
- 안전: 대상 앱 종료 상태(Task 6), 세션 단위 트랜잭션(Task 3·7), 템플릿 부재 시 명확한 오류.

---

## 구현 중 변경 사항 (2026-09-29)

계획 작성 시점의 스케치와 실제 구현(`a82f97d..HEAD`, Task 1~8 + V7 검증)이 갈라진 지점과, 실기기로 확인한 결과를 기록한다. 실기기 검증 기록: [docs/verification/phase0-migration.md](../../verification/phase0-migration.md).

**Claude 계정 A → B: 공유(인덱스 복사) 대신 포크로 변경** (`a747565`)
- 계획의 `shareClaudeIndex`(인덱스만 B 폴더로 복사, `cliSessionId` 유지 = 전사 파일 공유)를 `forkClaudeSession` 으로 바꿨다. 한 전사 파일을 두 계정이 함께 쓰면 두 계정의 대화가 한 파일에 섞여 이어지기 때문이다.
- 포크는 새 `cliSessionId` 를 발급해 원본 전사를 줄 단위로 복사하고(`sessionId` 필드만 교체, 원본 전사와 같은 프로젝트 폴더), 원본 인덱스를 템플릿 삼아 `buildClaudeIndex` 로 B 계정 폴더용 인덱스를 새로 만든다. `permissionMode` 는 `'default'` 로 되돌린다. 결과 상태는 `forked`, **Claude Code 세션만** 대상(Cowork/CLI 세션은 항목 실패, GUI 는 Claude 대상 라디오를 비활성화).
- 설계 D14 추가, V5 의 내용도 "인덱스 복사 → 포크"로 바꿨다(실기기 검증은 Claude 계정 2개가 필요해 대기).

**Claude 인덱스: 템플릿 고유 필드 제거** (`a747565`)
- 템플릿 인덱스를 그대로 복제하면 그 세션의 권한·연결·대화 상태가 새 세션에 딸려 온다. 그래서 `buildClaudeIndex` 는 교체 필드 외에 다음을 항상 지운다: 권한/승인(`sessionPermissionUpdates, alwaysAllowedReasons, bypassChosenInApp, chromePermissionMode, cuAllowedApps, cuGrantFlags, autoChosenInApp`), MCP(`enabledMcpTools, remoteMcpServersConfig`), 원격/SSH(`sshConfig, sshRemoteProcessId, sshRemoteTranscriptPath`), 오류·전사 상태(`error, errorAt, transcriptUnavailable`), 템플릿 대화 참조(`lastAssistantUuid, forkedFromSessionId, planPath, scratchPromptRecents, spawnSeed, promptAppendSnapshot, toolSurfaceSnapshot, titleTurn, writtenBranches, sourceBranch, publishedArtifacts, initialMessage, systemPrompt`). 이유는 설계 §5 "구현 기준" 참고.
- 인덱스 시각(`createdAt` 등)은 템플릿의 타입(숫자/문자열)을 유지하고, `model` 은 원본 모델로 바꾼다.

**Codex: legacy 대신 paginated 형식** (`a9c325c`, `cf834bd`, `2d27c2a`, `329ae9a`)
- 계획은 "과거 행 `legacy` 도 읽으니 `legacy` 로 쓴다"였으나, 실제 DB 의 모든 행이 `paginated`(123/123)라서 실제 앱과 같은 paginated 형식으로 쓴다: 봉투 `ordinal`(0부터 줄마다 +1), `session_meta` 에 `history_mode:'paginated'` + 새 `context_window.window_id`, 턴마다 `task_started` → 메시지 → `task_complete`.
- `turn_context` 는 템플릿의 것을 복제하되 템플릿 cwd(어디에 있든)·`turn_id`/`root_turn_id` 를 치환하고 `comp_hash` 를 지운다(템플릿 경로/ID 누출 방지). `sandbox_policy` 와 같은 치환기를 쓰며, 치환은 **대소문자 무시 + 경로 경계 인식**(`C:\work` 가 `C:\work-backup` 을 건드리지 않음)이다.
- **V7 로 확인한 요구사항**: (1) 앱의 대화 표시는 `response_item` 이 아니라 `event_msg/item_completed`(`UserMessage`/`AgentMessage`)에서 만들어진다 → 메시지마다 `item_completed` 를 쓴다(마지막 assistant 만 `phase:'final_answer'`). (2) `started_at`/`completed_at` 은 정수 epoch 초, `create_time` 은 초 단위 실수, `completed_at_ms`/`duration_ms` 는 밀리초 정수여야 한다 — 문자열이면 그 줄을 건너뛰어 `thread_turns` 가 0개가 된다.
- `threads` 행: `cwd` 는 `\?\` 접두어 포함(118/123), **`rollout_path` 는 접두어 없음**(계획의 `'\?\'+path` 를 뒤집음 — 실제 DB 는 23/123 만 접두어), `has_user_event=1`, `history_mode='paginated'`, `session_index.jsonl` 의 `updated_at` 은 ISO 문자열. 템플릿에 없는 컬럼은 추가하지 않고 테이블에 없는 컬럼은 INSERT 에서 뺀다.
- `threads` INSERT 는 SQLite 에 이미 커밋되므로 파일 되돌리기로 취소되지 않는다 → `tx.onRollback` 에 보정 `DELETE FROM threads WHERE id = ?` 를 등록해, 이후 단계(`imports` 기록 등)가 실패해도 되돌린다.
- `thread_history_1.sqlite` 는 계획대로 건드리지 않는다(앱이 rollout 의 `item_completed` 로 투영을 만든다).

**FsTransaction** (`7da71d9`, `635fda7`, `cf834bd`)
- API 가 계획의 `trackCreated`/`backupBeforeModify` 가 아니라 `createFile`(이미 있으면 오류, 임시 파일에 쓴 뒤 rename 해 원자적), `backupThenModify`, `onRollback`, `rollback`, `commit` 이다.
- 되돌리기가 일부 실패하면 실패한 항목을 목록에 남겨 다음 `rollback()` 에서 재시도할 수 있게 하고, 하나라도 실패하면 오류를 던진다.
- `prepareForImport` 는 같은 역할 메시지를 병합할 때 더 이른 타임스탬프를 유지하고, 이관 안내 메시지에는 첫 실제 메시지의 타임스탬프를 물려준다.

**ImportService** (`aa73ffc`, `c49d471`, `53b386a`)
- 대상 앱을 종료하기 **전에** 요청 키가 하나라도 실제 세션으로 풀리는지 확인한다 — 전부 알 수 없으면(낡은 목록 등) 앱을 종료/재실행하지 않고 `aborted`("가져올 수 있는 세션이 없습니다"). 일부만 알 수 없으면 그 항목만 실패.
- 세션마다 `FsTransaction` 하나. 실패하면 롤백하고, **롤백 자체가 실패하면** 그 항목의 사유에 "되돌리기 실패: 수동 확인이 필요합니다 (대상 도구, 새 세션 ID)" 와 원인을 붙여 항목별로 보고한다.
- 중복 정책 `skip`/`copy`: `imports` 에서 (원본, 대상 도구, 대상 계정 키) 로 조회. 상태는 `imported`/`forked`/`skipped`/`failed`.
- Cowork → Codex 는 세션 `cwd`(`/sessions/…`) 대신 인덱스의 `userSelectedFolders[0]`(`hostFolder`) 을 작업 폴더로 쓴다. 작업 폴더를 알 수 없으면 항목 실패.
- `SwitchService.runWithAppStopped(tool, fn)` 은 계획의 `(tool, label, fn)` 이 아니라 `label` 없이 `(tool, fn(progress))` 이며, 전환과 같은 동시 실행 방지·종료/재실행·진행 이벤트를 쓴다. `fn` 예외는 `aborted` 로 바꾸되 앱은 재실행한다.

**RPC · CLI · GUI** (`69df4f9`, `53b386a`)
- RPC: `importSessions`(잠금 아래 실행, 진행 이벤트 전달), `importHistory`, `libraryList` 응답에 `imported`(한 번이라도 이관된 원본 키 목록 — 목록의 `이관됨` 배지용, `AppDb.listImportedSrcKeys`) 추가. 대상 계정은 `acct:<id>`(등록 계정) 또는 `current`(현재 로그인), 입력은 키 1~200개·정책 `skip|copy` 로 검증.
- CLI: `sessions <codex|claude> [--all]`(키·제목 40자·갱신일·대화 기록 유무), `import <src> <키...> --to <codex|claude> [--account <라벨>] [--copy]`. `--to`/`--account` 뒤에 값이 없거나 다음 `--옵션` 이 바로 오면 명확한 오류로 거부한다.
- GUI: 세션·프로젝트 체크박스와 `가져오기… (N)` 버튼, 대화상자(대상 도구, Claude 대상 계정, 중복 정책, 진행 표시, 결과 목록). Cowork/CLI 세션이 섞이면 Claude 대상 라디오를 비활성화하고 이유를 보여주며, 로그인도 등록도 없는 Claude 대상은 실행을 막는다.

**V7 실기기 검증 결과 (2026-09-29): 통과** — 목록·프로젝트 분류·대화 표시·이어서 메시지 전송 정상. 시도 1(대화 비어 있음 → `item_completed` 추가), 시도 2(빈 화면 → 숫자 시각), 시도 3 정상. 프로젝트 분류는 `cwd` 가 프로젝트 루트와 같으면 되고 `thread-project-assignments` 는 고칠 필요가 없다. **캐시 주의:** 앱은 한 번 읽은 세션의 읽은 위치(`thread_history_projection_state`)를 기록해 다시 읽지 않으므로, 형식이 잘못된 이관 세션은 앱에서 보관/삭제한 뒤 `--copy` 로 새로 이관해야 한다.

**남은 항목 / 범위 밖**
- V6(Codex → Claude), V5(Claude 계정 A → B 포크), V9 는 실기기 검증 대기 — V6 수행 방법은 검증 기록 참고.
- 프로젝트 지침 파일 `AGENTS.md` ↔ `CLAUDE.md` 복사 제안은 이번 범위에서 제외(후속).
- 설계 §7 의 "SQLite 스키마 불일치 시 쓰기 비활성화" 는 구현하지 않았다 — Codex writer 는 `PRAGMA table_info(threads)` 로 존재하는 컬럼만 INSERT 하고(템플릿 행에 없는 컬럼은 추가하지 않음), 필수 컬럼 검증·경고는 후속.
