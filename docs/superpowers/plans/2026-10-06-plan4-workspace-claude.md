# Plan 4 — 작업공간 기반 + Claude 연동 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 이 앱에 작업 폴더를 등록하고, 그 폴더에서 Claude Code CLI 와 대화(실시간 출력·멈추기·권한 모드·사용량 표시)하는 작업공간 화면을 만든다. 데이터 구조와 프로토콜은 처음부터 여러 도구(Plan 5 GPT, Plan 6 Gemini)를 받을 수 있게 한다.

**Architecture:** 화면(`gui/workspace.js`) ⇄ stdio JSON(기존 request/response 에 `event`·`cancel` 추가) ⇄ RPC 핸들러 → `WorkspaceService` → `AgentRunner`(자식 프로세스, stdout 줄 단위 JSON, stdin 프롬프트, 트리 종료) + Claude 전용 순수 모듈(인자 만들기·출력 파서) → 공통 이벤트 `AgentEvent` → `TurnBuilder` 가 IR 블록으로 모아 `app.db` 에 저장. 각 도구 세션의 첫 턴에는 작업 폴더를 훑어 만든 `[작업공간 안내]` 를 붙인다.

**Tech Stack:** 기존과 동일(Node 22, TypeScript NodeNext ESM, better-sqlite3, Vitest, Tauri + vanilla JS `gui/`). 새 의존성 없음.

**관련 문서:** [작업공간 설계](../specs/2026-10-06-workspace-design.md) · [전체 설계](../specs/2026-09-23-ai-account-bridge-design.md) · [아키텍처](../../architecture.md) · [Plan 3](2026-09-29-plan3-migration.md)

**범위 밖(다음 Plan):** GPT·Gemini 연동, 도구 바꿔 이어 가기(핸드오프 요약·변경 목록), 기존 대화 가져오기, 승인 팝업.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `src/main/core/agent-events.ts` | `AgentId`, `AgentEvent`, `TurnUsage` — 도구와 무관한 공통 형식 |
| `src/main/core/turn.ts` | `TurnBuilder` — 한 턴의 이벤트 → IR 블록·세션 ID·결과 |
| `src/main/core/preamble.ts` | 순수: `workspacePreamble`, `unreadInstructionFiles`, `withPreamble`, `WorkspaceScan` 형식 |
| `src/main/providers/claude/agent.ts` | 순수: `claudeArgs`, `parseClaudeEvent`, 권한 모드 |
| `src/main/infra/exe-locator.ts` | `findOnPath` — PATH 에서 `.exe`/`.cmd` 찾기 |
| `src/main/infra/agent-runner.ts` | `AgentRunner` — 실행, 줄 단위 JSON, stdin, 멈추기(트리 종료), `childEnv`, `commandFor` |
| `src/main/infra/workspace-scan.ts` | `scanWorkspace`, `readBranch` — 저장소·브랜치·지침 파일 |
| `src/main/infra/app-db.ts` (수정) | 마이그레이션 4 + 작업공간 메서드 |
| `src/main/services/workspace-service.ts` | 작업공간·대화 관리, 한 턴 실행 |
| `src/rpc/server.ts` (수정) | `event` 보내기, `cancel` 받기, 종료 시 취소 |
| `src/rpc/handlers.ts` (수정) | `ws*` 메서드, 턴 실행 중 계정 작업 거절 |
| `gui/bridge.js`, `gui/index.html`, `gui/renderer.js`, `gui/style.css`, `scripts/build-icons.mjs` (수정) · `gui/workspace.js` (새) | 화면 |
| `docs/verification/phase0-workspace.md` (새) | Phase 0 결과 |

---

### Task 1: Phase 0 — Claude CLI 헤드리스 동작 확인 (사용자와 함께)

설계 §10 의 W-V1~W-V5. **실제 claude 를 실행해 사용 한도를 조금 쓰고, 임시 폴더용 세션이 Claude 목록에 남는다 — 시작 전에 사용자에게 알리고 동의를 받는다.**

**Files:** Create `docs/verification/phase0-workspace.md`

- [ ] **Step 1: 확인용 스크립트 만들기** — 앱과 같은 방식(stdin UTF-8, stream-json)으로 한 턴을 돌린다. PowerShell 파이프는 한글을 깨뜨리므로(`$OutputEncoding`) 프롬프트는 인자로 받아 Node 가 stdin 에 쓴다. 저장소 밖 `%TEMP%\aab-ws-v\phase0-claude.mjs`:

```js
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

// 사용: node phase0-claude.mjs <작업 폴더> <permission-mode> <프롬프트> [이어 할 세션 ID 또는 -] [--nested]
const [cwd, mode, prompt, resume, flag] = process.argv.slice(2);
const resuming = Boolean(resume && resume !== '-');
const id = resuming ? resume : randomUUID();
const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode, resuming ? '--resume' : '--session-id', id];
const env = { ...process.env };
if (flag === '--nested') env.CLAUDECODE = '1';
else delete env.CLAUDECODE;
const out = fs.createWriteStream(`turn-${mode}-${Date.now()}.jsonl`);
const kinds = {};
let buf = '';
const child = spawn('claude', args, { cwd, env, windowsHide: true });
child.stdout.setEncoding('utf8').on('data', (d) => {
  out.write(d);
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      const k = `${o.type}${o.subtype ? `/${o.subtype}` : ''}${o.event?.type ? `:${o.event.type}` : ''}`;
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (o.type === 'system' && o.subtype === 'init') console.log('init', JSON.stringify({ session_id: o.session_id, model: o.model, permissionMode: o.permissionMode, cwd: o.cwd }));
      if (o.type === 'user') console.log('tool_result', JSON.stringify(o.message?.content).slice(0, 400));
      if (o.type === 'result') console.log('result', JSON.stringify({ subtype: o.subtype, is_error: o.is_error, result: o.result, session_id: o.session_id, usage: o.usage, total_cost_usd: o.total_cost_usd }));
    } catch {
      console.log('JSON 아닌 줄', line.slice(0, 200));
    }
  }
});
child.stderr.setEncoding('utf8').on('data', (d) => process.stderr.write(d));
child.stdin.end(prompt, 'utf8');
child.on('close', (code) => {
  console.log('session', id, 'exit', code);
  console.log('줄 종류', kinds);
  out.end();
});
```

- [ ] **Step 2: W-V1·W-V2 — 이벤트 모양과 한글** (PowerShell, 작업 폴더 = `%TEMP%\aab-ws-v\w`)

```powershell
$v = Join-Path $env:TEMP 'aab-ws-v'; New-Item -ItemType Directory -Force (Join-Path $v 'w') | Out-Null; Set-Location $v
node phase0-claude.mjs "$v\w" default '"사과" 라는 낱말 하나만 답하세요.'
```

기록: 줄 종류 목록(`system/init`, `stream_event:content_block_delta`, `assistant`, `result/success` …), `init` 의 `session_id`, `result.result` 에 `사과` 가 그대로 있는지, `usage` 키 이름. 저장된 `turn-*.jsonl` 에서 `assistant` 줄의 `message.content` 블록 모양(`text`, `tool_use{id,name,input}`)과 `stream_event` 의 `delta.type`(`text_delta`)을 확인한다.

- [ ] **Step 3: W-V3 — 이어 하기**

```powershell
node phase0-claude.mjs "$v\w" default '방금 답한 낱말을 한 번 더 답하세요.' <Step 2 의 session ID>
```

기록: `init.session_id` 가 같은지, 답에 `사과` 가 있는지, `~\.claude\projects\<인코딩된 폴더>\` 에 `.jsonl` 이 하나만 있는지.

- [ ] **Step 4: W-V4 — 권한 모드** — 모드마다 새 폴더에서:

```powershell
foreach ($m in 'plan','default','acceptEdits','auto','dontAsk','bypassPermissions') {
  $d = Join-Path $v "m-$m"; New-Item -ItemType Directory -Force $d | Out-Null
  node phase0-claude.mjs $d $m '이 폴더에 probe.txt 를 만들어 ok 라고 쓰고, 셸에서 echo shell-ok 를 실행한 뒤, 두 작업이 각각 됐는지 답하세요.'
  Test-Path (Join-Path $d 'probe.txt')
}
```

기록(모드별): 파일이 생겼는지, 셸 명령이 돌았는지, 거부됐다면 `tool_result` 의 `is_error`·문구, 끝까지 멈추지 않고 `result` 가 나왔는지(묻느라 멈추는 모드가 있으면 화면에서 뺀다).

- [ ] **Step 5: W-V5 — 중첩 실행 표시**

```powershell
node phase0-claude.mjs "$v\w" default '"네" 라고만 답하세요.' - --nested
```

기록: 거부되는지와 그 문구. (거부되지 않아도 실행기는 `CLAUDECODE` 를 지운다 — 개발 중 Claude Code 터미널에서 앱을 띄울 때를 대비.)

- [ ] **Step 6: 결과 문서** — `docs/verification/phase0-workspace.md`:

```markdown
# Phase 0 — 작업공간 CLI 검증

## W-V1~W-V5: Claude Code (claude <버전>, <날짜>)

| # | 확인 | 결과 |
|---|---|---|
| W-V1 | stream-json 줄 종류 / --verbose 필요 여부 | |
| W-V2 | stdin 한글 | |
| W-V3 | --session-id → --resume | |
| W-V4 | 권한 모드별 동작 (plan / default / acceptEdits / auto / dontAsk / bypassPermissions) | |
| W-V5 | CLAUDECODE 중첩 실행 | |

### 결정
- 화면에 보일 모드: …
- 기본 모드: …
- 파서가 다루는 줄: …
```

- [ ] **Step 7: 결정 반영** — 이 Plan 의 가정과 다르면 먼저 고치고 시작한다:
  - 줄 모양이 다르면 Task 2 의 `parseClaudeEvent` 와 테스트를 관찰대로 바꾼다.
  - 모드: Task 2 의 `CLAUDE_MODES`(보일 모드)와 `CLAUDE_DEFAULT_MODE`(기본값, 가정은 `acceptEdits`)를 W-V4 결과로 정한다. 바꾸면 Task 11 의 `wsAgents` 테스트 기대값(`modes`, `defaultMode`)도 같이 바꾼다.
  - 다른 점은 이 문서 끝 "구현 중 변경 사항" 에 적는다.

- [ ] **Step 8: Commit**

```bash
git add docs/verification/phase0-workspace.md
git commit -m "docs: phase 0 findings for running Claude Code headless"
```

---

### Task 2: 공통 이벤트 형식 + Claude 인자·출력 파서

**Files:** Create `src/main/core/agent-events.ts`, `src/main/providers/claude/agent.ts` · Test `test/unit/claude-agent.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/claude-agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseAgentId } from '../../src/main/core/agent-events.js';
import { claudeArgs, parseClaudeEvent, parseClaudeMode } from '../../src/main/providers/claude/agent.js';

describe('claudeArgs', () => {
  it('creates a session with the given id on the first turn', () => {
    expect(claudeArgs({ mode: 'acceptEdits', session: { create: 'u-1' } })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits', '--session-id', 'u-1',
    ]);
  });

  it('resumes a session and passes the model', () => {
    expect(claudeArgs({ mode: 'plan', model: 'opus', session: { resume: 's-9' } })).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'plan', '--model', 'opus', '--resume', 's-9',
    ]);
  });
});

describe('parseClaudeMode / parseAgentId', () => {
  it('accepts known values and rejects others', () => {
    expect(parseClaudeMode('bypassPermissions')).toBe('bypassPermissions');
    expect(() => parseClaudeMode('yolo')).toThrow('mode');
    expect(parseAgentId('claude')).toBe('claude');
    expect(() => parseAgentId('gpt')).toThrow('agent');
  });
});

