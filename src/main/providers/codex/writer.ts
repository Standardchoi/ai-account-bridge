import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolId } from '../../core/auth-bundle.js';
import { applyImagePolicy, IMAGE_EXT, toDataUrl } from '../../core/images.js';
import type { IrImage, IrSession } from '../../core/ir.js';
import { type PreparedMessage, prepareForImport, type ToolLogMode } from '../../core/render.js';
import { normalizeWinPath, samePathOrInside, toExtendedPath } from '../../core/win-path.js';
import type { FsTransaction } from '../../infra/fs-transaction.js';
import type { PathProvider } from '../../infra/path-provider.js';
import { openSqlite } from '../../infra/sqlite.js';

const TOOL_LABEL: Record<ToolId, string> = { codex: 'Codex', claude: 'Claude' };
const NO_TEMPLATE_MSG = 'Codex 에서 세션을 하나 만든 뒤 다시 시도하세요.';
const PREVIEW_LEN = 200;

// 템플릿 rollout 의 session_meta/turn_context payload 를 복제해 교체한 paginated 형식의 rollout 줄들.
// 실제 Codex 가 쓰는 형식(2026-09-29 관찰): {ordinal, timestamp, type, payload}, ordinal 은 0 부터 줄마다 1씩 증가.
// 메시지 하나당 하나의 턴: task_started(user 앞) → user 메시지 → item_completed(UserMessage) →
//   뒤따르는 assistant 메시지마다 메시지 + item_completed(AgentMessage, 마지막만 phase:'final_answer' 나머지는 'commentary') → task_complete.
// item_completed 는 앱의 히스토리 투영(thread_history_1.sqlite)이 response_item 이 아니라 이 이벤트로부터
// 만들어지기 때문에 반드시 필요하다(V7 실기기 검증 — 없으면 대화가 빈 화면으로 보인다).
export function buildCodexRollout(
  messages: PreparedMessage[],
  metaTemplate: Record<string, unknown>,
  turnContextTemplate: Record<string, unknown> | undefined,
  o: { threadId: string; cwd: string; templateCwd: string; now: () => string; uuid: () => string; imageFiles?: Map<IrImage, string> },
): string[] {
  let ordinal = 0;
  let itemSeq = 0;
  const lines: string[] = [];
  const push = (timestamp: string, type: string, payload: Record<string, unknown>) => {
    lines.push(JSON.stringify({ ordinal: ordinal++, timestamp, type, payload }));
  };
  const nextItemId = () => `item-${++itemSeq}`;
  // 타임스탬프가 파싱 불가하면(테스트용 자리표시자 등) 현재 시각으로 대체한다.
  // 앱(thread_history_materialization)은 이 숫자 필드들을 엄격한 타입으로 역직렬화한다(V7 실기기 검증) —
  // 문자열로 쓰면 "invalid type: string ..., expected i64/a JSON number" 로 실패해 히스토리가 비어 보인다.
  // 단위(2026-09-29 관찰, 실제 rollout 값 기준): started_at/completed_at 은 초 단위 정수(10자리 epoch 초),
  // create_time 은 초 단위 실수(소수부 포함), completed_at_ms/duration_ms/time_to_first_token_ms 는 밀리초 정수.
  const toMs = (ts: string) => {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  };
  const toEpochSeconds = (ts: string) => Math.floor(toMs(ts) / 1000);
  const toEpochSecondsFloat = (ts: string) => toMs(ts) / 1000;
  const pushItemCompleted = (timestamp: string, turnId: string, item: Record<string, unknown>) => {
    push(timestamp, 'event_msg', { type: 'item_completed', thread_id: o.threadId, turn_id: turnId, item, completed_at_ms: toMs(timestamp) });
  };

  const metaPayload: Record<string, unknown> = { ...metaTemplate };
  delete metaPayload.git; // 실제 파일에는 없는 키지만 방어적으로 제거
  const metaTimestamp = o.now();
  metaPayload.id = o.threadId;
  metaPayload.session_id = o.threadId;
  metaPayload.timestamp = metaTimestamp;
  metaPayload.cwd = toExtendedPath(o.cwd);
  metaPayload.history_mode = 'paginated'; // 최신 형식 고정 — legacy 행은 더 이상 존재하지 않는다(2026-09-29 관찰, 123/123)
  if (metaPayload.context_window && typeof metaPayload.context_window === 'object') {
    // 같은 키 형태(window_id)를 유지하되 새 세션을 위한 새 id 를 발급한다.
    metaPayload.context_window = { ...(metaPayload.context_window as Record<string, unknown>), window_id: o.uuid() };
  }
  push(metaTimestamp, 'session_meta', metaPayload);

  // turn_context 는 첫 턴의 turn_id 를 필요로 하므로(root_turn_id/turn_id 필드가 있으면 그 값을 물려받는다),
  // 실제 사용자 메시지가 있으면 미리 발급해 두고 아래 루프의 첫 턴에서 재사용한다.
  const willHaveTurn = messages.some((m) => m.role === 'user');
  let reservedTurnId = turnContextTemplate && willHaveTurn ? o.uuid() : undefined;

  if (turnContextTemplate) {
    // sandbox_policy 와 마찬가지로 텍스트로 직렬화해 템플릿 cwd 를 어디에 있든(workspace_roots, sandbox_policy 등) 치환한다.
    const replaced = JSON.parse(replaceCwdInJsonText(JSON.stringify(turnContextTemplate), o.templateCwd, o.cwd, 'turn_context')) as Record<string, unknown>;
    if ('turn_id' in replaced) replaced.turn_id = reservedTurnId;
    if ('root_turn_id' in replaced) replaced.root_turn_id = reservedTurnId;
    delete replaced.comp_hash; // 이전 턴 내용에 대한 해시 — 새 세션에는 의미가 없다
    push(o.now(), 'turn_context', replaced);
  }

  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (m.role !== 'user') { i++; continue; } // prepareForImport 는 항상 user 로 시작·교대하지만 방어적으로 건너뛴다
    const turnId = reservedTurnId ?? o.uuid();
    reservedTurnId = undefined;
    const startedAt = m.timestamp ?? o.now();
    push(startedAt, 'event_msg', { type: 'task_started', turn_id: turnId, started_at: toEpochSeconds(startedAt) });
    const { content, kinds, itemContent } = userContent(m, o.imageFiles);
    push(startedAt, 'response_item', {
      type: 'message',
      id: `msg_${o.uuid()}`,
      role: 'user',
      content,
      internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: toEpochSecondsFloat(startedAt), content_item_kinds: kinds },
    });
    pushItemCompleted(startedAt, turnId, {
      type: 'UserMessage',
      id: nextItemId(),
      client_id: o.uuid(),
      content: itemContent,
    });
    i++;

    // 뒤따르는 assistant 메시지를 먼저 모아 둬야 마지막 메시지에만 phase:'final_answer' 를 매길 수 있다
    // (그 앞의 메시지들은 'commentary').
    const assistantRun: PreparedMessage[] = [];
    while (i < messages.length && messages[i]!.role === 'assistant') {
      assistantRun.push(messages[i]!);
      i++;
    }
    let lastAgentMessage = '';
    let completedAt = startedAt;
    assistantRun.forEach((a, idx) => {
      const ts = a.timestamp ?? o.now();
      completedAt = ts;
      lastAgentMessage = a.text;
      push(ts, 'response_item', {
        type: 'message',
        id: `msg_${o.uuid()}`,
        role: 'assistant',
        content: [{ type: 'output_text', text: a.text }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: toEpochSecondsFloat(ts), content_item_kinds: ['text'] },
      });
      const isLast = idx === assistantRun.length - 1;
      pushItemCompleted(ts, turnId, {
        type: 'AgentMessage',
        id: nextItemId(),
        content: [{ type: 'Text', text: a.text }],
        phase: isLast ? 'final_answer' : 'commentary',
      });
    });
    push(completedAt, 'event_msg', {
      type: 'task_complete',
      turn_id: turnId,
      started_at: toEpochSeconds(startedAt),
      completed_at: toEpochSeconds(completedAt),
      duration_ms: Math.max(0, toMs(completedAt) - toMs(startedAt)),
      time_to_first_token_ms: 0,
      last_agent_message: lastAgentMessage,
    });
  }

  return lines;
}

// 사용자 메시지의 모델 입력(response_item content)과 앱 히스토리(item_completed UserMessage content).
// 글만 있으면 예전 형식 그대로. 이미지가 있으면 실제 Codex 형식(2026-07 이후 관찰)을 따른다 — 모델에는
// '<image name=[Image #n] path="…">' · input_image(data URL) · '</image>', 앱에는 local_image(파일 경로).
// 파일을 쓰지 못한 이미지(imageFiles 에 없음)는 앱에도 data URL(image)로 준다.
function userContent(
  m: PreparedMessage,
  imageFiles: Map<IrImage, string> | undefined,
): { content: Record<string, unknown>[]; kinds: string[]; itemContent: Record<string, unknown>[] } {
  if (!m.images?.length) {
    return { content: [{ type: 'input_text', text: m.text }], kinds: ['text'], itemContent: [{ type: 'text', text: m.text, text_elements: [] }] };
  }
  const content: Record<string, unknown>[] = [];
  const kinds: string[] = [];
  const itemContent: Record<string, unknown>[] = [];
  if (m.text) {
    content.push({ type: 'input_text', text: m.text });
    kinds.push('user.text');
    itemContent.push({ type: 'text', text: m.text, text_elements: [] });
  }
  m.images.forEach((img, k) => {
    const file = imageFiles?.get(img);
    const name = `[Image #${k + 1}]`;
    content.push(
      { type: 'input_text', text: file ? `<image name=${name} path="${file}">` : `<image name=${name}>` },
      { type: 'input_image', image_url: toDataUrl(img), detail: 'high' },
      { type: 'input_text', text: '</image>' },
    );
    kinds.push('user.text', 'user.image', 'user.text');
    itemContent.push(file ? { type: 'local_image', path: file } : { type: 'image', image_url: toDataUrl(img) });
  });
  return { content, kinds, itemContent };
}