describe('parseClaudeEvent', () => {
  it('reads the session id and model from the init line', () => {
    expect(parseClaudeEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', cwd: 'C:\\w', tools: [] }))
      .toEqual([{ type: 'session', sessionId: 's1', model: 'claude-opus-5-5' }]);
  });

  it('turns partial text deltas into textDelta events and ignores other stream events', () => {
    expect(parseClaudeEvent({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안' } } }))
      .toEqual([{ type: 'textDelta', text: '안' }]);
    expect(parseClaudeEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } })).toEqual([]);
    expect(parseClaudeEvent({ type: 'stream_event', event: { type: 'message_start' } })).toEqual([]);
  });

  it('splits a completed assistant message into text and tool calls, dropping thinking', () => {
    const line = {
      type: 'assistant',
      session_id: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '...' },
          { type: 'text', text: '파일을 볼게요' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'dir' } },
        ],
      },
    };
    expect(parseClaudeEvent(line)).toEqual([
      { type: 'text', text: '파일을 볼게요' },
      { type: 'toolStart', id: 'toolu_1', name: 'Bash', input: '{"command":"dir"}' },
    ]);
  });

  it('turns tool results into toolEnd events, joining text parts', () => {
    const line = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'line1' }, { type: 'image', source: {} }], is_error: true },
        ],
      },
    };
    expect(parseClaudeEvent(line)).toEqual([
      { type: 'toolEnd', id: 'toolu_1', output: 'a.txt', isError: false },
      { type: 'toolEnd', id: 'toolu_2', output: 'line1\n[이미지]', isError: true },
    ]);
  });

  it('reports success with usage from the result line', () => {
    const line = {
      type: 'result', subtype: 'success', is_error: false, result: '끝', session_id: 's1', total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    };
    expect(parseClaudeEvent(line)).toEqual([
      { type: 'done', ok: true, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.01 } },
    ]);
  });

  it('reports failures with the result text, falling back to the subtype', () => {
    expect(parseClaudeEvent({ type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached' }))
      .toEqual([{ type: 'done', ok: false, error: 'Usage limit reached' }]);
    expect(parseClaudeEvent({ type: 'result', subtype: 'error_during_execution', is_error: true }))
      .toEqual([{ type: 'done', ok: false, error: 'error_during_execution' }]);
  });

  it('ignores unknown or malformed lines', () => {
    expect(parseClaudeEvent({ type: 'system', subtype: 'hook_started' })).toEqual([]);
    expect(parseClaudeEvent({ type: 'assistant', message: { content: 'x' } })).toEqual([]);
    expect(parseClaudeEvent('text')).toEqual([]);
    expect(parseClaudeEvent(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/claude-agent.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 공통 형식** — `src/main/core/agent-events.ts`:

```ts
// 작업공간에서 고를 수 있는 도구. 계정 전환 대상(ToolId)과 따로 둔다(작업공간 설계 W14) — Plan 5·6 에서 'codex'·'gemini' 를 더한다.
export type AgentId = 'claude';
export const AGENT_IDS: readonly AgentId[] = ['claude'];
export const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude' };

export function parseAgentId(v: unknown): AgentId {
  if (typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v)) return v as AgentId;
  throw new Error(`agent 는 ${AGENT_IDS.join(' 또는 ')} 이어야 합니다`);
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number; // CLI 가 알려 줄 때만(구독 요금제에서는 참고용 환산값)
}

// CLI 출력 한 줄에서 뽑은 공통 이벤트. 화면과 저장은 이것만 안다 — 도구별 형식은 providers/<도구>/agent.ts 가 바꾼다.
export type AgentEvent =
  | { type: 'session'; sessionId: string; model?: string }
  | { type: 'textDelta'; text: string } // 글 조각(화면용)
  | { type: 'text'; text: string } // 완성된 글 블록
  | { type: 'toolStart'; id: string; name: string; input: string }
  | { type: 'toolEnd'; id: string; output: string; isError: boolean }
  | { type: 'done'; ok: boolean; error?: string; usage?: TurnUsage };
```

- [ ] **Step 4: Claude 모듈** — `src/main/providers/claude/agent.ts`:

```ts
import type { AgentEvent, TurnUsage } from '../../core/agent-events.js';

// claude -p 의 --permission-mode 값(2.1.159 도움말, Phase 0 W-V4 로 확정). 화면 이름·설명은 GUI 가 갖는다.
export const CLAUDE_MODES = ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type ClaudeMode = (typeof CLAUDE_MODES)[number];
export const CLAUDE_DEFAULT_MODE: ClaudeMode = 'acceptEdits';

export function parseClaudeMode(v: unknown): ClaudeMode {
  if (typeof v === 'string' && (CLAUDE_MODES as readonly string[]).includes(v)) return v as ClaudeMode;
  throw new Error(`mode 는 ${CLAUDE_MODES.join(', ')} 중 하나여야 합니다`);
}

export type ClaudeSession = { create: string } | { resume: string };

// 한 턴의 인자. 프롬프트는 stdin 으로 넘긴다(작업공간 설계 W12). 첫 턴은 우리가 정한 UUID 로 세션을 만들고 다음 턴은 이어 간다.
export function claudeArgs(o: { mode: ClaudeMode; model?: string; session: ClaudeSession }): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', o.mode];
  if (o.model) args.push('--model', o.model);
  if ('resume' in o.session) args.push('--resume', o.session.resume);
  else args.push('--session-id', o.session.create);
  return args;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const b = rec(c);
      if (b?.type === 'text') return str(b.text) ?? '';
      if (b?.type === 'image') return '[이미지]';
      return '';
    })
    .filter((t) => t !== '')
    .join('\n');
}

function usageOf(o: Record<string, unknown>): TurnUsage | undefined {
  const u = rec(o.usage);
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    ...(typeof o.total_cost_usd === 'number' ? { costUsd: o.total_cost_usd } : {}),
  };
}

// stream-json 한 줄(JSON.parse 결과) → 공통 이벤트. 모르는 줄은 버린다 — CLI 가 줄 종류를 늘려도 멈추지 않게.
// 추론(thinking)은 옮기지 않는다(전체 설계 D5 와 같은 규칙).
export function parseClaudeEvent(line: unknown): AgentEvent[] {
  const o = rec(line);
  if (!o) return [];
  switch (o.type) {
    case 'system': {
      const sessionId = str(o.session_id);
      if (o.subtype !== 'init' || !sessionId) return [];
      const model = str(o.model);
      return [{ type: 'session', sessionId, ...(model ? { model } : {}) }];
    }
    case 'stream_event': {
      const ev = rec(o.event);
      const delta = rec(ev?.delta);
      const text = str(delta?.text);
      return ev?.type === 'content_block_delta' && delta?.type === 'text_delta' && text ? [{ type: 'textDelta', text }] : [];
    }
    case 'assistant': {
      const content = rec(o.message)?.content;
      if (!Array.isArray(content)) return [];
      const out: AgentEvent[] = [];
      for (const c of content) {
        const b = rec(c);
        const text = str(b?.text);
        const id = str(b?.id);
        const name = str(b?.name);
        if (b?.type === 'text' && text) out.push({ type: 'text', text });
        else if (b?.type === 'tool_use' && id && name) out.push({ type: 'toolStart', id, name, input: JSON.stringify(b.input ?? {}) });
      }
      return out;
    }
    case 'user': {
      const content = rec(o.message)?.content;
      if (!Array.isArray(content)) return [];
      const out: AgentEvent[] = [];
      for (const c of content) {
        const b = rec(c);
        const id = str(b?.tool_use_id);
        if (b?.type === 'tool_result' && id) out.push({ type: 'toolEnd', id, output: toolResultText(b.content), isError: b.is_error === true });
      }
      return out;
    }
    case 'result': {
      const ok = o.is_error !== true && o.subtype === 'success';
      const usage = usageOf(o);
      const done: AgentEvent = {
        type: 'done',
        ok,
        ...(ok ? {} : { error: str(o.result) || str(o.subtype) || '알 수 없는 오류' }),
        ...(usage ? { usage } : {}),
      };
      return [done];
    }
    default:
      return [];
  }
}
```

- [ ] **Step 5: 통과 확인** — Run: `npx vitest run test/unit/claude-agent.test.ts && npm run typecheck` — Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/core/agent-events.ts src/main/providers/claude/agent.ts test/unit/claude-agent.test.ts
git commit -m "feat(workspace): common agent events and Claude stream-json parser"
```

---

### Task 3: `TurnBuilder` — 한 턴을 IR 블록으로

**Files:** Create `src/main/core/turn.ts` · Test `test/unit/turn.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/turn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/main/core/agent-events.js';
import { truncate, type IrToolBlock } from '../../src/main/core/ir.js';
import { TurnBuilder } from '../../src/main/core/turn.js';

describe('TurnBuilder', () => {
  it('collects text and tool blocks in order, pairing tool results by id', () => {
    const t = new TurnBuilder();
    const events: AgentEvent[] = [
      { type: 'session', sessionId: 's1', model: 'm' },
      { type: 'textDelta', text: '파' },
      { type: 'text', text: '파일을 볼게요' },
      { type: 'toolStart', id: 'a', name: 'Bash', input: '{"command":"dir"}' },
      { type: 'toolEnd', id: 'a', output: 'x.txt', isError: false },
      { type: 'toolStart', id: 'b', name: 'Read', input: '{}' },
      { type: 'toolEnd', id: 'b', output: 'nope', isError: true },
      { type: 'text', text: '끝' },
      { type: 'done', ok: true, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    ];
    for (const e of events) t.add(e);
    expect(t.sessionId).toBe('s1');
    expect(t.model).toBe('m');
    expect(t.blocks).toEqual([
      { kind: 'text', text: '파일을 볼게요' },
      { kind: 'tool', name: 'Bash', input: '{"command":"dir"}', output: 'x.txt' },
      { kind: 'tool', name: 'Read', input: '{}', output: 'nope', isError: true },
      { kind: 'text', text: '끝' },
    ]);
    expect(t.finished).toEqual({ ok: true, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } });
  });

  it('clips long tool input and output like the IR does', () => {
    const t = new TurnBuilder();
    t.add({ type: 'toolStart', id: 'a', name: 'Bash', input: 'x'.repeat(3000) });
    t.add({ type: 'toolEnd', id: 'a', output: 'y'.repeat(3000), isError: false });
    const b = t.blocks[0] as IrToolBlock;
    expect(b.input).toBe(truncate('x'.repeat(3000)));
    expect(b.output).toBe(truncate('y'.repeat(3000)));
  });

  it('ignores results for unknown tool ids and keeps unfinished tools', () => {
    const t = new TurnBuilder();
    t.add({ type: 'toolStart', id: 'a', name: 'Bash', input: '{}' });
    t.add({ type: 'toolEnd', id: 'zzz', output: 'x', isError: false });
    t.add({ type: 'done', ok: false, error: 'boom' });
    expect(t.blocks).toEqual([{ kind: 'tool', name: 'Bash', input: '{}' }]);
    expect(t.finished).toEqual({ ok: false, error: 'boom' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/turn.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/main/core/turn.ts`:

```ts
import type { AgentEvent, TurnUsage } from './agent-events.js';
import { truncate, type IrBlock, type IrToolBlock } from './ir.js';

// 한 턴의 이벤트를 저장할 IR 블록으로 모은다. 글 조각(textDelta)은 화면용이라 버리고 완성된 글(text)만 남긴다.
// 도구 입력·출력은 IR 규칙대로 잘라 둔다(core/ir.ts 의 truncate).
export class TurnBuilder {
  readonly blocks: IrBlock[] = [];
  sessionId?: string;
  model?: string;
  finished?: { ok: boolean; error?: string; usage?: TurnUsage };
  private readonly tools = new Map<string, IrToolBlock>();

  add(e: AgentEvent): void {
    switch (e.type) {
      case 'session':
        this.sessionId = e.sessionId;
        if (e.model) this.model = e.model;
        break;
      case 'text':
        this.blocks.push({ kind: 'text', text: e.text });
        break;
      case 'toolStart': {
        const b: IrToolBlock = { kind: 'tool', name: e.name, input: truncate(e.input) };
        this.tools.set(e.id, b);
        this.blocks.push(b);
        break;
      }
      case 'toolEnd': {
        const b = this.tools.get(e.id);
        if (!b) break;
        b.output = truncate(e.output);
        if (e.isError) b.isError = true;
        break;
      }
      case 'done':
        this.finished = { ok: e.ok, ...(e.error !== undefined ? { error: e.error } : {}), ...(e.usage ? { usage: e.usage } : {}) };
        break;
      case 'textDelta':
        break;
    }
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/turn.test.ts` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/core/turn.ts test/unit/turn.test.ts
git commit -m "feat(workspace): collect a turn's events into IR blocks"
```

---

### Task 4: 작업공간 안내 글

**Files:** Create `src/main/core/preamble.ts` · Test `test/unit/preamble.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/preamble.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { unreadInstructionFiles, withPreamble, workspacePreamble, type WorkspaceScan } from '../../src/main/core/preamble.js';

describe('unreadInstructionFiles', () => {
  it('lists instruction files the agent does not read by itself', () => {
    const files = ['AGENTS.md', 'CLAUDE.md', 'a/AGENTS.md', 'b/GEMINI.md', 'b/claude.md'];
    // 루트와 b 에는 Claude 가 스스로 읽는 CLAUDE.md 가 있으므로 a/AGENTS.md 만 남는다(대소문자 무시)
    expect(unreadInstructionFiles(files, 'claude')).toEqual(['a/AGENTS.md']);
  });
});

describe('workspacePreamble', () => {
  it('describes a multi-repo folder like multi-repo', () => {
    const scan: WorkspaceScan = {
      repos: [{ rel: 'app-agent', branch: 'master' }, { rel: 'app-backend', branch: 'feat/new-api' }],
      instructionFiles: ['app-agent/AGENTS.md'],
    };
    expect(workspacePreamble('C:\\w\\multi-repo', scan, 'claude')).toBe(
      [
        '[작업공간 안내]',
        '작업 폴더: C:\\w\\multi-repo — 다른 AI 도구와 같이 쓰는 폴더입니다. 파일은 디스크의 현재 상태가 최신입니다.',
        'git 저장소: app-agent (master), app-backend (feat/new-api)',
        '지침 파일: app-agent/AGENTS.md — 해당 폴더에서 작업하기 전에 읽고 따르세요.',
        '만드는 파일·산출물은 작업 폴더 안에 두세요.',
      ].join('\n'),
    );
  });

  it('marks the folder itself as "." and leaves out empty sections', () => {
    expect(workspacePreamble('C:\\w', { repos: [{ rel: '' }], instructionFiles: ['CLAUDE.md'] }, 'claude')).toBe(
      [
        '[작업공간 안내]',
        '작업 폴더: C:\\w — 다른 AI 도구와 같이 쓰는 폴더입니다. 파일은 디스크의 현재 상태가 최신입니다.',
        'git 저장소: .',
        '만드는 파일·산출물은 작업 폴더 안에 두세요.',
      ].join('\n'),
    );
  });
});

describe('withPreamble', () => {
  it('puts the preamble before the request with a divider', () => {
    expect(withPreamble('[안내]', '고쳐줘')).toBe('[안내]\n\n---\n\n고쳐줘');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/preamble.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/main/core/preamble.ts`:

```ts
import type { AgentId } from './agent-events.js';

export interface RepoInfo { rel: string; branch?: string } // rel: 작업 폴더 기준 '/' 경로, 작업 폴더 자신은 ''
export interface WorkspaceScan { repos: RepoInfo[]; instructionFiles: string[] } // instructionFiles: 작업 폴더 기준 '/' 경로

// 도구가 스스로 읽는 지침 파일 이름(소문자, 작업공간 설계 §5).
const OWN_INSTRUCTIONS: Record<AgentId, string> = { claude: 'claude.md' };

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const dirName = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

// 그 도구가 스스로 읽지 않는 지침 파일 — 같은 폴더에 그 도구의 파일이 있으면 그쪽을 읽으므로 뺀다.
export function unreadInstructionFiles(files: string[], agent: AgentId): string[] {
  const own = OWN_INSTRUCTIONS[agent];
  const covered = new Set(files.filter((f) => baseName(f).toLowerCase() === own).map(dirName));
  return files.filter((f) => baseName(f).toLowerCase() !== own && !covered.has(dirName(f)));
}

// 도구 세션의 첫 메시지 앞에 붙이는 안내(작업공간 설계 W7). 지침 파일을 새로 만들지 않고 읽을 곳을 알려 준다.
export function workspacePreamble(folder: string, scan: WorkspaceScan, agent: AgentId): string {
  const lines = ['[작업공간 안내]', `작업 폴더: ${folder} — 다른 AI 도구와 같이 쓰는 폴더입니다. 파일은 디스크의 현재 상태가 최신입니다.`];
  if (scan.repos.length > 0) {
    lines.push(`git 저장소: ${scan.repos.map((r) => `${r.rel === '' ? '.' : r.rel}${r.branch ? ` (${r.branch})` : ''}`).join(', ')}`);
  }
  const unread = unreadInstructionFiles(scan.instructionFiles, agent);
  if (unread.length > 0) lines.push(`지침 파일: ${unread.join(', ')} — 해당 폴더에서 작업하기 전에 읽고 따르세요.`);
  lines.push('만드는 파일·산출물은 작업 폴더 안에 두세요.');
  return lines.join('\n');
}

export function withPreamble(preamble: string, text: string): string {
  return `${preamble}\n\n---\n\n${text}`;
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/preamble.test.ts` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/core/preamble.ts test/unit/preamble.test.ts
git commit -m "feat(workspace): workspace preamble listing repos and unread instruction files"
```

---

### Task 5: 작업 폴더 훑기 (저장소·브랜치·지침 파일)

> **완료(2026-10-06)** — 세션 가져오기 보강 때 먼저 구현했다(끝의 "구현 중 변경 사항"). 아래 단계는 기록으로 남긴다.

**Files:** Create `src/main/infra/workspace-scan.ts` · Test `test/unit/workspace-scan.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/workspace-scan.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBranch, scanWorkspace } from '../../src/main/infra/workspace-scan.js';
import { pendingTmpRoots, writeFile } from '../helpers/tmp-paths.js';

async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-ws-'));
  pendingTmpRoots.push(d);
  return d;
}

describe('scanWorkspace', () => {
  it('finds nested repos with branches and instruction files (multi-repo layout)', async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, 'app-agent', '.git', 'HEAD'), 'ref: refs/heads/master\n');
    await writeFile(path.join(root, 'app-agent', 'AGENTS.md'), '# rules');
    await writeFile(path.join(root, 'app-backend', '.git', 'HEAD'), 'ref: refs/heads/feat/new-api\n');
    await writeFile(path.join(root, 'design.md'), 'x');
    expect(await scanWorkspace(root)).toEqual({
      repos: [{ rel: 'app-agent', branch: 'master' }, { rel: 'app-backend', branch: 'feat/new-api' }],
      instructionFiles: ['app-agent/AGENTS.md'],
    });
  });

  it('counts the folder itself and skips hidden, dependency and too-deep folders', async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(root, 'CLAUDE.md'), 'x');
    await writeFile(path.join(root, 'node_modules', 'pkg', 'AGENTS.md'), 'x');
    await writeFile(path.join(root, '.cache', 'AGENTS.md'), 'x');
    await writeFile(path.join(root, 'a', 'b', 'GEMINI.md'), 'x');
    await writeFile(path.join(root, 'a', 'b', 'c', 'AGENTS.md'), 'x');
    expect(await scanWorkspace(root)).toEqual({ repos: [{ rel: '', branch: 'main' }], instructionFiles: ['CLAUDE.md', 'a/b/GEMINI.md'] });
  });
});

describe('readBranch', () => {
  it('follows a gitdir file and reports a detached HEAD', async () => {
    const root = await tmpDir();
    await writeFile(path.join(root, 'real', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    await writeFile(path.join(root, 'wt', '.git'), `gitdir: ${path.join(root, 'real')}\n`);
    expect(await readBranch(path.join(root, 'wt', '.git'))).toBe('분리된 HEAD 0123456');
  });

  it('returns undefined when HEAD cannot be read', async () => {
    const root = await tmpDir();
    expect(await readBranch(path.join(root, 'missing', '.git'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/workspace-scan.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/main/infra/workspace-scan.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoInfo, WorkspaceScan } from '../core/preamble.js';

const INSTRUCTION_NAMES = new Set(['agents.md', 'claude.md', 'gemini.md']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'venv', '__pycache__']);
const MAX_DIRS = 500; // 아주 큰 폴더를 골랐을 때 훑기가 길어지지 않게

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// HEAD 에서 브랜치 이름을 읽는다(git 을 실행하지 않음). .git 이 파일이면(worktree·submodule) 'gitdir:' 이 가리키는 곳을 본다.
export async function readBranch(gitPath: string): Promise<string | undefined> {
  try {
    let gitDir = gitPath;
    if ((await fs.stat(gitPath)).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(gitPath, 'utf8'));
      if (!m) return undefined;
      gitDir = path.resolve(path.dirname(gitPath), m[1]!.trim());
    }
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return /^[0-9a-f]{7,}$/i.test(head) ? `분리된 HEAD ${head.slice(0, 7)}` : undefined;
  } catch {
    return undefined;
  }
}

// 작업 폴더와 그 아래 maxDepth 단계까지에서 git 저장소와 지침 파일을 찾는다(작업공간 설계 §7).
// 숨김 폴더(.git 포함)·의존성·빌드 폴더와 링크는 들어가지 않는다.
export async function scanWorkspace(root: string, maxDepth = 2): Promise<WorkspaceScan> {
  const repos: RepoInfo[] = [];
  const instructionFiles: string[] = [];
  let visited = 0;
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (visited++ >= MAX_DIRS) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const relOf = (name: string) => (rel === '' ? name : `${rel}/${name}`);
    if (entries.some((e) => e.name === '.git')) {
      const branch = await readBranch(path.join(dir, '.git'));
      repos.push({ rel, ...(branch ? { branch } : {}) });
    }
    for (const e of entries) if (e.isFile() && INSTRUCTION_NAMES.has(e.name.toLowerCase())) instructionFiles.push(relOf(e.name));
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      await walk(path.join(dir, e.name), relOf(e.name), depth + 1);
    }
  }
  await walk(root, '', 0);
  return { repos: repos.sort((a, b) => byCodeUnit(a.rel, b.rel)), instructionFiles: instructionFiles.sort(byCodeUnit) };
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/workspace-scan.test.ts && npm run typecheck` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/workspace-scan.ts test/unit/workspace-scan.test.ts
git commit -m "feat(workspace): scan a folder for git repos, branches and instruction files"
```

---

### Task 6: 실행 파일 찾기

**Files:** Create `src/main/infra/exe-locator.ts` · Test `test/unit/exe-locator.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/exe-locator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { findOnPath } from '../../src/main/infra/exe-locator.js';

describe('findOnPath', () => {
  const files = new Set(['C:\\a\\claude.cmd', 'C:\\b\\claude.exe', 'C:\\c\\gemini.cmd']);
  const exists = (p: string) => files.has(p);

  it('follows PATH order and prefers .exe within one folder', () => {
    expect(findOnPath('claude', { PATH: 'C:\\b;C:\\a' }, exists)).toEqual({ path: 'C:\\b\\claude.exe', viaCmd: false });
    expect(findOnPath('claude', { PATH: 'C:\\a;C:\\b' }, exists)).toEqual({ path: 'C:\\a\\claude.cmd', viaCmd: true });
  });

  it('reads Path in either case and strips quotes and blanks', () => {
    expect(findOnPath('gemini', { Path: ';"C:\\c" ;C:\\a' }, exists)).toEqual({ path: 'C:\\c\\gemini.cmd', viaCmd: true });
  });

  it('returns undefined when nothing matches', () => {
    expect(findOnPath('codex', { PATH: 'C:\\a' }, exists)).toBeUndefined();
    expect(findOnPath('codex', {}, exists)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/exe-locator.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/main/infra/exe-locator.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

// viaCmd: npm 으로 설치한 CLI 의 .cmd 셰임 — cmd.exe 를 거쳐야 실행된다(agent-runner 의 commandFor).
export interface Executable { path: string; viaCmd: boolean }

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Windows 처럼 PATH 의 폴더 순서대로, 폴더마다 .exe → .cmd 를 찾는다.
export function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = isFile): Executable | undefined {
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const ext of ['.exe', '.cmd']) {
      const p = path.win32.join(dir, `${name}${ext}`);
      if (exists(p)) return { path: p, viaCmd: ext === '.cmd' };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/exe-locator.test.ts` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/exe-locator.ts test/unit/exe-locator.test.ts
git commit -m "feat(workspace): locate CLI executables on PATH"
```

---

### Task 7: 실행기 `AgentRunner`

**Files:** Create `src/main/infra/agent-runner.ts` · Test `test/unit/agent-runner.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/agent-runner.test.ts`:

```ts
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AgentRunner, childEnv, commandFor, type RunRequest } from '../../src/main/infra/agent-runner.js';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4321;
  written = '';
  constructor() {
    super();
    this.stdin.setEncoding('utf8').on('data', (d: string) => {
      this.written += d;
    });
  }
  finish(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

function setup() {
  const child = new FakeChild();
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const killed: number[] = [];
  const runner = new AgentRunner({
    spawn: (command, args, options) => {
      calls.push({ command, args, options: options as unknown as Record<string, unknown> });
      return child as unknown as ChildProcess;
    },
    killTree: async (pid) => {
      killed.push(pid);
      child.finish(1);
    },
    env: { PATH: 'C:\\x', CLAUDECODE: '1' },
  });
  return { child, calls, killed, runner };
}

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  exe: { path: 'C:\\bin\\claude.exe', viaCmd: false }, args: ['-p'], cwd: 'C:\\w', stdin: '', onLine: () => {}, ...over,
});

describe('AgentRunner', () => {
  it('streams JSON lines, writes the prompt to stdin and reports the exit code', async () => {
    const { child, calls, runner } = setup();
    const lines: unknown[] = [];
    const done = runner.run(req({ stdin: '안녕', onLine: (v) => lines.push(v) }));
    child.stdout.write('{"a":1}\r\n{"b":');
    child.stdout.write('2}\nnot json\n{"c":3}');
    child.stderr.write('warn');
    child.finish(0);
    expect(await done).toEqual({ exitCode: 0, cancelled: false, stderrTail: 'warn' });
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(child.written).toBe('안녕');
    expect(calls[0]).toMatchObject({ command: 'C:\\bin\\claude.exe', args: ['-p'], options: { cwd: 'C:\\w', windowsHide: true } });
    expect((calls[0]!.options.env as NodeJS.ProcessEnv).CLAUDECODE).toBeUndefined();
  });

  it('kills the process tree when cancelled', async () => {
    const { killed, runner } = setup();
    const ac = new AbortController();
    const done = runner.run(req({ signal: ac.signal }));
    ac.abort();
    expect(await done).toEqual({ exitCode: 1, cancelled: true, stderrTail: '' });
    expect(killed).toEqual([4321]);
  });

  it('does not start when already cancelled', async () => {
    const { calls, runner } = setup();
    const ac = new AbortController();
    ac.abort();
    expect(await runner.run(req({ signal: ac.signal }))).toEqual({ exitCode: null, cancelled: true, stderrTail: '' });
    expect(calls).toHaveLength(0);
  });

  it('rejects when the executable cannot be started', async () => {
    const { child, runner } = setup();
    const done = runner.run(req());
    child.emit('error', new Error('spawn ENOENT'));
    await expect(done).rejects.toThrow('실행하지 못했습니다: C:\\bin\\claude.exe (spawn ENOENT)');
  });
});

describe('commandFor', () => {
  it('runs an .exe directly', () => {
    expect(commandFor({ path: 'C:\\b\\claude.exe', viaCmd: false }, ['-p'])).toEqual({ command: 'C:\\b\\claude.exe', args: ['-p'], verbatim: false });
  });

  it('wraps a .cmd shim in cmd.exe with the path quoted', () => {
    expect(commandFor({ path: 'C:\\Program Files\\n\\claude.cmd', viaCmd: true }, ['-p', '--permission-mode', 'plan'], 'C:\\Windows\\system32\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\n\\claude.cmd" -p --permission-mode plan"'],
      verbatim: true,
    });
  });

  it('refuses arguments cmd.exe could interpret', () => {
    expect(() => commandFor({ path: 'c.cmd', viaCmd: true }, ['a&b'])).toThrow('cmd');
  });
});

describe('childEnv', () => {
  it('drops the nested Claude Code markers in any case', () => {
    expect(childEnv({ PATH: 'x', CLAUDECODE: '1', claude_code_entrypoint: 'cli', HOME: 'C:\\h' })).toEqual({ PATH: 'x', HOME: 'C:\\h' });
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/agent-runner.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/main/infra/agent-runner.ts`:

```ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { Executable } from './exe-locator.js';

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; windowsHide: boolean; windowsVerbatimArguments?: boolean },
) => ChildProcess;

export interface RunRequest {
  exe: Executable;
  args: string[];
  cwd: string;
  stdin: string; // 프롬프트 — 다 쓰고 닫는다(작업공간 설계 W12)
  signal?: AbortSignal; // 끊기면 프로세스 트리를 끝낸다(W13)
  onLine(value: unknown): void; // stdout 의 JSON 한 줄(JSON 이 아닌 줄은 버린다)
}

export interface RunResult { exitCode: number | null; cancelled: boolean; stderrTail: string }

const STDERR_TAIL = 2048;
const SAFE_ARG = /^[\w.:\-[\]]+$/;

// 앱이 Claude Code 안에서 실행됐을 때(개발 중) 물려받는 표시를 지운다 — 남아 있으면 claude 가 중첩 실행으로 보고 거부할 수 있다(Phase 0 W-V5).
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/i.test(k)) env[k] = v;
  return env;
}

// .cmd 는 cmd.exe 로만 실행된다. 인자는 따옴표 없이 넘겨도 안전한 문자(영문·숫자·_.:-[])만 허용해 명령 주입을 막는다 —
// 사용자 글은 stdin 으로 가므로 인자에는 플래그·모드·세션 ID·모델 이름만 있다.
export function commandFor(exe: Executable, args: string[], comSpec = process.env.ComSpec ?? 'cmd.exe'): { command: string; args: string[]; verbatim: boolean } {
  if (!exe.viaCmd) return { command: exe.path, args, verbatim: false };
  const bad = args.find((a) => !SAFE_ARG.test(a));
  if (bad !== undefined) throw new Error(`cmd 로 넘길 수 없는 인자입니다: ${bad}`);
  return { command: comSpec, args: ['/d', '/s', '/c', `""${exe.path}" ${args.join(' ')}"`], verbatim: true };
}

// CLI 와 그 CLI 가 띄운 셸 명령까지 끝낸다.
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}

// 작업공간 CLI 실행기: 한 턴에 프로세스 하나(W11). stdout 은 줄 단위 JSON, stderr 는 끝부분만 모은다.
// 자식의 출력은 파이프로만 받는다 — 백엔드 stdout 은 화면과의 프로토콜 채널이다.
export class AgentRunner {
  constructor(private readonly deps: { spawn?: SpawnFn; killTree?: (pid: number) => Promise<void>; env?: NodeJS.ProcessEnv } = {}) {}

  run(req: RunRequest): Promise<RunResult> {
    const spawnFn = this.deps.spawn ?? (spawn as unknown as SpawnFn);
    const kill = this.deps.killTree ?? killTree;
    return new Promise<RunResult>((resolve, reject) => {
      if (req.signal?.aborted) {
        resolve({ exitCode: null, cancelled: true, stderrTail: '' });
        return;
      }
      const cmd = commandFor(req.exe, req.args);
      const child = spawnFn(cmd.command, cmd.args, {
        cwd: req.cwd,
        env: childEnv(this.deps.env ?? process.env),
        windowsHide: true,
        ...(cmd.verbatim ? { windowsVerbatimArguments: true } : {}),
      });
      let cancelled = false;
      let stderr = '';
      let buf = '';
      const emitLine = (line: string) => {
        const t = line.trim();
        if (!t) return;
        let value: unknown;
        try {
          value = JSON.parse(t);
        } catch {
          return;
        }
        req.onLine(value);
      };
      const onAbort = () => {
        cancelled = true;
        if (child.pid !== undefined) void kill(child.pid);
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout!.setEncoding('utf8').on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          emitLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr!.setEncoding('utf8').on('data', (d: string) => {
        stderr = (stderr + d).slice(-STDERR_TAIL);
      });
      child.stdin!.on('error', () => {}); // 먼저 끝난 프로세스에 쓰면 EPIPE — 결과는 종료 코드로 판단한다
      child.stdin!.end(req.stdin, 'utf8');
      child.on('error', (e) => {
        req.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`실행하지 못했습니다: ${req.exe.path} (${e.message})`));
      });
      child.on('close', (code: number | null) => {
        req.signal?.removeEventListener('abort', onAbort);
        emitLine(buf);
        resolve({ exitCode: code, cancelled, stderrTail: stderr.trim() });
      });
    });
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/agent-runner.test.ts && npm run typecheck` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/agent-runner.ts test/unit/agent-runner.test.ts
git commit -m "feat(workspace): child-process runner with JSON lines, stdin prompt and tree kill"
```

---

### Task 8: DB 마이그레이션 4 — 작업공간·대화·메시지·도구 세션

**Files:** Modify `src/main/infra/app-db.ts`, `test/unit/app-db.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/app-db.test.ts` 끝에 추가:

```ts
describe('AppDb workspaces (migration 4)', () => {
  const msg = (conversationId: number, over: Partial<NewWsMessage> = {}): NewWsMessage => ({
    conversationId, role: 'user', agent: 'claude', blocksJson: '[]', createdAt: 'T', ...over,
  });

  it('adds and lists workspaces and rejects a folder registered twice in any case', () => {
    const w = db.addWorkspace('hub', 'C:\\w\\hub', 'T1');
    expect(w).toEqual({ id: w.id, name: 'hub', folder: 'C:\\w\\hub', createdAt: 'T1' });
    expect(() => db.addWorkspace('again', 'c:\\W\\HUB', 'T2')).toThrow('이미 등록된 폴더입니다');
    expect(db.listWorkspaces()).toEqual([w]);
    expect(db.findWorkspace(w.id)).toEqual(w);
  });

  it('numbers messages per conversation and lists them in order', () => {
    const w = db.addWorkspace('hub', 'C:\\w', 'T');
    const c = db.createConversation(w.id, '첫 대화', 'claude', 'T');
    expect(c).toEqual({ id: c.id, workspaceId: w.id, title: '첫 대화', agent: 'claude', createdAt: 'T', updatedAt: 'T' });
    expect(db.addMessage(msg(c.id))).toBe(1);
    expect(db.addMessage(msg(c.id, { role: 'assistant', blocksJson: '[{"kind":"text","text":"hi"}]', status: 'error', error: 'boom', usageJson: '{}' }))).toBe(2);
    const other = db.createConversation(w.id, '다른', 'claude', 'T');
    expect(db.addMessage(msg(other.id))).toBe(1);
    expect(db.listMessages(c.id)).toEqual([
      { seq: 1, role: 'user', agent: 'claude', blocksJson: '[]', status: 'ok', error: null, usageJson: null, createdAt: 'T' },
      { seq: 2, role: 'assistant', agent: 'claude', blocksJson: '[{"kind":"text","text":"hi"}]', status: 'error', error: 'boom', usageJson: '{}', createdAt: 'T' },
    ]);
  });

  it('keeps one native session per conversation and agent', () => {
    const w = db.addWorkspace('hub', 'C:\\w', 'T');
    const c = db.createConversation(w.id, 'a', 'claude', 'T');
    db.upsertAgentSession({ conversationId: c.id, agent: 'claude', nativeSessionId: 's1', seenSeq: 2 });
    db.upsertAgentSession({ conversationId: c.id, agent: 'claude', nativeSessionId: 's1', seenSeq: 4 });
    expect(db.findAgentSession(c.id, 'claude')).toEqual({ conversationId: c.id, agent: 'claude', nativeSessionId: 's1', seenSeq: 4 });
  });

  it('orders conversations by last activity and removes everything with the workspace', () => {
    const w = db.addWorkspace('hub', 'C:\\w', 'T');
    const a = db.createConversation(w.id, 'a', 'claude', '2026-10-01T00:00:00Z');
    db.createConversation(w.id, 'b', 'claude', '2026-10-02T00:00:00Z');
    db.touchConversation(a.id, 'claude', '2026-10-03T00:00:00Z');
    expect(db.listConversations(w.id).map((c) => c.title)).toEqual(['a', 'b']);
    db.addMessage(msg(a.id));
    db.upsertAgentSession({ conversationId: a.id, agent: 'claude', nativeSessionId: 's', seenSeq: 1 });
    db.deleteWorkspace(w.id);
    expect(db.listWorkspaces()).toEqual([]);
    expect(db.findConversation(a.id)).toBeUndefined();
    expect(db.listMessages(a.id)).toEqual([]);
    expect(db.findAgentSession(a.id, 'claude')).toBeUndefined();
  });

  it('deletes a single conversation with its messages', () => {
    const w = db.addWorkspace('hub', 'C:\\w', 'T');
    const c = db.createConversation(w.id, 'a', 'claude', 'T');
    db.addMessage(msg(c.id));
    db.deleteConversation(c.id);
    expect(db.listConversations(w.id)).toEqual([]);
    expect(db.listMessages(c.id)).toEqual([]);
  });
});
```

같은 파일 맨 위 import 를 `import { AppDb, type NewAccount, type NewWsMessage } from '../../src/main/infra/app-db.js';` 로 바꾸고, v1 파일 마이그레이션 테스트의 `.toBe(3)` 을 `.toBe(4)` 로 바꾼다.

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/app-db.test.ts` — Expected: FAIL (`addWorkspace` 없음, user_version 3)

- [ ] **Step 3: 구현** — `src/main/infra/app-db.ts`:

맨 위 import 에 추가:

```ts
import type { AgentId } from '../core/agent-events.js';
```

`ImportRecord` 아래에 형식 추가:

```ts
export interface WorkspaceRow { id: number; name: string; folder: string; createdAt: string }
export interface ConversationRow { id: number; workspaceId: number; title: string; agent: AgentId; createdAt: string; updatedAt: string }
export type WsMessageStatus = 'ok' | 'error' | 'cancelled';
export interface NewWsMessage {
  conversationId: number;
  role: 'user' | 'assistant';
  agent: AgentId; // 사용자 메시지는 받은 도구, 답변은 만든 도구
  blocksJson: string; // IrBlock[]
  status?: WsMessageStatus; // 생략하면 'ok'
  error?: string;
  usageJson?: string; // TurnUsage
  createdAt: string;
}
export interface WsMessageRow {
  seq: number;
  role: 'user' | 'assistant';
  agent: AgentId;
  blocksJson: string;
  status: WsMessageStatus;
  error: string | null;
  usageJson: string | null;
  createdAt: string;
}
export interface AgentSessionRow { conversationId: number; agent: AgentId; nativeSessionId: string; seenSeq: number }
```

`MIGRATIONS` 배열 끝에 추가:

```ts
  `CREATE TABLE workspaces (
     id         INTEGER PRIMARY KEY,
     name       TEXT NOT NULL,
     folder     TEXT NOT NULL UNIQUE COLLATE NOCASE, -- 실제 경로(canonicalPath). Windows 경로라 대소문자 무시
     created_at TEXT NOT NULL
   );
   CREATE TABLE ws_conversations (
     id           INTEGER PRIMARY KEY,
     workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     title        TEXT NOT NULL,
     agent        TEXT NOT NULL, -- 마지막으로 보낸 도구
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   );
   CREATE INDEX ws_conversations_ws ON ws_conversations (workspace_id, updated_at);
   CREATE TABLE ws_messages (
     id              INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL REFERENCES ws_conversations(id) ON DELETE CASCADE,
     seq             INTEGER NOT NULL,
     role            TEXT NOT NULL,
     agent           TEXT NOT NULL,
     blocks_json     TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'ok',
     error           TEXT,
     usage_json      TEXT,
     created_at      TEXT NOT NULL,
     UNIQUE (conversation_id, seq)
   );
   CREATE TABLE ws_agent_sessions (
     conversation_id   INTEGER NOT NULL REFERENCES ws_conversations(id) ON DELETE CASCADE,
     agent             TEXT NOT NULL,
     native_session_id TEXT NOT NULL,
     seen_seq          INTEGER NOT NULL, -- 이 도구 세션이 본 마지막 메시지 seq (작업공간 설계 §8)
     PRIMARY KEY (conversation_id, agent)
   );`,
```

`ACCOUNT_COLUMNS` 아래에:

```ts
const WORKSPACE_COLUMNS = 'id, name, folder, created_at AS createdAt';
const CONVERSATION_COLUMNS = 'id, workspace_id AS workspaceId, title, agent, created_at AS createdAt, updated_at AS updatedAt';
```

`AppDb` 클래스 끝(`findAccountById` 다음)에:

```ts
  // --- 작업공간 (작업공간 설계 §8) ---

  addWorkspace(name: string, folder: string, at: string): WorkspaceRow {
    if (this.db.prepare('SELECT id FROM workspaces WHERE folder = ?').get(folder)) throw new Error('이미 등록된 폴더입니다');
    const r = this.db.prepare('INSERT INTO workspaces (name, folder, created_at) VALUES (?, ?, ?)').run(name, folder, at);
    return this.findWorkspace(Number(r.lastInsertRowid))!;
  }

  findWorkspace(id: number): WorkspaceRow | undefined {
    return this.db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?`).get(id) as WorkspaceRow | undefined;
  }

  listWorkspaces(): WorkspaceRow[] {
    return this.db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces ORDER BY name COLLATE NOCASE, id`).all() as WorkspaceRow[];
  }

  // 대화·메시지·도구 세션은 ON DELETE CASCADE 로 함께 지워진다(이 앱의 기록만 — 폴더와 각 도구의 세션 파일은 그대로).
  deleteWorkspace(id: number): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  createConversation(workspaceId: number, title: string, agent: AgentId, at: string): ConversationRow {
    const r = this.db
      .prepare('INSERT INTO ws_conversations (workspace_id, title, agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(workspaceId, title, agent, at, at);
    return this.findConversation(Number(r.lastInsertRowid))!;
  }

  findConversation(id: number): ConversationRow | undefined {
    return this.db.prepare(`SELECT ${CONVERSATION_COLUMNS} FROM ws_conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  }

  listConversations(workspaceId: number): ConversationRow[] {
    return this.db
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM ws_conversations WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC`)
      .all(workspaceId) as ConversationRow[];
  }

  touchConversation(id: number, agent: AgentId, at: string): void {
    this.db.prepare('UPDATE ws_conversations SET agent = ?, updated_at = ? WHERE id = ?').run(agent, at, id);
  }

  deleteConversation(id: number): void {
    this.db.prepare('DELETE FROM ws_conversations WHERE id = ?').run(id);
  }

  // seq 는 대화마다 1 부터 — 트랜잭션 안에서 다음 번호를 정해 넣고 그 번호를 돌려준다.
  addMessage(m: NewWsMessage): number {
    return this.db.transaction(() => {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ws_messages WHERE conversation_id = ?')
        .get(m.conversationId) as { next: number };
      this.db
        .prepare(
          `INSERT INTO ws_messages (conversation_id, seq, role, agent, blocks_json, status, error, usage_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.conversationId, next, m.role, m.agent, m.blocksJson, m.status ?? 'ok', m.error ?? null, m.usageJson ?? null, m.createdAt);
      return next;
    })();
  }

  listMessages(conversationId: number): WsMessageRow[] {
    return this.db
      .prepare(
        `SELECT seq, role, agent, blocks_json AS blocksJson, status, error, usage_json AS usageJson, created_at AS createdAt
         FROM ws_messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversationId) as WsMessageRow[];
  }

  findAgentSession(conversationId: number, agent: AgentId): AgentSessionRow | undefined {
    return this.db
      .prepare(
        `SELECT conversation_id AS conversationId, agent, native_session_id AS nativeSessionId, seen_seq AS seenSeq
         FROM ws_agent_sessions WHERE conversation_id = ? AND agent = ?`,
      )
      .get(conversationId, agent) as AgentSessionRow | undefined;
  }

  upsertAgentSession(s: AgentSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO ws_agent_sessions (conversation_id, agent, native_session_id, seen_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (conversation_id, agent) DO UPDATE SET native_session_id = excluded.native_session_id, seen_seq = excluded.seen_seq`,
      )
      .run(s.conversationId, s.agent, s.nativeSessionId, s.seenSeq);
  }
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/app-db.test.ts && npm run typecheck` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/infra/app-db.ts test/unit/app-db.test.ts
git commit -m "feat(workspace): app.db migration 4 for workspaces, conversations and agent sessions"
```

---

### Task 9: `WorkspaceService`

**Files:** Create `src/main/services/workspace-service.ts` · Test `test/unit/workspace-service.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/workspace-service.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/main/core/agent-events.js';
import { withPreamble, workspacePreamble, type WorkspaceScan } from '../../src/main/core/preamble.js';
import type { RunRequest, RunResult } from '../../src/main/infra/agent-runner.js';
import { AppDb } from '../../src/main/infra/app-db.js';
import { canonicalPath } from '../../src/main/infra/real-path.js';
import { claudeArgs } from '../../src/main/providers/claude/agent.js';
import { WorkspaceService, type SendRequest } from '../../src/main/services/workspace-service.js';
import { tmpPaths } from '../helpers/tmp-paths.js';

const T = '2026-10-06T00:00:00.000Z';
const SCAN: WorkspaceScan = { repos: [{ rel: 'agent', branch: 'master' }], instructionFiles: ['agent/AGENTS.md'] };
const INIT = (id: string) => ({ type: 'system', subtype: 'init', session_id: id, model: 'm' });
const TEXT = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const OK = { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } };
const USAGE = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 };

class FakeRunner {
  calls: RunRequest[] = [];
  lines: unknown[] = [];
  result: RunResult = { exitCode: 0, cancelled: false, stderrTail: '' };
  error: Error | undefined;
  gate: Promise<void> | undefined;
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    if (this.gate) await this.gate;
    if (this.error) throw this.error;
    for (const l of this.lines) req.onLine(l);
    return this.result;
  }
}

let db: AppDb;
let runner: FakeRunner;
let svc: WorkspaceService;
let folder: string;

function service(withCli = true): WorkspaceService {
  return new WorkspaceService({
    db,
    runner,
    locate: () => (withCli ? { path: 'C:\\bin\\claude.exe', viaCmd: false } : undefined),
    scan: async () => SCAN,
    now: () => T,
    uuid: () => 'new-uuid',
  });
}

beforeEach(async () => {
  const p = await tmpPaths();
  folder = path.join(p.home, 'hub');
  await fs.mkdir(folder);
  db = new AppDb(':memory:');
  runner = new FakeRunner();
  svc = service();
});

async function conversation() {
  const w = await svc.addWorkspace(folder);
  return { w, c: svc.newConversation(w.id, 'claude', '  구조를\n설명해줘  ') };
}

const send = (conversationId: number, over: Partial<SendRequest> = {}) =>
  svc.send({ conversationId, agent: 'claude', mode: 'acceptEdits', text: '구조를 설명해줘', ...over }, () => {});

describe('WorkspaceService workspaces and conversations', () => {
  it('registers the real folder under its folder name, or a given name', async () => {
    const w = await svc.addWorkspace(folder);
    expect(w).toMatchObject({ name: 'hub', folder: canonicalPath(folder), createdAt: T });
    const other = path.join(folder, 'sub');
    await fs.mkdir(other);
    expect(await svc.addWorkspace(other, '  백엔드  ')).toMatchObject({ name: '백엔드' });
  });

  it('rejects relative paths, missing folders, drive roots and duplicates', async () => {
    await expect(svc.addWorkspace('relative\\dir')).rejects.toThrow('절대 경로');
    await expect(svc.addWorkspace(path.join(folder, 'missing'))).rejects.toThrow('폴더를 찾을 수 없습니다');
    await expect(svc.addWorkspace('C:\\')).rejects.toThrow('드라이브 전체');
    await svc.addWorkspace(folder);
    await expect(svc.addWorkspace(folder.toUpperCase())).rejects.toThrow('이미 등록된 폴더입니다');
  });

  it('titles a conversation from the first line of text, or "새 대화"', async () => {
    const { w, c } = await conversation();
    expect(c.title).toBe('구조를 설명해줘');
    expect(svc.newConversation(w.id, 'claude', '   ').title).toBe('새 대화');
    expect(() => svc.newConversation(999, 'claude', 'x')).toThrow('작업공간을 찾을 수 없습니다');
  });
});

describe('WorkspaceService.send', () => {
  it('starts a new Claude session with the workspace preamble and stores both messages', async () => {
    const { w, c } = await conversation();
    runner.lines = [INIT('sess-1'), TEXT('네'), OK];
    const events: AgentEvent[] = [];
    const r = await svc.send({ conversationId: c.id, agent: 'claude', mode: 'acceptEdits', text: '구조를 설명해줘' }, (e) => events.push(e));
    expect(r).toEqual({ status: 'ok', usage: USAGE });
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'done']);
    expect(runner.calls[0]).toMatchObject({
      exe: { path: 'C:\\bin\\claude.exe', viaCmd: false },
      args: claudeArgs({ mode: 'acceptEdits', session: { create: 'new-uuid' } }),
      cwd: w.folder,
      stdin: withPreamble(workspacePreamble(w.folder, SCAN, 'claude'), '구조를 설명해줘'),
    });
    expect(svc.messages(c.id)).toEqual([
      { seq: 1, role: 'user', agent: 'claude', blocks: [{ kind: 'text', text: '구조를 설명해줘' }], status: 'ok', createdAt: T },
      { seq: 2, role: 'assistant', agent: 'claude', blocks: [{ kind: 'text', text: '네' }], status: 'ok', usage: USAGE, createdAt: T },
    ]);
    expect(db.findAgentSession(c.id, 'claude')).toEqual({ conversationId: c.id, agent: 'claude', nativeSessionId: 'sess-1', seenSeq: 2 });
  });

  it('resumes the saved session on the next turn without repeating the preamble', async () => {
    const { c } = await conversation();
    runner.lines = [INIT('sess-1'), TEXT('네'), OK];
    await send(c.id, { text: '첫' });
    await send(c.id, { mode: 'plan', model: 'opus', text: '다음' });
    expect(runner.calls[1]).toMatchObject({ args: claudeArgs({ mode: 'plan', model: 'opus', session: { resume: 'sess-1' } }), stdin: '다음' });
    expect(db.findAgentSession(c.id, 'claude')?.seenSeq).toBe(4);
  });

  it('stores a failed turn with the CLI error and keeps the session', async () => {
    const { c } = await conversation();
    runner.lines = [INIT('sess-1'), TEXT('하다가'), { type: 'result', subtype: 'success', is_error: true, result: 'Usage limit reached' }];
    runner.result = { exitCode: 1, cancelled: false, stderrTail: '' };
    expect(await send(c.id)).toEqual({ status: 'error', error: 'Usage limit reached' });
    expect(svc.messages(c.id)[1]).toMatchObject({ status: 'error', error: 'Usage limit reached', blocks: [{ kind: 'text', text: '하다가' }] });
    expect(db.findAgentSession(c.id, 'claude')?.nativeSessionId).toBe('sess-1');
  });

  it('falls back to stderr when the CLI exits without a result, and saves no session it never saw', async () => {
    const { c } = await conversation();
    runner.result = { exitCode: 2, cancelled: false, stderrTail: 'Not logged in' };
    expect(await send(c.id)).toEqual({ status: 'error', error: 'Not logged in' });
    expect(db.findAgentSession(c.id, 'claude')).toBeUndefined();
    runner.result = { exitCode: 3, cancelled: false, stderrTail: '' };
    expect(await send(c.id)).toEqual({ status: 'error', error: 'CLI 가 종료 코드 3 로 끝났습니다' });
  });

  it('records a cancelled turn with what arrived so far', async () => {
    const { c } = await conversation();
    runner.lines = [INIT('sess-1'), TEXT('반쯤')];
    runner.result = { exitCode: 1, cancelled: true, stderrTail: '' };
    expect(await send(c.id)).toEqual({ status: 'cancelled' });
    expect(svc.messages(c.id)[1]).toMatchObject({ status: 'cancelled', blocks: [{ kind: 'text', text: '반쯤' }] });
  });

  it('turns a runner failure into an error message', async () => {
    const { c } = await conversation();
    runner.error = new Error('실행하지 못했습니다: C:\\bin\\claude.exe (spawn ENOENT)');
    expect(await send(c.id)).toEqual({ status: 'error', error: '실행하지 못했습니다: C:\\bin\\claude.exe (spawn ENOENT)' });
    expect(svc.isRunning()).toBe(false);
  });

  it('runs one turn at a time across the workspace', async () => {
    const { c } = await conversation();
    let open!: () => void;
    runner.gate = new Promise((r) => {
      open = r;
    });
    const first = send(c.id, { text: '첫' });
    await expect(send(c.id, { text: '둘' })).rejects.toThrow('다른 대화가 실행 중입니다');
    expect(svc.isRunning()).toBe(true);
    expect(() => svc.deleteConversation(c.id)).toThrow('실행 중');
    open();
    await first;
    expect(svc.isRunning()).toBe(false);
  });

  it('refuses to send without the CLI or the folder, storing nothing', async () => {
    const { w, c } = await conversation();
    await expect(service(false).send({ conversationId: c.id, agent: 'claude', mode: 'acceptEdits', text: 'x' }, () => {})).rejects.toThrow('Claude CLI 를 찾을 수 없습니다');
    await fs.rm(w.folder, { recursive: true });
    await expect(send(c.id)).rejects.toThrow('작업 폴더를 찾을 수 없습니다');
    await expect(send(999)).rejects.toThrow('대화를 찾을 수 없습니다');
    expect(svc.messages(c.id)).toEqual([]);
    expect(svc.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/workspace-service.test.ts` — Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현** — `src/main/services/workspace-service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_NAMES, type AgentEvent, type AgentId, type TurnUsage } from '../core/agent-events.js';
import type { IrBlock } from '../core/ir.js';
import { withPreamble, workspacePreamble, type WorkspaceScan } from '../core/preamble.js';
import { TurnBuilder } from '../core/turn.js';
import type { AgentRunner } from '../infra/agent-runner.js';
import type { AppDb, ConversationRow, WorkspaceRow, WsMessageStatus } from '../infra/app-db.js';
import type { Executable } from '../infra/exe-locator.js';
import { canonicalPath } from '../infra/real-path.js';
import { scanWorkspace } from '../infra/workspace-scan.js';
import { claudeArgs, parseClaudeEvent, type ClaudeMode, type ClaudeSession } from '../providers/claude/agent.js';

export interface WorkspaceDeps {
  db: AppDb;
  runner: Pick<AgentRunner, 'run'>;
  locate(agent: AgentId): Executable | undefined;
  scan?: (folder: string) => Promise<WorkspaceScan>; // 테스트 주입용 — 기본은 실제 폴더 훑기
  now?: () => string;
  uuid?: () => string;
}

export interface SendRequest { conversationId: number; agent: AgentId; mode: ClaudeMode; model?: string; text: string }
export interface SendResult { status: WsMessageStatus; error?: string; usage?: TurnUsage }
export interface WsMessage {
  seq: number;
  role: 'user' | 'assistant';
  agent: AgentId;
  blocks: IrBlock[];
  status: WsMessageStatus;
  error?: string;
  usage?: TurnUsage;
  createdAt: string;
}

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);

// 작업공간(docs/superpowers/specs/2026-10-06-workspace-design.md): 폴더 등록, 대화 기록, 한 턴 실행.
export class WorkspaceService {
  private running = false;

  constructor(private readonly d: WorkspaceDeps) {}

  private now(): string {
    return this.d.now ? this.d.now() : new Date().toISOString();
  }

  isRunning(): boolean {
    return this.running;
  }

  // 화면이 고른 폴더를 확인해 등록한다(설계 §4.1). 경로 별칭은 실제 경로로 푼다(W6).
  async addWorkspace(folderRaw: unknown, nameRaw?: unknown): Promise<WorkspaceRow> {
    if (typeof folderRaw !== 'string' || folderRaw.length === 0 || folderRaw.length > 1024) throw new Error('folder 는 1~1024자 문자열이어야 합니다');
    if (!path.isAbsolute(folderRaw)) throw new Error('폴더는 절대 경로여야 합니다');
    const folder = canonicalPath(path.resolve(folderRaw));
    if (path.parse(folder).root === folder) throw new Error('드라이브 전체는 작업공간으로 쓸 수 없습니다');
    if (!(await isDir(folder))) throw new Error(`폴더를 찾을 수 없습니다: ${folder}`);
    const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim().slice(0, 64) : path.basename(folder);
    return this.d.db.addWorkspace(name, folder, this.now());
  }

  removeWorkspace(id: number): void {
    if (this.running) throw new Error('대화가 실행 중입니다 — 끝나거나 멈춘 뒤 제거하세요');
    if (!this.d.db.findWorkspace(id)) throw new Error('작업공간을 찾을 수 없습니다');
    this.d.db.deleteWorkspace(id);
  }

  newConversation(workspaceId: number, agent: AgentId, title: string): ConversationRow {
    if (!this.d.db.findWorkspace(workspaceId)) throw new Error('작업공간을 찾을 수 없습니다');
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 60);
    return this.d.db.createConversation(workspaceId, clean || '새 대화', agent, this.now());
  }

  deleteConversation(id: number): void {
    if (this.running) throw new Error('대화가 실행 중입니다 — 끝나거나 멈춘 뒤 삭제하세요');
    if (!this.d.db.findConversation(id)) throw new Error('대화를 찾을 수 없습니다');
    this.d.db.deleteConversation(id);
  }

  messages(conversationId: number): WsMessage[] {
    return this.d.db.listMessages(conversationId).map((m) => ({
      seq: m.seq,
      role: m.role,
      agent: m.agent,
      blocks: JSON.parse(m.blocksJson) as IrBlock[],
      status: m.status,
      ...(m.error !== null ? { error: m.error } : {}),
      ...(m.usageJson !== null ? { usage: JSON.parse(m.usageJson) as TurnUsage } : {}),
      createdAt: m.createdAt,
    }));
  }

  // 한 턴(W9·W11): 사용자 메시지 저장 → CLI 실행(이 도구 세션의 첫 턴이면 작업공간 안내를 붙여 새 세션, 아니면 이어 하기)
  // → 이벤트를 화면에 넘기며 모음 → 답변 저장. 실패·멈춤도 받은 데까지 저장해 결과로 알린다 — 예외는 실행 전 확인 실패뿐.
  async send(req: SendRequest, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<SendResult> {
    if (this.running) throw new Error('다른 대화가 실행 중입니다 — 끝나거나 멈춘 뒤 보내세요');
    this.running = true;
    try {
      const conv = this.d.db.findConversation(req.conversationId);
      if (!conv) throw new Error('대화를 찾을 수 없습니다');
      const ws = this.d.db.findWorkspace(conv.workspaceId);
      if (!ws) throw new Error('작업공간을 찾을 수 없습니다');
      if (!(await isDir(ws.folder))) throw new Error(`작업 폴더를 찾을 수 없습니다: ${ws.folder}`);
      const exe = this.d.locate(req.agent);
      if (!exe) throw new Error(`${AGENT_NAMES[req.agent]} CLI 를 찾을 수 없습니다 — 설치한 뒤 다시 시도하세요`);

      this.d.db.addMessage({ conversationId: conv.id, role: 'user', agent: req.agent, blocksJson: JSON.stringify([{ kind: 'text', text: req.text }]), createdAt: this.now() });
      const prior = this.d.db.findAgentSession(conv.id, req.agent);
      let session: ClaudeSession;
      let stdin = req.text;
      if (prior) {
        session = { resume: prior.nativeSessionId };
      } else {
        session = { create: (this.d.uuid ?? randomUUID)() };
        const scan = await (this.d.scan ?? scanWorkspace)(ws.folder);
        stdin = withPreamble(workspacePreamble(ws.folder, scan, req.agent), req.text);
      }
      const args = claudeArgs({ mode: req.mode, ...(req.model ? { model: req.model } : {}), session });

      const turn = new TurnBuilder();
      let cancelled = false;
      let failure: string | undefined;
      try {
        const r = await this.d.runner.run({
          exe,
          args,
          cwd: ws.folder,
          stdin,
          ...(signal ? { signal } : {}),
          onLine: (v) => {
            for (const e of parseClaudeEvent(v)) {
              turn.add(e);
              onEvent(e);
            }
          },
        });
        cancelled = r.cancelled;
        if (!cancelled && !turn.finished?.ok) {
          failure = turn.finished?.error ?? (r.stderrTail || `CLI 가 종료 코드 ${String(r.exitCode)} 로 끝났습니다`);
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }

      const status: WsMessageStatus = cancelled ? 'cancelled' : failure !== undefined ? 'error' : 'ok';
      const usage = turn.finished?.usage;
      const at = this.now();
      const replySeq = this.d.db.addMessage({
        conversationId: conv.id,
        role: 'assistant',
        agent: req.agent,
        blocksJson: JSON.stringify(turn.blocks),
        status,
        ...(failure !== undefined ? { error: failure } : {}),
        ...(usage ? { usageJson: JSON.stringify(usage) } : {}),
        createdAt: at,
      });
      // 세션 ID 는 CLI 가 알려 준 것을 믿는다 — 시작 전에 실패해 세션이 생기지 않았으면 저장하지 않아 다음 턴이 새로 만든다.
      const sessionId = turn.sessionId ?? prior?.nativeSessionId;
      if (sessionId) this.d.db.upsertAgentSession({ conversationId: conv.id, agent: req.agent, nativeSessionId: sessionId, seenSeq: replySeq });
      this.d.db.touchConversation(conv.id, req.agent, at);
      return { status, ...(failure !== undefined ? { error: failure } : {}), ...(usage ? { usage } : {}) };
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/workspace-service.test.ts && npm run typecheck` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/workspace-service.ts test/unit/workspace-service.test.ts
git commit -m "feat(workspace): WorkspaceService registers folders and runs Claude turns"
```

---

### Task 10: 프로토콜 — `event` 보내기, `cancel` 받기

**Files:** Modify `src/rpc/server.ts`, `src/rpc/handlers.ts`(`HandlerContext`), `test/unit/rpc-server.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/rpc-server.test.ts` 의 import 를 `import { isCancelMessage, parseMessage, progressCtx } from '../../src/rpc/server.js';` 로 바꾸고 끝에 추가:

```ts
describe('progressCtx events and cancel', () => {
  it('sends an event message carrying the request id and data', () => {
    const sent: unknown[] = [];
    const ctx = progressCtx('r7', (msg) => sent.push(msg));
    ctx.emit?.({ conversationId: 1, event: { type: 'textDelta', text: '안' } });
    expect(sent).toEqual([{ type: 'event', id: 'r7', data: { conversationId: 1, event: { type: 'textDelta', text: '안' } } }]);
  });

  it('exposes the abort signal it was given', () => {
    const ac = new AbortController();
    const ctx = progressCtx(1, () => {}, ac.signal);
    expect(ctx.signal?.aborted).toBe(false);
    ac.abort();
    expect(ctx.signal?.aborted).toBe(true);
  });
});

describe('isCancelMessage', () => {
  it('recognizes cancel messages with a request id', () => {
    expect(isCancelMessage({ type: 'cancel', id: 'r1' })).toBe(true);
    expect(isCancelMessage({ type: 'cancel', id: 3 })).toBe(true);
    expect(isCancelMessage({ type: 'cancel' })).toBe(false);
    expect(isCancelMessage({ type: 'request', id: 1 })).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/rpc-server.test.ts` — Expected: FAIL (`isCancelMessage` 없음)

- [ ] **Step 3: 구현**

`src/rpc/handlers.ts` 의 `HandlerContext`:

```ts
export interface HandlerContext {
  progress(step: string): void;
  emit?(data: unknown): void; // 오래 걸리는 요청의 중간 이벤트 — { type: 'event', id, data } 로 나간다
  signal?: AbortSignal; // 화면이 { type: 'cancel', id } 를 보내면 끊긴다
}
```

`src/rpc/server.ts`:

`PromptAnswerMessage` 아래에:

```ts
interface CancelMessage {
  type: 'cancel';
  id: number | string;
}

export function isCancelMessage(m: unknown): m is CancelMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return r.type === 'cancel' && (typeof r.id === 'number' || typeof r.id === 'string');
}
```

`progressCtx` 를 바꾼다:

```ts
// 요청 처리 중 진행 상황({ type: 'progress' })·중간 이벤트({ type: 'event' })를 흘려보내고, 취소 신호를 넘기는 컨텍스트.
export function progressCtx(id: number | string, send: (msg: unknown) => void, signal?: AbortSignal): HandlerContext {
  return {
    progress(step: string): void {
      send({ type: 'progress', id, step });
    },
    emit(data: unknown): void {
      send({ type: 'event', id, data });
    },
    ...(signal ? { signal } : {}),
  };
}
```

`main()` 에서 `let inFlight = 0;` 위에 `const controllers = new Map<number | string, AbortController>();` 를 두고, `rl.on('line', …)` 안의 `isPromptAnswerMessage` 처리 다음에:

```ts
    if (isCancelMessage(msg)) {
      controllers.get(msg.id)?.abort();
      return;
    }
```

요청 처리 부분을:

```ts
    if (isRequestMessage(msg)) {
      inFlight++;
      const ac = new AbortController();
      controllers.set(msg.id, ac);
      handlers
        .handle(msg.method, msg.params, progressCtx(msg.id, send, ac.signal))
        .then(
          (result) => send({ type: 'response', id: msg.id, result }),
          (err: unknown) => send({ type: 'response', id: msg.id, error: err instanceof Error ? err.message : String(err) }),
        )
        .finally(() => {
          controllers.delete(msg.id);
          inFlight--;
          maybeExit();
        });
      return;
    }
```

`rl.on('close', …)` 를:

```ts
  rl.on('close', () => {
    closing = true;
    for (const ac of controllers.values()) ac.abort(); // 화면이 닫히면 실행 중인 CLI 도 끝낸다
    maybeExit();
  });
```

- [ ] **Step 4: 통과 확인** — Run: `npx vitest run test/unit/rpc-server.test.ts && npm run typecheck` — Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rpc/server.ts src/rpc/handlers.ts test/unit/rpc-server.test.ts
git commit -m "feat(rpc): stream events to the GUI and accept cancel messages"
```

---

### Task 11: RPC — `ws*` 메서드와 계정 작업 상호 배제

**Files:** Modify `src/rpc/handlers.ts`, `test/unit/rpc-handlers.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `test/unit/rpc-handlers.test.ts` 맨 위 import 에 `import type { RunRequest, RunResult } from '../../src/main/infra/agent-runner.js';` 를 더하고, 파일 끝에 추가:

```ts
describe('workspace methods', () => {
  let ws: Handlers;
  let folder: string;
  let gate: Promise<void> | undefined;
  const runs: RunRequest[] = [];

  beforeEach(async () => {
    folder = path.join(p.home, 'proj');
    await fs.mkdir(folder, { recursive: true });
    gate = undefined;
    runs.length = 0;
    ws = createHandlers({
      paths: p,
      db,
      secrets: fakeSecretStore(),
      procs,
      makeProviders: (withAppProfile) => ({
        codex: codexAuthProvider(p, { withAppProfile }),
        claude: claudeAuthProvider(p, { withAppProfile }),
      }),
      prompt,
      locateAgent: () => ({ path: 'C:\\bin\\claude.exe', viaCmd: false }),
      agentRunner: {
        async run(req: RunRequest): Promise<RunResult> {
          runs.push(req);
          if (gate) await gate;
          req.onLine({ type: 'system', subtype: 'init', session_id: 's1' });
          req.onLine({ type: 'assistant', message: { content: [{ type: 'text', text: '네' }] } });
          req.onLine({ type: 'result', subtype: 'success', is_error: false });
          return { exitCode: 0, cancelled: false, stderrTail: '' };
        },
      },
    });
  });

  it('reports installed agents with their modes', async () => {
    expect(await ws.handle('wsAgents', {})).toEqual({
      agents: [
        {
          agent: 'claude', name: 'Claude', available: true, path: 'C:\\bin\\claude.exe',
          modes: ['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'], defaultMode: 'acceptEdits',
        },
      ],
    });
  });

  it('registers a folder, starts a conversation and streams a turn as events', async () => {
    const w = (await ws.handle('wsAdd', { folder })) as { id: number; folder: string };
    expect(((await ws.handle('wsList', {})) as { workspaces: unknown[] }).workspaces).toHaveLength(1);
    const c = (await ws.handle('wsNewConversation', { workspaceId: w.id, agent: 'claude', title: '안녕' })) as { id: number };
    const emitted: unknown[] = [];
    const ac = new AbortController();
    const r = await ws.handle(
      'wsSend',
      { conversationId: c.id, agent: 'claude', mode: 'acceptEdits', text: '안녕' },
      { progress: () => {}, emit: (d) => emitted.push(d), signal: ac.signal },
    );
    expect(r).toEqual({ status: 'ok' });
    expect(emitted).toEqual([
      { conversationId: c.id, event: { type: 'session', sessionId: 's1' } },
      { conversationId: c.id, event: { type: 'text', text: '네' } },
      { conversationId: c.id, event: { type: 'done', ok: true } },
    ]);
    expect(runs[0]!.signal).toBe(ac.signal);
    expect(runs[0]!.cwd).toBe(w.folder);
    const conv = (await ws.handle('wsConversation', { id: c.id })) as { conversation: { title: string }; messages: { role: string }[] };
    expect(conv.conversation.title).toBe('안녕');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(((await ws.handle('wsConversations', { workspaceId: w.id })) as { conversations: unknown[] }).conversations).toHaveLength(1);
    expect(await ws.handle('wsDeleteConversation', { id: c.id })).toEqual({ deleted: true });
    expect(await ws.handle('wsRemove', { id: w.id })).toEqual({ removed: true });
    expect(((await ws.handle('wsList', {})) as { workspaces: unknown[] }).workspaces).toEqual([]);
  });

  it('refuses account switching, restoring and importing while a turn is running', async () => {
    const w = (await ws.handle('wsAdd', { folder })) as { id: number };
    const c = (await ws.handle('wsNewConversation', { workspaceId: w.id, agent: 'claude', title: 'x' })) as { id: number };
    let open!: () => void;
    gate = new Promise((r) => {
      open = r;
    });
    const sending = ws.handle('wsSend', { conversationId: c.id, agent: 'claude', mode: 'acceptEdits', text: 'x' });
    for (const [method, params] of [
      ['switch', { tool: 'claude', label: 'a' }],
      ['restore', { tool: 'claude', file: 'x.bin' }],
      ['addAccount', { tool: 'claude' }],
      ['importSessions', { srcTool: 'codex', keys: ['k'], policy: 'skip', target: { tool: 'codex' } }],
    ] as const) {
      await expect(ws.handle(method, params)).rejects.toThrow('작업공간에서 대화가 실행 중입니다');
    }
    open();
    await sending;
  });

  it('validates parameters before running anything', async () => {
    await expect(ws.handle('wsSend', { conversationId: 1, agent: 'claude', mode: 'acceptEdits', text: '  ' })).rejects.toThrow('text');
    await expect(ws.handle('wsSend', { conversationId: 1, agent: 'gpt', mode: 'acceptEdits', text: 'x' })).rejects.toThrow('agent');
    await expect(ws.handle('wsSend', { conversationId: 1, agent: 'claude', mode: 'yolo', text: 'x' })).rejects.toThrow('mode');
    await expect(ws.handle('wsSend', { conversationId: 1, agent: 'claude', mode: 'plan', model: 'a b', text: 'x' })).rejects.toThrow('model');
    await expect(ws.handle('wsSend', { conversationId: 0, agent: 'claude', mode: 'plan', text: 'x' })).rejects.toThrow('conversationId');
    await expect(ws.handle('wsAdd', { folder: 'relative\\dir' })).rejects.toThrow('절대 경로');
    await expect(ws.handle('wsConversation', { id: 42 })).rejects.toThrow('대화를 찾을 수 없습니다');
    expect(runs).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `npx vitest run test/unit/rpc-handlers.test.ts` — Expected: FAIL (`알 수 없는 메서드: wsAgents`)

- [ ] **Step 3: 구현** — `src/rpc/handlers.ts`:

import 추가:

```ts
import { AGENT_IDS, AGENT_NAMES, parseAgentId, type AgentId } from '../main/core/agent-events.js';
import { AgentRunner } from '../main/infra/agent-runner.js';
import { findOnPath, type Executable } from '../main/infra/exe-locator.js';
import { CLAUDE_DEFAULT_MODE, CLAUDE_MODES, parseClaudeMode } from '../main/providers/claude/agent.js';
import { WorkspaceService } from '../main/services/workspace-service.js';
```

`TOOLS` 아래에:

```ts
// 작업공간 도구별 실행 파일 이름(PATH 검색). Codex 는 Plan 5 에서 앱 번들 경로를 먼저 찾는다.
const AGENT_COMMANDS: Record<AgentId, string> = { claude: 'claude' };
```

`RpcDeps` 에 추가:

```ts
  agentRunner?: Pick<AgentRunner, 'run'>; // 테스트 주입용 — 기본은 실제 자식 프로세스 실행기
  locateAgent?: (agent: AgentId) => Executable | undefined; // 테스트 주입용 — 기본은 PATH 검색
```

`parseFlag` 아래에 파서 추가:

```ts
function parseId(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`${field} 는 양의 정수여야 합니다`);
  return v;
}

function parseText(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > 100_000) throw new Error(`${field} 는 1~100000자 문자열이어야 합니다`);
  return v;
}

// 모델 이름은 CLI 인자로 그대로 넘어가므로 안전한 문자만(agent-runner 의 commandFor 와 같은 규칙).
function parseModel(v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !/^[\w.:\-[\]]{1,80}$/.test(v)) throw new Error('model 형식이 올바르지 않습니다');
  return v;
}
```

`createHandlers` 안, `library` 다음에:

```ts
  const locateAgent = deps.locateAgent ?? ((agent: AgentId) => findOnPath(AGENT_COMMANDS[agent], process.env));
  const workspace = new WorkspaceService({ db: deps.db, runner: deps.agentRunner ?? new AgentRunner(), locate: locateAgent });

  // 작업공간 턴이 도는 동안에는 인증 파일·앱을 바꾸는 작업을 받지 않는다(작업공간 설계 W10).
  function ensureAgentIdle(): void {
    if (workspace.isRunning()) throw new Error('작업공간에서 대화가 실행 중입니다 — 끝나거나 멈춘 뒤 다시 시도하세요');
  }
```

`importHistory` 다음에:

```ts
  function wsAgents() {
    return {
      agents: AGENT_IDS.map((agent) => {
        const exe = locateAgent(agent);
        return {
          agent,
          name: AGENT_NAMES[agent],
          available: exe !== undefined,
          ...(exe ? { path: displayPath(exe.path, deps.paths.home) } : {}),
          modes: [...CLAUDE_MODES],
          defaultMode: CLAUDE_DEFAULT_MODE,
        };
      }),
    };
  }

  function wsConversation(paramsRaw: unknown) {
    const id = parseId(asRecord(paramsRaw).id, 'id');
    const conversation = deps.db.findConversation(id);
    if (!conversation) throw new Error('대화를 찾을 수 없습니다');
    return { conversation, messages: workspace.messages(id) };
  }

  async function wsSend(paramsRaw: unknown, ctx?: HandlerContext) {
    if (mutating) throw new Error('계정 전환·가져오기가 진행 중입니다 — 끝난 뒤 보내세요');
    const params = asRecord(paramsRaw);
    const conversationId = parseId(params.conversationId, 'conversationId');
    const agent = parseAgentId(params.agent);
    const mode = parseClaudeMode(params.mode);
    const model = parseModel(params.model);
    const text = parseText(params.text, 'text');
    return workspace.send(
      { conversationId, agent, mode, ...(model ? { model } : {}), text },
      (event) => ctx?.emit?.({ conversationId, event }),
      ctx?.signal,
    );
  }
```

`handle` 의 `switch` 에서 네 쓰기 작업 앞에 확인을 넣고 새 메서드를 더한다:

```ts
        case 'switch':
          ensureAgentIdle();
          return withLock('switch', () => doSwitch(params, ctx));
        case 'restore':
          ensureAgentIdle();
          return withLock('restore', () => restore(params, ctx));
        case 'addAccount':
          ensureAgentIdle();
          return withLock('addAccount', () => addAccount(params, ctx));
```

```ts
        case 'importSessions':
          ensureAgentIdle();
          return withLock('importSessions', () => importSessions(params, ctx));
```

`appIcons` 다음, `default` 앞에:

```ts
        case 'wsAgents':
          return wsAgents();
        case 'wsList':
          return { workspaces: deps.db.listWorkspaces() };
        case 'wsAdd': {
          const p = asRecord(params);
          return workspace.addWorkspace(p.folder, p.name);
        }
        case 'wsRemove':
          workspace.removeWorkspace(parseId(asRecord(params).id, 'id'));
          return { removed: true };
        case 'wsConversations':
          return { conversations: deps.db.listConversations(parseId(asRecord(params).workspaceId, 'workspaceId')) };
        case 'wsNewConversation': {
          const p = asRecord(params);
          return workspace.newConversation(parseId(p.workspaceId, 'workspaceId'), parseAgentId(p.agent), parseText(p.title, 'title'));
        }
        case 'wsConversation':
          return wsConversation(params);
        case 'wsDeleteConversation':
          workspace.deleteConversation(parseId(asRecord(params).id, 'id'));
          return { deleted: true };
        case 'wsSend':
          return wsSend(params, ctx);
```

`server.ts` 는 바꿀 것이 없다 — `createHandlers` 가 기본 실행기와 PATH 검색을 쓴다.

- [ ] **Step 4: 통과 확인** — Run: `npm test && npm run typecheck` — Expected: 전체 PASS

- [ ] **Step 5: Commit**

```bash
git add src/rpc/handlers.ts test/unit/rpc-handlers.test.ts
git commit -m "feat(rpc): workspace methods and refusing account changes during a turn"
```

---

### Task 12: 화면 — 작업공간

자동 테스트 없음(기존 GUI 와 같음). Task 13 에서 실제 앱으로 확인한다.

**Files:** Modify `scripts/build-icons.mjs`, `gui/icons.js`(생성), `gui/bridge.js`, `gui/index.html`, `gui/renderer.js`, `gui/style.css` · Create `gui/workspace.js`

- [ ] **Step 1: 아이콘** — `scripts/build-icons.mjs` 의 `ICONS` 에 (알파벳 자리에) 추가하고 다시 만든다:

```js
  'folder-plus': 'duotone/folder-plus-duotone',
  plus: 'bold/plus-bold',
  stop: 'fill/stop-fill',
```

Run: `npm run icons` — Expected: `gui/icons.js` 에 세 이름이 생긴다.

- [ ] **Step 2: `gui/bridge.js`** — 이벤트·취소·폴더 선택:

`const progressListeners = new Set();` 아래에 `const eventListeners = new Set();`

`onLine` 의 `progress` 분기 다음에:

```js
    } else if (msg.type === 'event') {
      // 오래 걸리는 요청(wsSend)의 중간 이벤트 — 렌더러가 id 로 자기 요청인지 거른다.
      for (const cb of eventListeners) cb({ id: msg.id, data: msg.data });
```

`window.bridge` 에 추가:

```js
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    cancel(id) {
      ready.then(() => send({ type: 'cancel', id })).catch(() => {});
    },
    async pickFolder() {
      const dir = await open({ title: '작업 폴더 선택', directory: true, multiple: false });
      return typeof dir === 'string' ? dir : null;
    },
```

- [ ] **Step 3: `gui/index.html`**

`.topbar-actions` 안, `#activity-btn` 앞에:

```html
    <button class="top-btn view-btn" id="view-transfer" type="button" aria-pressed="true" title="세션 가져오기"><span data-icon="arrow-left-right"></span>가져오기</button>
    <button class="top-btn view-btn" id="view-studio" type="button" aria-pressed="false" title="작업공간 — 한 폴더에서 도구를 골라 대화"><span data-icon="message-square-text"></span>작업공간</button>
```

`</main>`(가져오기 화면) 다음에:

```html
<main class="studio hidden" id="studio" aria-label="작업공간">
  <nav class="st-side" aria-label="작업공간 목록">
    <div class="st-side-head">
      <span class="ph-label">작업공간</span>
      <button class="icon-btn" id="st-add" type="button" title="폴더 추가" aria-label="폴더 추가"><span data-icon="folder-plus"></span></button>
    </div>
    <div class="st-list" id="st-list"></div>
  </nav>
  <section class="st-main" aria-label="대화">
    <div class="st-head" id="st-head"></div>
    <div class="st-thread" id="st-thread"></div>
    <div class="st-composer">
      <textarea id="st-input" placeholder="무엇을 할까요? (Ctrl+Enter 로 보내기)" aria-label="메시지"></textarea>
      <div class="st-bar">
        <button class="select" id="st-agent" type="button" aria-haspopup="menu" aria-expanded="false" title="도구"></button>
        <button class="select" id="st-mode" type="button" aria-haspopup="menu" aria-expanded="false" title="권한 모드"></button>
        <span class="st-hint" id="st-hint"></span>
        <button class="btn primary" id="st-send" type="button"></button>
      </div>
    </div>
  </section>
</main>
```

`<script src="renderer.js"></script>` 다음에 `<script src="workspace.js"></script>`.

- [ ] **Step 4: `gui/renderer.js`** — 화면 전환과 단축키 범위:

상태 영역(`let drag = null;` 아래)에:

```js
let currentView = 'transfer'; // 'transfer'(가져오기) | 'studio'(작업공간, workspace.js)
```

전역 `keydown` 처리에서 대화상자(`overlay`) 확인 블록 바로 다음에:

```js
    if (currentView !== 'transfer') {
      // 작업공간 화면의 키는 workspace.js 가 다룬다 — 여기서는 열린 메뉴만 닫는다
      if (e.key === 'Escape' && pop) {
        e.preventDefault();
        closePopover({ refocus: true });
      }
      return;
    }
```

창 포커스 새로고침 조건을 `if (currentView !== 'transfer' || busy || drag || !overlay.classList.contains('hidden') || Date.now() - lastFocusRefresh < 3000) return;` 로 바꾼다.

`setInterval(renderStatusTime, 30000);` 앞에:

```js
// --- 화면 전환: 가져오기 | 작업공간 ----------------------------------------

function showView(v) {
  currentView = v;
  closePopover();
  $('workspace').classList.toggle('hidden', v !== 'transfer');
  $('studio').classList.toggle('hidden', v !== 'studio');
  $('view-transfer').setAttribute('aria-pressed', String(v === 'transfer'));
  $('view-studio').setAttribute('aria-pressed', String(v === 'studio'));
  if (v === 'studio') stOpen(); // workspace.js
}

$('view-transfer').addEventListener('click', () => showView('transfer'));
$('view-studio').addEventListener('click', () => showView('studio'));
```

- [ ] **Step 5: `gui/workspace.js`** (새 파일):

```js
'use strict';

// 작업공간 화면 — 설계: docs/superpowers/specs/2026-10-06-workspace-design.md
//  왼쪽   등록한 작업 폴더와 그 안의 대화
//  오른쪽 대화(실시간 출력) + 입력창(도구 · 권한 모드 · 보내기/멈추기)
// renderer.js 의 도우미(h, icon, tile, iconBtn, markdown, toolRow, toolGroup, userBubble, emptyEl, loadingEl, relTime,
// openPopover, closePopover, menuItem, confirmModal, report, setStatus)를 그대로 쓴다 — renderer.js 다음에 읽는다.

// Claude --permission-mode 값의 화면 이름과 설명. 고를 수 있는 값 목록은 백엔드(wsAgents)가 준다.
const ST_MODE_LABELS = {
  plan: ['계획만', '파일을 고치지 않고 읽기·계획만 합니다'],
  default: ['기본', '미리 허용한 도구만 씁니다 — 나머지는 거부'],
  acceptEdits: ['파일 수정 허용', '파일 편집은 자동으로 허용합니다'],
  auto: ['자동 판단', '안전해 보이는 작업은 자동으로 허용합니다'],
  dontAsk: ['묻지 않음', '허용 목록 밖의 도구는 묻지 않고 거부합니다'],
  bypassPermissions: ['전부 허용', '모든 도구·명령을 확인 없이 실행합니다 (위험)'],
};

const studio = {
  loaded: false,
  agents: [], // wsAgents: [{ agent, name, available, path?, modes, defaultMode }]
  workspaces: [],
  workspaceId: null,
  conversations: [],
  conversationId: null,
  agent: 'claude',
  modes: {}, // 도구 -> 고른 권한 모드
  running: null, // 실행 중인 wsSend 요청 id
  token: 0, // 대화 불러오기 경쟁 방지
};

const stAgentInfo = (agent) => studio.agents.find((a) => a.agent === agent);
const stMode = (agent) => studio.modes[agent] ?? stAgentInfo(agent)?.defaultMode;

// 실행 중에는 다른 대화로 옮기지 않는다 — 실시간 출력이 엉뚱한 대화에 그려지지 않게.
function stBlocked() {
  if (studio.running === null) return false;
  setStatus('info', '실행 중에는 다른 대화로 옮길 수 없습니다 — 끝나거나 멈춘 뒤 옮기세요');
  return true;
}

function stUsageText(u) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `입력 ${k(u.inputTokens)} · 출력 ${k(u.outputTokens)} · 캐시 읽기 ${k(u.cacheReadTokens)} · 캐시 쓰기 ${k(u.cacheWriteTokens)}`;
}

// --- 왼쪽: 작업공간 · 대화 ------------------------------------------------

function stRenderSide() {
  const list = $('st-list');
  if (!studio.workspaces.length) {
    list.replaceChildren(emptyEl('folder', '폴더를 추가해 작업공간을 만드세요'));
    return;
  }
  list.replaceChildren(
    ...studio.workspaces.map((w) => {
      const open = w.id === studio.workspaceId;
      const head = h(
        'div',
        { class: `st-ws${open ? ' open' : ''}`, title: w.folder, onclick: () => stSelectWorkspace(w.id) },
        icon('folder'),
        h('span', { class: 'st-ws-name', text: w.name }),
        iconBtn('trash-2', '작업공간 제거', () => stRemoveWorkspace(w)),
      );
      if (!open) return head;
      return h(
        'div',
        { class: 'st-ws-group' },
        head,
        h('button', { class: 'st-conv new', type: 'button', onclick: () => stNewConversation() }, icon('plus'), h('span', { text: '새 대화' })),
        studio.conversations.map((c) =>
          h(
            'div',
            {
              class: `st-conv${c.id === studio.conversationId ? ' sel' : ''}`,
              role: 'button',
              tabindex: '0',
              onclick: () => stOpenConversation(c.id),
              onkeydown: (e) => {
                if (e.key === 'Enter') stOpenConversation(c.id);
              },
            },
            tile(c.agent, 'sm'),
            h('span', { class: 'st-conv-title', text: c.title }),
            h('small', { text: relTime(Date.parse(c.updatedAt)) }),
            iconBtn('trash-2', '대화 삭제', () => stDeleteConversation(c)),
          ),
        ),
      );
    }),
  );
}

async function stLoadWorkspaces() {
  try {
    studio.workspaces = (await window.bridge.request('wsList')).workspaces;
  } catch (e) {
    report('error', '작업공간 목록을 읽지 못했습니다', e.message);
    return;
  }
  if (!studio.workspaces.some((w) => w.id === studio.workspaceId)) {
    studio.workspaceId = studio.workspaces[0]?.id ?? null;
    studio.conversationId = null;
    stRenderThread([]);
  }
  await stLoadConversations();
}

async function stLoadConversations() {
  studio.conversations = [];
  if (studio.workspaceId !== null) {
    try {
      studio.conversations = (await window.bridge.request('wsConversations', { workspaceId: studio.workspaceId })).conversations;
    } catch (e) {
      report('error', '대화 목록을 읽지 못했습니다', e.message);
    }
  }
  stRenderSide();
  stRenderHead();
  stRenderComposer();
}

async function stAddWorkspace() {
  if (stBlocked()) return;
  const folder = await window.bridge.pickFolder();
  if (!folder) return;
  try {
    const w = await window.bridge.request('wsAdd', { folder });
    studio.workspaceId = w.id;
    studio.conversationId = null;
    report('success', `작업공간 '${w.name}' 을 추가했습니다`, w.folder);
    stRenderThread([]);
    await stLoadWorkspaces();
  } catch (e) {
    report('error', '작업공간을 추가하지 못했습니다', e.message);
  }
}

async function stRemoveWorkspace(w) {
  const ok = await confirmModal('작업공간 제거', `'${w.name}' 과 그 안의 대화 기록을 이 앱에서 지웁니다. 폴더·파일과 각 도구의 세션은 그대로 남습니다.`, { confirmText: '제거', danger: true });
  if (!ok) return;
  try {
    await window.bridge.request('wsRemove', { id: w.id });
    await stLoadWorkspaces();
  } catch (e) {
    report('error', '작업공간을 제거하지 못했습니다', e.message);
  }
}

async function stSelectWorkspace(id) {
  if (studio.workspaceId === id || stBlocked()) return;
  studio.workspaceId = id;
  studio.conversationId = null;
  stRenderThread([]);
  await stLoadConversations();
}

function stNewConversation() {
  if (stBlocked()) return;
  studio.conversationId = null;
  stRenderSide();
  stRenderHead();
  stRenderThread([]);
  $('st-input').focus();
}

async function stDeleteConversation(c) {
  const ok = await confirmModal('대화 삭제', `'${c.title}' 대화 기록을 이 앱에서 지웁니다. 각 도구의 세션 파일은 그대로 남습니다.`, { confirmText: '삭제', danger: true });
  if (!ok) return;
  try {
    await window.bridge.request('wsDeleteConversation', { id: c.id });
    if (studio.conversationId === c.id) {
      studio.conversationId = null;
      stRenderThread([]);
    }
    await stLoadConversations();
  } catch (e) {
    report('error', '대화를 삭제하지 못했습니다', e.message);
  }
}

async function stOpenConversation(id) {
  if (studio.conversationId !== id && stBlocked()) return;
  studio.conversationId = id;
  const token = ++studio.token;
  stRenderSide();
  stRenderHead();
  $('st-thread').replaceChildren(loadingEl());
  try {
    const r = await window.bridge.request('wsConversation', { id });
    if (token !== studio.token) return;
    if (studio.running === null && stAgentInfo(r.conversation.agent)?.available) studio.agent = r.conversation.agent; // 마지막으로 쓴 도구로
    stRenderThread(r.messages);
    stRenderComposer();
  } catch (e) {
    if (token === studio.token) $('st-thread').replaceChildren(emptyEl('circle-alert', e.message));
  }
}

// --- 대화 -----------------------------------------------------------------

function stRenderHead() {
  const w = studio.workspaces.find((x) => x.id === studio.workspaceId);
  const c = studio.conversations.find((x) => x.id === studio.conversationId);
  $('st-head').replaceChildren(
    h('div', { class: 'st-head-text' }, h('b', { text: w ? c?.title ?? '새 대화' : '작업공간' }), w ? h('small', { text: w.folder }) : null),
  );
}

function stMessageEls(m) {
  if (m.role === 'user') return [userBubble(m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n'))];
  const els = [];
  let tools = [];
  const flush = () => {
    if (tools.length) els.push(toolGroup(tools));
    tools = [];
  };
  for (const b of m.blocks) {
    if (b.kind === 'tool') tools.push(b);
    else if (b.kind === 'text') {
      flush();
      els.push(h('div', { class: 'msg-a' }, tile(m.agent, 'sm'), markdown(b.text)));
    }
  }
  flush();
  if (m.status === 'cancelled') els.push(h('div', { class: 'st-note', text: '멈췄습니다' }));
  if (m.status === 'error') els.push(h('div', { class: 'st-note err', text: `오류: ${m.error ?? '알 수 없는 오류'}` }));
  if (m.usage) els.push(h('div', { class: 'st-usage', text: stUsageText(m.usage) }));
  return els;
}

function stRenderThread(messages) {
  const t = $('st-thread');
  if (!messages.length) {
    t.replaceChildren(emptyEl('message-square-text', studio.workspaceId === null ? '왼쪽에서 폴더를 추가하세요' : '메시지를 보내 대화를 시작하세요'));
    return;
  }
  t.replaceChildren(h('div', { class: 'thread' }, messages.flatMap(stMessageEls)));
  t.scrollTop = t.scrollHeight;
}

// 실행 중인 턴: 글 조각은 모아 80ms 마다 마크다운으로 다시 그리고, 도구 호출은 한 줄씩 붙였다가 결과가 오면 바꾼다.
// 끝나면 stSend 가 저장된 대화를 다시 읽어 그린다(도구 호출 묶음 등 기록 화면과 같은 모양으로).
function stLiveTurn(thread, scroller, agent) {
  let msg = null;
  let mdEl = null;
  let buf = '';
  let timer = null;
  const rows = new Map(); // 도구 호출 id -> { el, name, input }
  const stick = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };
  const paint = () => {
    timer = null;
    if (!msg) return;
    const next = markdown(buf);
    mdEl.replaceWith(next);
    mdEl = next;
    stick();
  };
  const ensureMsg = () => {
    if (msg) return;
    mdEl = markdown('');
    msg = h('div', { class: 'msg-a live' }, tile(agent, 'sm'), mdEl);
    thread.append(msg);
  };
  const endText = () => {
    if (timer) {
      clearTimeout(timer);
      paint();
    }
    msg = null;
    mdEl = null;
    buf = '';
  };
  return {
    onEvent(e) {
      if (e.type === 'textDelta') {
        ensureMsg();
        buf += e.text;
        timer ??= setTimeout(paint, 80);
      } else if (e.type === 'text') {
        ensureMsg();
        buf = e.text;
        if (timer) clearTimeout(timer);
        paint();
        endText();
      } else if (e.type === 'toolStart') {
        endText();
        const el = toolRow({ name: e.name, input: e.input });
        el.classList.add('running');
        rows.set(e.id, { el, name: e.name, input: e.input });
        thread.append(el);
        stick();
      } else if (e.type === 'toolEnd') {
        const r = rows.get(e.id);
        if (!r) return;
        const el = toolRow({ name: r.name, input: r.input, output: e.output, isError: e.isError });
        r.el.replaceWith(el);
        r.el = el;
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// --- 입력창 ---------------------------------------------------------------

function stRenderComposer() {
  const info = stAgentInfo(studio.agent);
  const mode = stMode(studio.agent);
  const running = studio.running !== null;
  const ready = studio.workspaceId !== null && Boolean(info?.available);
  $('st-agent').replaceChildren(tile(studio.agent, 'sm'), h('span', { class: 'sel-text', text: info ? info.name : studio.agent }), icon('chevron-down'));
  $('st-agent').disabled = running;
  $('st-mode').replaceChildren(h('span', { class: 'sel-text', text: ST_MODE_LABELS[mode]?.[0] ?? mode ?? '' }), icon('chevron-down'));
  $('st-mode').disabled = running || !info;
  $('st-mode').classList.toggle('danger', mode === 'bypassPermissions');
  $('st-input').disabled = !ready || running;
  $('st-send').className = running ? 'btn danger' : 'btn primary';
  $('st-send').replaceChildren(icon(running ? 'stop' : 'arrow-right'), h('span', { text: running ? '멈추기' : '보내기' }));
  $('st-send').disabled = !running && !ready;
  $('st-hint').textContent = !info?.available
    ? `${info?.name ?? studio.agent} CLI 가 설치돼 있지 않습니다`
    : studio.workspaceId === null
      ? '먼저 작업공간을 고르세요'
      : 'Ctrl+Enter 로 보내기';
}

function stAgentMenu() {
  openPopover(
    $('st-agent'),
    studio.agents.map((a) =>
      menuItem(
        a.agent === studio.agent ? 'cur' : '',
        [
          h('span', { class: 'mi-check' }, a.agent === studio.agent ? icon('check') : null),
          tile(a.agent, 'sm'),
          h('span', { class: 'mi-text' }, h('b', { text: a.name }), h('small', { text: a.available ? a.path ?? '' : '설치 안 됨' })),
        ],
        () => {
          studio.agent = a.agent;
          closePopover({ refocus: true });
          stRenderComposer();
        },
        { disabled: !a.available },
      ),
    ),
    { minWidth: 260 },
  );
}

function stModeMenu() {
  const info = stAgentInfo(studio.agent);
  if (!info) return;
  const cur = stMode(studio.agent);
  openPopover(
    $('st-mode'),
    info.modes.map((m) =>
      menuItem(
        m === cur ? 'cur' : '',
        [
          h('span', { class: 'mi-check' }, m === cur ? icon('check') : null),
          h('span', { class: 'mi-text' }, h('b', { text: ST_MODE_LABELS[m]?.[0] ?? m }), h('small', { text: ST_MODE_LABELS[m]?.[1] ?? m })),
        ],
        () => {
          studio.modes[studio.agent] = m;
          closePopover({ refocus: true });
          stRenderComposer();
        },
      ),
    ),
    { minWidth: 300 },
  );
}

async function stSend() {
  if (studio.running !== null) {
    window.bridge.cancel(studio.running);
    setStatus('progress', '멈추는 중');
    return;
  }
  const input = $('st-input');
  const text = input.value.trim();
  const info = stAgentInfo(studio.agent);
  if (!text || studio.workspaceId === null || !info?.available) return;
  const agent = studio.agent;
  const mode = stMode(agent);
  if (studio.conversationId === null) {
    try {
      const c = await window.bridge.request('wsNewConversation', { workspaceId: studio.workspaceId, agent, title: text });
      studio.conversationId = c.id;
      await stLoadConversations();
    } catch (e) {
      report('error', '대화를 만들지 못했습니다', e.message);
      return;
    }
  }
  const conversationId = studio.conversationId;
  const scroller = $('st-thread');
  let thread = scroller.querySelector('.thread');
  if (!thread) {
    thread = h('div', { class: 'thread' });
    scroller.replaceChildren(thread);
  }
  thread.append(userBubble(text));
  input.value = '';
  const live = stLiveTurn(thread, scroller, agent);
  const requestId = window.bridge.nextRequestId();
  const off = window.bridge.onEvent(({ id, data }) => {
    if (id === requestId) live.onEvent(data.event);
  });
  studio.running = requestId;
  stRenderComposer();
  setStatus('progress', `${info.name} 실행 중`);
  try {
    const r = await window.bridge.request('wsSend', { conversationId, agent, mode, text }, requestId);
    if (r.status === 'ok') setStatus('success', `${info.name} 답변을 받았습니다`);
    else if (r.status === 'cancelled') setStatus('info', '멈췄습니다');
    else report('error', `${info.name} 실행이 실패했습니다`, r.error);
  } catch (e) {
    report('error', '보내지 못했습니다', e.message);
    input.value = text; // 보내지 못한 글은 입력창으로 되돌린다
  } finally {
    off();
    live.stop();
    studio.running = null;
    stRenderComposer();
    await stLoadConversations();
    if (studio.conversationId === conversationId) await stOpenConversation(conversationId);
  }
}

// --- 화면 열기 (renderer.js 의 showView 가 부른다) -------------------------

async function stOpen() {
  if (!studio.loaded) {
    studio.loaded = true;
    try {
      studio.agents = (await window.bridge.request('wsAgents')).agents;
    } catch (e) {
      report('error', '도구 목록을 읽지 못했습니다', e.message);
    }
    studio.agent = studio.agents.find((a) => a.available)?.agent ?? studio.agents[0]?.agent ?? 'claude';
    stRenderThread([]);
  }
  await stLoadWorkspaces();
}

$('st-add').addEventListener('click', stAddWorkspace);
$('st-agent').addEventListener('click', stAgentMenu);
$('st-mode').addEventListener('click', stModeMenu);
$('st-send').addEventListener('click', stSend);
$('st-input').addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    stSend();
  }
});
```

- [ ] **Step 6: `gui/style.css`** — 파일 끝에 추가(색은 기존 토큰만 쓴다 — 어두운 테마도 따라간다):

```css
/* --- 상단 막대: 화면 전환 --- */

.top-btn[aria-pressed="true"] {
  background: var(--top-3);
  color: #ffffff;
}

/* --- 작업공간 (gui/workspace.js) --- */

.studio {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 14px;
  padding: 14px;
}

.st-side,
.st-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--pane);
}

.st-side-head,
.st-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.st-side-head .ph-label {
  flex: 1;
}

.st-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.st-ws,
.st-conv {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--t1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.st-ws:hover,
.st-conv:hover {
  background: var(--hover);
}

.st-ws.open {
  font-weight: 600;
}

.st-ws-name,
.st-conv-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-conv {
  padding-left: 24px;
  font-size: 13px;
}

.st-conv small {
  color: var(--t3);
  font-size: 11px;
  white-space: nowrap;
}

.st-conv.sel {
  background: var(--sel);
}

.st-conv.new {
  color: var(--accent-text);
}

.st-ws .icon-btn,
.st-conv .icon-btn {
  visibility: hidden;
}

.st-ws:hover .icon-btn,
.st-conv:hover .icon-btn {
  visibility: visible;
}

.st-head-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.st-head-text small {
  overflow: hidden;
  color: var(--t3);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.st-thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px;
  user-select: text;
}

.st-note {
  align-self: flex-start;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--subtle);
  color: var(--t2);
  font-size: 13px;
}

.st-note.err {
  background: var(--red-t);
  color: var(--red-text);
}

.st-usage {
  align-self: flex-start;
  color: var(--t3);
  font-size: 11px;
}

.toolrow.running summary::after {
  content: "실행 중…";
  margin-left: auto;
  color: var(--t3);
  font-size: 11px;
}

.st-composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}

.st-composer textarea {
  width: 100%;
  min-height: 64px;
  max-height: 240px;
  resize: vertical;
  padding: 8px 10px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--pane);
  color: var(--t1);
  font: inherit;
  line-height: 1.6;
  user-select: text;
}

.st-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.st-bar .select.danger {
  color: var(--red-text);
}

.st-hint {
  flex: 1;
  color: var(--t3);
  font-size: 12px;
}
```

- [ ] **Step 7: 기존 동작 확인** — Run: `npm test && npm run typecheck` — Expected: 전체 PASS(화면 변경은 백엔드 테스트에 영향 없음)

- [ ] **Step 8: Commit**

```bash
git add scripts/build-icons.mjs gui/icons.js gui/bridge.js gui/index.html gui/renderer.js gui/style.css gui/workspace.js
git commit -m "feat(gui): workspace screen for chatting with Claude in a registered folder"
```

---

### Task 13: 실제 CLI·실제 앱 확인 + 문서

**Files:** Create `test/unit/claude-agent.live.test.ts` · Modify `README.md`, `docs/architecture.md`, `docs/verification/phase0-workspace.md`

- [ ] **Step 1: 실제 CLI 테스트(W-V6 포함)** — `test/unit/claude-agent.live.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentRunner } from '../../src/main/infra/agent-runner.js';
import { AppDb } from '../../src/main/infra/app-db.js';
import { findOnPath } from '../../src/main/infra/exe-locator.js';
import { WorkspaceService } from '../../src/main/services/workspace-service.js';
import { pendingTmpRoots } from '../helpers/tmp-paths.js';

// 실제 claude CLI 를 실행한다 — 사용 한도를 조금 쓰고 임시 폴더의 세션이 Claude 목록에 남으므로 AAB_LIVE=1 일 때만 돈다.
describe.skipIf(!process.env.AAB_LIVE)('Claude CLI (live)', () => {
  async function setup() {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-live-'));
    pendingTmpRoots.push(folder);
    const svc = new WorkspaceService({ db: new AppDb(':memory:'), runner: new AgentRunner(), locate: () => findOnPath('claude', process.env) });
    const w = await svc.addWorkspace(folder);
    return { svc, c: svc.newConversation(w.id, 'claude', 'live') };
  }

  it('runs two turns in one session and keeps Korean text intact', async () => {
    const { svc, c } = await setup();
    const r1 = await svc.send({ conversationId: c.id, agent: 'claude', mode: 'default', text: '"사과" 라는 낱말 하나만 답하세요.' }, () => {});
    expect(r1.status).toBe('ok');
    expect(JSON.stringify(svc.messages(c.id)[1]!.blocks)).toContain('사과');
    const r2 = await svc.send({ conversationId: c.id, agent: 'claude', mode: 'default', text: '방금 답한 낱말을 한 번 더 답하세요.' }, () => {});
    expect(r2.status).toBe('ok');
    expect(JSON.stringify(svc.messages(c.id)[3]!.blocks)).toContain('사과');
  }, 180_000);

  it('stops a running command and resumes the same session afterwards', async () => {
    const { svc, c } = await setup();
    const ac = new AbortController();
    const r1 = await svc.send(
      { conversationId: c.id, agent: 'claude', mode: 'bypassPermissions', text: 'PowerShell 로 Start-Sleep -Seconds 60 을 실행한 뒤 끝났다고 답하세요.' },
      (e) => {
        if (e.type === 'toolStart') setTimeout(() => ac.abort(), 2000);
      },
      ac.signal,
    );
    expect(r1.status).toBe('cancelled');
    const r2 = await svc.send({ conversationId: c.id, agent: 'claude', mode: 'default', text: '앞의 요청은 멈췄습니다. "계속" 이라고만 답하세요.' }, () => {});
    expect(r2.status).toBe('ok');
  }, 240_000);
});
```

Run(사용자 동의 후): `$env:AAB_LIVE='1'; npx vitest run test/unit/claude-agent.live.test.ts; Remove-Item Env:AAB_LIVE` — Expected: 2 PASS. 결과를 `docs/verification/phase0-workspace.md` 의 W-V6 칸에 적는다. `npm test` 만 돌리면 이 파일은 건너뛴다.

- [ ] **Step 2: 실제 앱 확인(사용자와 함께)** — `npm run gui` 후:
  1. 상단 `작업공간` → `폴더 추가` → `C:\Users\me\Documents\work\multi-repo`(또는 `C:\Users\olduser\…` 로 골라도 실제 경로 `C:\Users\me\…` 로 저장되는지).
  2. 새 대화, 도구 Claude, 모드 `계획만` 으로 "이 폴더 구조를 저장소별로 요약하고, 지켜야 할 지침이 있으면 알려 줘" → 글이 조각 단위로 나오고, 도구 호출이 한 줄씩 붙고, 끝나면 사용량이 보인다. 답에 `app-agent/AGENTS.md` 를 읽었다는 내용이 있는지(작업공간 안내가 통했는지).
  3. 같은 대화에서 두 번째 메시지 → 이어서 답하는지(이전 내용 기억).
  4. 긴 작업을 보내고 `멈추기` → "멈췄습니다" 표시, 작업 관리자에 `claude.exe` 가 남지 않는지.
  5. 실행 중 상단 계정 메뉴에서 Claude 전환 → "작업공간에서 대화가 실행 중입니다" 오류. `가져오기` 화면으로 가서 가져오기도 같은 오류.
  6. 앱을 껐다 켜도 작업공간·대화·메시지가 그대로인지.
  7. 작업공간 제거 → 목록에서만 사라지고 폴더는 그대로인지.

- [ ] **Step 3: 문서** — `README.md` 의 `## GUI` 아래, `### 보내는 쪽 → 받는 쪽: 세션 가져오기` 다음에:

```markdown
### 작업공간: 한 폴더에서 Claude 와 대화

- 상단 막대 `작업공간` → `폴더 추가` 로 작업 폴더를 등록한다(심볼릭 링크·정션은 실제 경로로 저장). 작업공간·대화 기록은 이 앱(`~\.ai-account-bridge\app.db`)에만 있고, 지우면 이 앱의 기록만 지운다 — 폴더와 각 도구의 세션 파일은 그대로다.
- 대화마다 도구와 권한 모드를 고르고 Ctrl+Enter 로 보낸다. 실제 작업은 PATH 의 `claude` CLI 가 그 폴더에서 한다(현재 로그인한 Claude 계정, 사용 한도는 데스크탑 앱과 같이 쓴다). 출력은 실시간으로 보이고, `멈추기`는 CLI 와 그 CLI 가 띄운 명령까지 끝낸다. 턴마다 입력·출력·캐시 토큰을 표시한다.
- 각 도구 세션의 첫 메시지 앞에는 `[작업공간 안내]`(작업 폴더, 하위 git 저장소와 브랜치, 그 도구가 스스로 읽지 않는 지침 파일 — 예: Claude 에게 `app-agent/AGENTS.md`)가 붙는다. 지침 파일을 새로 만들지는 않는다.
- 한 번에 한 턴만 실행한다. 실행 중에는 계정 전환·복원·새 계정 추가·가져오기를 할 수 없다.
- GPT·Gemini 와 도구를 바꿔 이어 가기는 다음 단계다 — [작업공간 설계](docs/superpowers/specs/2026-10-06-workspace-design.md).
```

`README.md` 의 `## 문서` 목록에 `- [작업공간 설계](docs/superpowers/specs/2026-10-06-workspace-design.md) — 한 폴더에서 Claude·GPT·Gemini 를 골라 쓰는 작업공간` 을 더한다.

`docs/architecture.md` 끝에 절을 더한다:

```markdown
## 작업공간 (Plan 4~)

설계: [작업공간 설계](superpowers/specs/2026-10-06-workspace-design.md).

- `core/agent-events.ts` — `AgentId`(작업공간 도구, 계정용 `ToolId` 와 별개), 공통 이벤트 `AgentEvent`, `TurnUsage`
- `core/turn.ts` — `TurnBuilder`: 한 턴의 이벤트 → IR 블록
- `core/preamble.ts` — `[작업공간 안내]` 글(저장소·브랜치·그 도구가 읽지 않는 지침 파일)
- `providers/claude/agent.ts` — `claude -p` 인자, stream-json 줄 → `AgentEvent`
- `infra/agent-runner.ts` — 턴마다 CLI 한 번 실행, stdin 프롬프트, stdout 줄 단위 JSON, `taskkill /T /F` 로 멈추기
- `infra/exe-locator.ts`, `infra/workspace-scan.ts` — PATH 검색, 폴더 훑기
- `services/workspace-service.ts` — 폴더 등록(실제 경로), 대화·메시지 저장, 한 번에 한 턴
- DB 마이그레이션 4: `workspaces`, `ws_conversations`, `ws_messages`, `ws_agent_sessions`
- 프로토콜: 백엔드 → 화면 `{type:'event', id, data}`, 화면 → 백엔드 `{type:'cancel', id}`. 화면이 닫히면 실행 중인 요청을 취소한다
- RPC: `wsAgents`, `wsList`, `wsAdd`, `wsRemove`, `wsConversations`, `wsNewConversation`, `wsConversation`, `wsDeleteConversation`, `wsSend`. 턴 실행 중에는 `switch`·`restore`·`addAccount`·`importSessions` 를 거절한다
- 화면: `gui/workspace.js`(상단 `작업공간` 버튼으로 전환)
```

- [ ] **Step 4: 전체 확인** — Run: `npm test && npm run typecheck` — Expected: 전체 PASS(라이브 테스트는 건너뜀)

- [ ] **Step 5: Commit**

```bash
git add test/unit/claude-agent.live.test.ts README.md docs/architecture.md docs/verification/phase0-workspace.md
git commit -m "docs: workspace usage, architecture notes and live CLI checks"
```

---

## 자체 점검

**설계 대비 (Plan 4 범위):**
- §4.1 작업공간 추가(절대 경로·폴더 존재·드라이브 루트·중복·실제 경로) → Task 8, 9, 11, 12
- §4.2 대화(도구·모드·보내기/멈추기·실시간 출력·사용량·실패/멈춤 표시) → Task 2, 3, 7, 9, 12
- §4.4 제거(이 앱의 기록만) → Task 8, 9, 11, 12
- W1 공식 CLI 실행 / W11 턴마다 프로세스 / W12 stdin / W13 트리 종료 → Task 7, 9
- W4 우리 DB 가 원본, 도구 세션은 이어 하기용 → Task 8, 9
- W6 실제 경로 → Task 9 (`canonicalPath`), Task 13 Step 2-1
- W7 작업공간 안내·지침 파일 안 만듦 → Task 4, 5, 9
- W8 권한 모드 → Task 1 (W-V4), 2, 12
- W9 한 번에 한 턴 → Task 9 / W10 계정 작업 상호 배제 → Task 11
- W14 `AgentId` 분리 → Task 2
- §8 데이터 모델 → Task 8 / §9 프로토콜·RPC → Task 10, 11, 12
- §10 W-V1~W-V6 → Task 1, 13 / §11 에러 처리 → Task 9 / §12 테스트 → 각 Task + Task 13
- 범위 밖(다음 Plan): §4.3 도구 바꿔 이어 가기, §6 핸드오프, §7 변경 목록, Codex·Gemini, 기존 대화 가져오기

**형식 일관성:** `AgentEvent`(Task 2) ↔ `TurnBuilder`(3) ↔ `WorkspaceService.send`(9) ↔ `wsSend` 이벤트 `{ conversationId, event }`(11) ↔ `bridge.onEvent` / `stLiveTurn`(12). `RunRequest`/`RunResult`(7) ↔ `FakeRunner`(9, 11). `NewWsMessage`/`WsMessageRow`/`AgentSessionRow`(8) ↔ 서비스(9). `ClaudeSession`(2) ↔ 서비스(9).

## 구현 중 변경 사항

- **2026-10-06 — Task 5 를 먼저 구현(세션 가져오기 보강).** multi-repo 처럼 하위 저장소를 모은 폴더 대응 세 가지(하위 폴더 지침 파일, 저장소별 상태, 경로 표기 하나로 맞추기)를 기존 가져오기 기능에 먼저 넣으면서 폴더 훑기를 만들었다:
  - `src/main/infra/workspace-scan.ts` — `scanWorkspace`, `readBranch`(Task 5 그대로) + `gitStatusLines`
  - 형식 `RepoInfo`, `WorkspaceScan` 은 `src/main/core/repo-status.ts` 에 있다(`RepoStatus`, `repoStatusNote`, `withRepoStatus` 와 함께). Task 4 의 `preamble.ts` 는 이 형식을 직접 정의하지 말고 `./repo-status.js` 에서 가져오고, Task 9 테스트의 `type WorkspaceScan` import 도 `core/repo-status.js` 로 바꾼다.
  - 같은 폴더의 다른 표기 처리는 `core/work-folder.ts` 의 `pickClaudeCwd` 에 있다 — Task 9 의 `addWorkspace` 는 `canonicalPath` 대신 이것을 써서 Claude 가 이미 쓰는 표기를 따를 수 있다.