// 텍스트가 JSON 문자열 안에 나타날 때의 이스케이프 형태(백슬래시 두 배).
function jsonEscape(raw: string): string {
  return raw.replace(/\\/g, '\\\\');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 일치 지점 바로 뒤가 겹쳐진 백슬래시(JSON 이스케이프된 경로 구분자, 실제 문자는 \\ 두 개)이거나 /, ",
// 문자열 끝일 때만 치환하도록 하는 lookahead — 'C:\work' 가 'C:\work-backup' 의 일부를 잘못 치환하지
// 않게 막는다. 정규식 문법에서 리터럴 백슬래시 1개를 매칭하려면 패턴 문자열에 백슬래시 2개(escape 쌍)가
// 필요하므로, 2개를 매칭하려면 패턴 문자열에 4개가 필요하다 — 그 4개를 JS 문자열 리터럴로 적으려면(각
// 백슬래시를 다시 escape) 소스 코드에는 8개를 적어야 한다.
const PATH_BOUNDARY = '(?=\\\\\\\\|/|"|$)';

// 대소문자를 구분하지 않고 치환하되, 실제로 몇 번 치환됐는지도 반환한다.

function replaceCaseInsensitive(haystack: string, needle: string, replacement: string): { result: string; count: number } {
  if (needle === '') return { result: haystack, count: 0 };
  const re = new RegExp(escapeRegExp(needle) + PATH_BOUNDARY, 'gi');
  const matches = haystack.match(re);
  return { result: haystack.replace(re, replacement), count: matches ? matches.length : 0 };
}

// jsonText(JSON.stringify 로 만든 텍스트) 안의 템플릿 cwd(\\?\ 유무 모두, JSON 이스케이프된 형태, 대소문자
// 무관)를 새 cwd 로 치환한다. label 은 실패 메시지에만 쓰인다.
function replaceCwdInJsonText(jsonText: string, templateCwd: string, cwd: string, label: string): string {
  const escTemplatePrefixed = jsonEscape(toExtendedPath(templateCwd));
  const escNewPrefixed = jsonEscape(toExtendedPath(cwd));
  const escTemplate = jsonEscape(templateCwd);
  const escNew = jsonEscape(cwd);

  let out = jsonText;
  let replacements = 0;

  const r1 = replaceCaseInsensitive(out, escTemplatePrefixed, escNewPrefixed);
  out = r1.result;
  replacements += r1.count;

  const r2 = replaceCaseInsensitive(out, escTemplate, escNew);
  out = r2.result;
  replacements += r2.count;

  const templateCwdPresent = escTemplate !== '' && jsonText.toLowerCase().includes(escTemplate.toLowerCase());
  if (templateCwdPresent && replacements === 0) {
    throw new Error(`${label} 안의 템플릿 cwd 를 치환하지 못했습니다.`);
  }

  try {
    JSON.parse(out);
  } catch {
    throw new Error(`${label} 치환 결과가 올바른 JSON 이 아닙니다: ${out}`);
  }
  return out;
}

// sandbox_policy 문자열 안의 템플릿 cwd 를 새 cwd 로 치환한다.
// 실제 DB 의 sandbox_policy 경로는 \\?\ 접두어가 없지만(2026-09-29 관찰, 123/123), 방어적으로 두 형태 모두 처리한다.
function replaceSandboxCwd(policyText: string, templateCwd: string, cwd: string): string {
  return replaceCwdInJsonText(policyText, templateCwd, cwd, 'sandbox_policy');
}

// 템플릿 threads 행을 복제해 교체. 템플릿에 없는 컬럼은 추가하지 않는다.
export function buildThreadRow(
  template: Record<string, unknown>,
  o: {
    threadId: string;
    rolloutPath: string;
    cwd: string;
    title: string;
    firstUserMessage: string;
    nowMs: number;
    projectId: string | null;
    templateCwd: string;
  },
): Record<string, unknown> {
  const out: Record<string, unknown> = structuredClone(template);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(template, k);
  const set = (k: string, v: unknown) => {
    if (has(k)) out[k] = v;
  };

  const nowSec = Math.floor(o.nowMs / 1000);
  const preview = o.firstUserMessage.slice(0, PREVIEW_LEN);

  set('id', o.threadId);
  set('rollout_path', o.rolloutPath); // 실제 DB 는 대부분 접두어 없이 저장한다(2026-09-29 관찰, 23/123 만 접두어 있음)
  set('cwd', toExtendedPath(o.cwd)); // cwd 는 대부분 접두어를 포함한다(118/123)
  set('title', o.title);
  set('name', o.title);
  set('preview', preview);
  set('first_user_message', preview);
  set('created_at', nowSec);
  set('updated_at', nowSec);
  set('created_at_ms', o.nowMs);
  set('updated_at_ms', o.nowMs);
  set('recency_at_ms', o.nowMs);
  set('recency_at', nowSec);
  set('tokens_used', 0);
  set('has_user_event', 1);
  set('archived', 0);
  set('archived_at', null);
  set('git_sha', null);
  set('git_branch', null);
  set('git_origin_url', null);
  set('history_mode', 'paginated'); // 모든 실제 행이 paginated (2026-09-29 관찰, 123/123) — legacy 로 쓰지 않는다
  set('thread_source', 'user');
  set('source', 'vscode');
  set('agent_nickname', null);
  set('agent_role', null);
  set('agent_path', null);
  set('is_pinned', 0);
  set('thread_section_id', null);
  set('section_position', null);
  set('section_entered_at_ms', null);
  set('project_id', o.projectId);

  if (has('sandbox_policy') && typeof template.sandbox_policy === 'string') {
    out.sandbox_policy = replaceSandboxCwd(template.sandbox_policy, o.templateCwd, o.cwd);
  }

  return out;
}

// 현재 ms 를 앞 48비트로 넣은 UUID v7(시간 기반, Codex ID 와 정렬 일관성).
function uuidV7(nowMs: number): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(nowMs, 0, 6);
  const rnd = crypto.randomBytes(10);
  bytes[6] = 0x70 | (rnd[0]! & 0x0f); // version 7
  bytes[7] = rnd[1]!;
  bytes[8] = 0x80 | (rnd[2]! & 0x3f); // variant 10
  bytes[9] = rnd[3]!;
  for (let i = 10; i < 16; i++) bytes[i] = rnd[i - 6]!;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function rolloutFilePath(paths: PathProvider, when: Date, threadId: string): string {
  const y = String(when.getFullYear());
  const mo = pad(when.getMonth() + 1);
  const d = pad(when.getDate());
  const stamp = `${y}-${mo}-${d}T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return path.join(paths.home, '.codex', 'sessions', y, mo, d, `rollout-${stamp}-${threadId}.jsonl`);
}

// source='vscode' 이고 cwd 가 같은(정규화 비교) 행 우선, 없으면 가장 최근(updated_at) vscode 행.
function pickTemplateThread(db: Database.Database, cwd: string): Record<string, unknown> | undefined {
  const rows = db.prepare("SELECT * FROM threads WHERE source = 'vscode'").all() as Record<string, unknown>[];
  if (rows.length === 0) return undefined;
  const target = normalizeWinPath(cwd).toLowerCase();
  const sameCwd = rows.filter((r) => typeof r.cwd === 'string' && normalizeWinPath(r.cwd).toLowerCase() === target);
  const pool = sameCwd.length > 0 ? sameCwd : rows;
  pool.sort((a, b) => Number(b.updated_at ?? 0) - Number(a.updated_at ?? 0));
  return pool[0];
}

// cwd 를 포함하는 project_roots 중 가장 깊은(경로가 가장 긴) 루트의 project_id.
function findProjectId(db: Database.Database, cwd: string): string | null {
  const roots = db.prepare('SELECT project_id, path FROM project_roots').all() as { project_id: string; path: string | null }[];
  let best: { projectId: string; len: number } | undefined;
  for (const r of roots) {
    if (!r.path || !samePathOrInside(cwd, r.path)) continue;
    const len = normalizeWinPath(r.path).length;
    if (!best || len > best.len) best = { projectId: r.project_id, len };
  }
  return best?.projectId ?? null;
}

// 템플릿 rollout 파일의 첫 session_meta payload 와 첫 turn_context payload(있으면).
async function readTemplateEnvelopes(rolloutPath: string): Promise<{ sessionMeta: Record<string, unknown>; turnContext?: Record<string, unknown> }> {
  const file = normalizeWinPath(rolloutPath);
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (e) {
    throw new Error(`템플릿 rollout 을 읽을 수 없습니다: ${file} (${e instanceof Error ? e.message : String(e)})`);
  }
  let sessionMeta: Record<string, unknown> | undefined;
  let turnContext: Record<string, unknown> | undefined;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; payload?: unknown };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionMeta && o?.type === 'session_meta' && o.payload && typeof o.payload === 'object') {
      sessionMeta = o.payload as Record<string, unknown>;
    }
    if (!turnContext && o?.type === 'turn_context' && o.payload && typeof o.payload === 'object') {
      turnContext = o.payload as Record<string, unknown>;
    }
    if (sessionMeta && turnContext) break;
  }
  if (!sessionMeta) throw new Error(`템플릿 rollout 에 session_meta 가 없습니다: ${file}`);
  return { sessionMeta, turnContext };
}

// 다른 프로세스(백신, Codex 앱 등)가 대상 파일을 잠시 잡고 있으면 Windows 의 rename 이 EPERM/EBUSY/EACCES 로 실패한다.
async function renameWithRetry(from: string, to: string, attempts = 3, delayMs = 100): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// 임시 파일에 쓴 뒤 rename 해서 쓰다 만 파일이 남지 않게 한다(원본 백업은 호출자의 tx.backupThenModify 가 보관).
async function replaceFile(file: string, content: string): Promise<void> {
  const tmpPath = `${file}.aab-tmp-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(tmpPath, content);
    await renameWithRetry(tmpPath, file);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

// Codex 26.1013 사이드바는 프로젝트 루트 안의 cwd, 프로젝트 지정(thread-project-assignments), projectless-thread-ids
// 로만 스레드를 보여 준다(2026-10 관찰: 보이는 스레드 70개가 모두 셋 중 하나) — 어느 프로젝트(local-projects)에도
// 속하지 않는 폴더의 스레드는 어디에도 안 보이므로, 앱이 만드는 채팅처럼 projectless-thread-ids 에 넣어 '프로젝트
// 없음'에 보이게 한다. 상태 파일이 없거나 형식이 다르면 건드리지 않는다. Codex 앱이 꺼져 있을 때 호출된다.
async function listAsProjectlessIfOutsideProjects(paths: PathProvider, tx: FsTransaction, threadId: string, cwd: string): Promise<void> {
  const file = path.join(paths.home, '.codex', '.codex-global-state.json');
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return;
  }
  const locals = state['local-projects'];
  if (typeof locals !== 'object' || locals === null || Array.isArray(locals)) return;
  const roots = Object.values(locals).flatMap((pr) => {
    const rootPaths = (pr as { rootPaths?: unknown } | null)?.rootPaths;
    return Array.isArray(rootPaths) ? rootPaths.filter((r): r is string => typeof r === 'string') : [];
  });
  if (roots.some((r) => samePathOrInside(cwd, r))) return;
  const ids = Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : [];
  await tx.backupThenModify(file, () => replaceFile(file, JSON.stringify({ ...state, 'projectless-thread-ids': [...ids, threadId] })));
}

export async function writeCodexSession(
  paths: PathProvider,
  tx: FsTransaction,
  input: { ir: IrSession; sourceCreatedAt: string; cwd: string; toolLog?: ToolLogMode; now?: () => Date; uuid?: () => string },
): Promise<{ threadId: string; rolloutPath: string }> {
  const now = input.now ?? (() => new Date());
  const cwd = normalizeWinPath(input.cwd);
  const dbFile = path.join(paths.home, '.codex', 'state_5.sqlite');

  let db: Database.Database;
  try {
    db = openSqlite(dbFile, { fileMustExist: true });
  } catch {
    throw new Error(NO_TEMPLATE_MSG);
  }

  let threadId: string;
  let rolloutPath: string;
  try {
    const template = pickTemplateThread(db, cwd);
    if (!template) throw new Error(NO_TEMPLATE_MSG);
    const templateCwd = normalizeWinPath((template.cwd as string) ?? '');

    const { sessionMeta: metaTemplate, turnContext: turnContextTemplate } = await readTemplateEnvelopes(template.rollout_path as string);
    threadId = input.uuid ? input.uuid() : uuidV7(now().getTime());

    const title = `[${TOOL_LABEL[input.ir.tool]}] ${input.ir.title ?? '(제목 없음)'}`;
    const messages = applyImagePolicy(prepareForImport(input.ir, input.sourceCreatedAt, input.toolLog), 'codex');

    // 앱은 히스토리의 이미지를 파일(local_image)로 보여 준다 — Codex 가 쓰는 %TEMP% 대신 지워지지 않는 본 앱 폴더에 둔다.
    const imageFiles = new Map<IrImage, string>();
    let n = 0;
    for (const img of messages.flatMap((m) => m.images ?? [])) {
      const file = path.join(paths.appDataDir, 'images', 'codex', threadId, `image-${++n}.${IMAGE_EXT[img.mediaType] ?? 'png'}`);
      await tx.createFile(file, Buffer.from(img.data, 'base64'));
      imageFiles.set(img, file);
    }

    const lines = buildCodexRollout(messages, metaTemplate, turnContextTemplate, {
      threadId,
      cwd,
      templateCwd,
      now: () => now().toISOString(),
      uuid: () => crypto.randomUUID(),
      imageFiles,
    });
    rolloutPath = rolloutFilePath(paths, now(), threadId);
    await tx.createFile(rolloutPath, `${lines.join('\n')}\n`);

    const sessionIndexPath = path.join(paths.home, '.codex', 'session_index.jsonl');
    const indexLine = JSON.stringify({ id: threadId, thread_name: title, updated_at: now().toISOString() });
    const indexExists = await fs.stat(sessionIndexPath).then(() => true, () => false);
    if (indexExists) {
      await tx.backupThenModify(sessionIndexPath, async () => {
        const existing = await fs.readFile(sessionIndexPath, 'utf8');
        const withTrailingNewline = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
        await replaceFile(sessionIndexPath, `${withTrailingNewline}${indexLine}\n`);
      });
    } else {
      // 아직 인덱스가 없는 설치(첫 세션 등) — 백업할 원본이 없으므로 새 파일로 만들고, 롤백 시 삭제되게 한다.
      await tx.createFile(sessionIndexPath, `${indexLine}\n`);
    }

    await listAsProjectlessIfOutsideProjects(paths, tx, threadId, cwd);

    const projectId = findProjectId(db, cwd);
    const threadRow = buildThreadRow(template, {
      threadId,
      rolloutPath,
      cwd,
      title,
      firstUserMessage: messages[0]!.text,
      nowMs: now().getTime(),
      projectId,
      templateCwd,
    });

    const insert = db.transaction(() => {
      const columns = (db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map((c) => c.name);
      const validCols = new Set(columns);
      const keys = Object.keys(threadRow).filter((k) => validCols.has(k));
      const sql = `INSERT INTO threads (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...keys.map((k) => threadRow[k]));
    });
    insert();

    // INSERT 는 이 함수가 끝나면 커밋된 상태다(별도 파일 트랜잭션과 달리 tx.rollback() 이 되돌려주지 않는다) —
    // 실패 시(예: 이후 단계의 db.recordImport 실패) 호출자가 되돌릴 수 있도록 보정 작업을 등록해 둔다.
    tx.onRollback(() => {
      const cleanupDb = openSqlite(dbFile, { fileMustExist: true });
      try {
        cleanupDb.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
      } finally {
        cleanupDb.close();
      }
    });
  } finally {
    db.close();
  }

  return { threadId, rolloutPath };
}
