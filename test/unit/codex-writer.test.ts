import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IrSession } from '../../src/main/core/ir.js';
import type { PreparedMessage } from '../../src/main/core/render.js';
import { FsTransaction } from '../../src/main/infra/fs-transaction.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { listCodexSessions, readCodexSession } from '../../src/main/providers/codex/sessions.js';
import { buildCodexRollout, buildThreadRow, writeCodexSession } from '../../src/main/providers/codex/writer.js';
import { codexStateDb, jsonl, pngBase64, writeRollout } from '../helpers/fake-sessions.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
beforeEach(async () => {
  p = await tmpPaths();
  await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
});

const fakeIr = (cwd = 'C:\\work\\proj'): IrSession => ({
  tool: 'claude',
  sessionId: 'src-1',
  title: '버그 수정',
  cwd,
  model: 'claude-x',
  messages: [
    { role: 'user', timestamp: '2026-09-01T00:00:01.000Z', blocks: [{ kind: 'text', text: '고쳐줘' }] },
    { role: 'assistant', timestamp: '2026-09-01T00:00:02.000Z', blocks: [{ kind: 'text', text: '고쳤어요' }] },
  ],
  stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 },
});

describe('buildCodexRollout', () => {
  // 실제 Codex 가 쓰는 paginated 형식을 반영한 템플릿(2026-09-29 관찰): 항상 paginated, context_window={window_id}, git 키 없음.
  const metaTemplate = () => ({
    id: 'tpl-thread',
    session_id: 'tpl-thread',
    timestamp: '2026-09-01T00:00:00.000Z',
    cwd: '\\\\?\\C:\\work\\old',
    originator: 'vscode',
    cli_version: '1.2.3',
    model_provider: 'openai',
    base_instructions: '너는 Codex 다.',
    history_mode: 'legacy', // 오래된 템플릿이라도 강제로 paginated 로 써야 한다
    context_window: { window_id: 'tpl-window' },
    git: { sha: 'abc' }, // 실제 파일엔 없지만 방어적으로 제거되는지 확인
  });
  const turnContextTemplate = () => ({
    cwd: '\\\\?\\C:\\work\\old',
    model: 'gpt-5',
    approval_policy: 'on-request',
    sandbox_policy: { mode: 'workspace-write' },
  });

  const messages: PreparedMessage[] = [
    { role: 'user', text: '알림+질문', timestamp: '2026-09-29T00:00:01.000Z' },
    { role: 'assistant', text: '답변', timestamp: '2026-09-29T00:00:02.000Z' },
  ];

  it('emits {ordinal, timestamp, type, payload} envelopes with sequential ordinals starting at 0', () => {
    let n = 0;
    const lines = buildCodexRollout(messages, metaTemplate(), turnContextTemplate(), {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const parsed = lines.map((l) => JSON.parse(l));
    parsed.forEach((line, i) => {
      expect(Object.keys(line).sort()).toEqual(['ordinal', 'payload', 'timestamp', 'type']);
      expect(line.ordinal).toBe(i);
    });
  });

  it('writes user images in the current Codex shape: <image> tags + input_image for the model, local_image (or a data URL without a file) for the app', () => {
    const a = { mediaType: 'image/png', data: pngBase64(10, 10) };
    const b = { mediaType: 'image/jpeg', data: '/9j/AA==' };
    const withImages: PreparedMessage[] = [
      { role: 'user', text: '이 화면 봐줘', images: [a, b], timestamp: '2026-09-29T00:00:01.000Z' },
      { role: 'assistant', text: '볼게요', timestamp: '2026-09-29T00:00:02.000Z' },
      { role: 'user', text: '', images: [a], timestamp: '2026-09-29T00:00:03.000Z' },
    ];
    let n = 0;
    const lines = buildCodexRollout(withImages, metaTemplate(), undefined, {
      threadId: 't', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
      imageFiles: new Map([[a, 'C:\\img\\image-1.png']]),
    }).map((l) => JSON.parse(l));
    const users = lines.filter((l) => l.type === 'response_item' && l.payload.role === 'user').map((l) => l.payload);
    expect(users[0].content).toEqual([
      { type: 'input_text', text: '이 화면 봐줘' },
      { type: 'input_text', text: '<image name=[Image #1] path="C:\\img\\image-1.png">' },
      { type: 'input_image', image_url: `data:image/png;base64,${a.data}`, detail: 'high' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: '<image name=[Image #2]>' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AA==', detail: 'high' },
      { type: 'input_text', text: '</image>' },
    ]);
    expect(users[0].internal_chat_message_metadata_passthrough.content_item_kinds).toEqual(['user.text', 'user.text', 'user.image', 'user.text', 'user.text', 'user.image', 'user.text']);
    expect(users[1].content[0]).toEqual({ type: 'input_text', text: '<image name=[Image #1] path="C:\\img\\image-1.png">' }); // 글 없는 메시지는 글 항목을 넣지 않는다
    const items = lines.filter((l) => l.type === 'event_msg' && l.payload.type === 'item_completed' && l.payload.item.type === 'UserMessage').map((l) => l.payload.item.content);
    expect(items[0]).toEqual([
      { type: 'text', text: '이 화면 봐줘', text_elements: [] },
      { type: 'local_image', path: 'C:\\img\\image-1.png' },
      { type: 'image', image_url: 'data:image/jpeg;base64,/9j/AA==' },
    ]);
    expect(items[1]).toEqual([{ type: 'local_image', path: 'C:\\img\\image-1.png' }]);
    // 이미지 없는 메시지는 예전 형식 그대로
    const plain = buildCodexRollout(messages, metaTemplate(), undefined, { threadId: 't', cwd: 'C:\\w', templateCwd: 'C:\\w', now: () => '2026-09-29T03:04:05.000Z', uuid: () => 'u' })
      .map((l) => JSON.parse(l)).find((l) => l.type === 'response_item' && l.payload.role === 'user');
    expect(plain.payload.internal_chat_message_metadata_passthrough.content_item_kinds).toEqual(['text']);
  });

  it('prefixes a UNC cwd as \\\\?\\UNC\\server\\share (session_meta and turn_context), also when the template cwd is UNC', () => {
    let n = 0;
    const unc = { ...turnContextTemplate(), cwd: '\\\\?\\UNC\\old\\share\\p', workspace_roots: ['\\\\?\\UNC\\old\\share\\p'] };
    const lines = buildCodexRollout(messages, { ...metaTemplate(), cwd: '\\\\?\\UNC\\old\\share\\p' }, unc, {
      threadId: 'new-thread', cwd: '\\\\srv\\share\\new', templateCwd: '\\\\old\\share\\p', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].payload.cwd).toBe('\\\\?\\UNC\\srv\\share\\new');
    const tc = parsed.find((l) => l.type === 'turn_context');
    expect(tc.payload.cwd).toBe('\\\\?\\UNC\\srv\\share\\new');
    expect(tc.payload.workspace_roots).toEqual(['\\\\?\\UNC\\srv\\share\\new']);
  });

  it('keeps history_mode paginated and base_instructions, regenerates context_window with the same key shape, and drops git', () => {
    let n = 0;
    const lines = buildCodexRollout(messages, metaTemplate(), undefined, {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const meta = JSON.parse(lines[0]!);
    expect(meta.type).toBe('session_meta');
    expect(meta.payload).toMatchObject({
      id: 'new-thread',
      session_id: 'new-thread',
      timestamp: '2026-09-29T03:04:05.000Z',
      cwd: '\\\\?\\C:\\work\\new',
      originator: 'vscode',
      cli_version: '1.2.3',
      model_provider: 'openai',
      base_instructions: '너는 Codex 다.',
      history_mode: 'paginated',
    });
    expect(meta.payload).not.toHaveProperty('git');
    expect(Object.keys(meta.payload.context_window)).toEqual(['window_id']);
    expect(meta.payload.context_window.window_id).not.toBe('tpl-window'); // 새 세션을 위한 새 id
  });

  it('emits a turn_context line right after session_meta, replacing the template cwd (prefixed form preserved) everywhere in the payload', () => {
    let n = 0;
    const lines = buildCodexRollout(messages, metaTemplate(), turnContextTemplate(), {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const tc = JSON.parse(lines[1]!);
    expect(tc.type).toBe('turn_context');
    // 템플릿 cwd 가 \\?\ 접두어 형태였으므로, 그 형태 그대로(접두어 유지) 치환된다 — 무조건 벗겨내지 않는다.
    expect(tc.payload).toEqual({ cwd: '\\\\?\\C:\\work\\new', model: 'gpt-5', approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' } });
  });

  it('replaces the template cwd wherever it appears inside the turn_context payload, not just the top-level cwd field', () => {
    let n = 0;
    const nested = () => ({
      cwd: 'C:\\work\\old',
      model: 'gpt-5',
      sandbox_policy: { mode: 'workspace-write', writable_roots: ['C:\\work\\old', 'C:\\work\\old\\sub'] },
      workspace_roots: ['C:\\work\\old'],
    });
    const lines = buildCodexRollout(messages, metaTemplate(), nested(), {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const tc = JSON.parse(lines[1]!);
    expect(tc.payload).toEqual({
      cwd: 'C:\\work\\new',
      model: 'gpt-5',
      sandbox_policy: { mode: 'workspace-write', writable_roots: ['C:\\work\\new', 'C:\\work\\new\\sub'] },
      workspace_roots: ['C:\\work\\new'],
    });
  });

  it('does not rewrite a sibling path that merely starts with the template cwd (turn_context)', () => {
    let n = 0;
    const sibling = () => ({ cwd: 'C:\\work', workspace_roots: ['C:\\work', 'C:\\work-backup'] });
    const lines = buildCodexRollout(messages, metaTemplate(), sibling(), {
      threadId: 'new-thread', cwd: 'C:\\new', templateCwd: 'C:\\work', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const tc = JSON.parse(lines[1]!);
    expect(tc.payload).toEqual({ cwd: 'C:\\new', workspace_roots: ['C:\\new', 'C:\\work-backup'] });
  });

  it('regenerates turn_id/root_turn_id to the first turn\'s id and drops comp_hash', () => {
    let n = 0;
    const withIds = () => ({ cwd: 'C:\\work\\old', turn_id: 'tpl-turn', root_turn_id: 'tpl-root', comp_hash: 'tpl-hash' });
    const lines = buildCodexRollout(messages, metaTemplate(), withIds(), {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    const parsed = lines.map((l) => JSON.parse(l));
    const tc = parsed.find((l) => l.type === 'turn_context')!;
    const started = parsed.find((l) => l.type === 'event_msg' && l.payload.type === 'task_started')!;
    expect(tc.payload).not.toHaveProperty('comp_hash');
    expect(tc.payload.turn_id).toBe(started.payload.turn_id);
    expect(tc.payload.root_turn_id).toBe(started.payload.turn_id);
    expect(tc.payload.turn_id).not.toBe('tpl-turn');
  });

  it('omits turn_context entirely when no template turn_context is given', () => {
    let n = 0;
    const lines = buildCodexRollout(messages, metaTemplate(), undefined, {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid: () => `uuid-${++n}`,
    });
    expect(lines.map((l) => JSON.parse(l).type)).not.toContain('turn_context');
  });

  it('wraps a user/assistant pair in task_started → message → item_completed → message → item_completed → task_complete, sharing one turn_id', () => {
    let n = 0;
    const uuid = () => `uuid-${++n}`;
    const lines = buildCodexRollout(messages, metaTemplate(), undefined, { threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => '2026-09-29T03:04:05.000Z', uuid });
    const parsed = lines.map((l) => JSON.parse(l));

    expect(parsed.map((l) => (l.type === 'event_msg' ? `event_msg:${l.payload.type}` : l.type))).toEqual([
      'session_meta',
      'event_msg:task_started',
      'response_item',
      'event_msg:item_completed',
      'response_item',
      'event_msg:item_completed',
      'event_msg:task_complete',
    ]);
    const [, started, userMsg, userItemCompleted, assistantMsg, assistantItemCompleted, completed] = parsed;
    const turnId = started.payload.turn_id;

    // 앱(thread_history_materialization)은 started_at/completed_at 을 초 단위 정수(i64)로, create_time 은
    // 초 단위 실수로 역직렬화한다(V7 실기기 검증) — 문자열이면 파싱 실패로 히스토리가 비어 보인다.
    expect(started.payload).toMatchObject({ type: 'task_started', started_at: Math.floor(new Date('2026-09-29T00:00:01.000Z').getTime() / 1000) });
    expect(userMsg.payload).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '알림+질문' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: new Date('2026-09-29T00:00:01.000Z').getTime() / 1000, content_item_kinds: ['text'] },
    });
    expect(userItemCompleted.payload).toMatchObject({
      type: 'item_completed',
      thread_id: 'new-thread',
      turn_id: turnId,
      item: { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text: '알림+질문', text_elements: [] }] },
      completed_at_ms: new Date('2026-09-29T00:00:01.000Z').getTime(),
    });
    expect(typeof userItemCompleted.payload.item.client_id).toBe('string');
    expect(userItemCompleted.payload.item.client_id).not.toBe('');

    expect(assistantMsg.payload).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '답변' }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, create_time: new Date('2026-09-29T00:00:02.000Z').getTime() / 1000, content_item_kinds: ['text'] },
    });
    expect(assistantItemCompleted.payload).toMatchObject({
      type: 'item_completed',
      thread_id: 'new-thread',
      turn_id: turnId,
      item: { type: 'AgentMessage', id: 'item-2', content: [{ type: 'Text', text: '답변' }], phase: 'final_answer' },
      completed_at_ms: new Date('2026-09-29T00:00:02.000Z').getTime(),
    });
    expect(assistantItemCompleted.payload.item).not.toHaveProperty('client_id'); // AgentMessage 에는 client_id 가 없다

    expect(completed.payload).toMatchObject({
      type: 'task_complete',
      turn_id: turnId,
      started_at: Math.floor(new Date('2026-09-29T00:00:01.000Z').getTime() / 1000),
      completed_at: Math.floor(new Date('2026-09-29T00:00:02.000Z').getTime() / 1000),
      duration_ms: 1000,
      time_to_first_token_ms: 0,
      last_agent_message: '답변',
    });
  });

  it('writes every time field the app deserializes strictly as a number (V7: strings made the app skip the lines)', () => {
    const lines = buildCodexRollout(messages, metaTemplate(), undefined, {
      threadId: 'new-thread', cwd: 'C:\\work\\new', templateCwd: 'C:\\work\\old', now: () => 'not-a-date', uuid: crypto.randomUUID,
    }).map((l) => JSON.parse(l));
    const ints: [string, unknown][] = [];
    const nums: [string, unknown][] = [];
    for (const l of lines) {
      const p = l.payload;
      if (l.type === 'event_msg' && p.type === 'task_started') ints.push(['task_started.started_at', p.started_at]);
      if (l.type === 'event_msg' && p.type === 'task_complete') {
        for (const k of ['started_at', 'completed_at', 'duration_ms', 'time_to_first_token_ms']) ints.push([`task_complete.${k}`, p[k]]);
      }
      if (l.type === 'event_msg' && p.type === 'item_completed') ints.push(['item_completed.completed_at_ms', p.completed_at_ms]);
      if (l.type === 'response_item' && p.type === 'message') nums.push(['create_time', p.internal_chat_message_metadata_passthrough.create_time]);
    }
    expect(ints.length).toBeGreaterThan(0);
    expect(nums.length).toBeGreaterThan(0);
    for (const [name, v] of ints) expect(Number.isInteger(v), name).toBe(true);
    for (const [name, v] of nums) expect(typeof v, name).toBe('number');
  });

  it('marks only the last assistant message of a turn as final_answer, earlier ones as commentary, with item-<n> ids sequential across the whole thread', () => {
    const multiAssistant: PreparedMessage[] = [
      { role: 'user', text: 'q1', timestamp: '2026-09-29T00:00:01.000Z' },
      { role: 'assistant', text: 'thinking out loud', timestamp: '2026-09-29T00:00:02.000Z' },
      { role: 'assistant', text: 'final reply', timestamp: '2026-09-29T00:00:03.000Z' },
    ];
    let n = 0;
    const lines = buildCodexRollout(multiAssistant, metaTemplate(), undefined, {
      threadId: 'x', cwd: 'C:\\x', templateCwd: 'C:\\work\\old', now: () => 'now', uuid: () => `uuid-${++n}`,
    });
    const items = lines.map((l) => JSON.parse(l)).filter((l) => l.type === 'event_msg' && l.payload.type === 'item_completed').map((l) => l.payload.item);

    expect(items).toEqual([
      { type: 'UserMessage', id: 'item-1', client_id: expect.any(String), content: [{ type: 'text', text: 'q1', text_elements: [] }] },
      { type: 'AgentMessage', id: 'item-2', content: [{ type: 'Text', text: 'thinking out loud' }], phase: 'commentary' },
      { type: 'AgentMessage', id: 'item-3', content: [{ type: 'Text', text: 'final reply' }], phase: 'final_answer' },
    ]);
  });

  it('keeps item-<n> ids sequential across multiple turns and starts a fresh turn_id for each new user message', () => {
    const multi: PreparedMessage[] = [
      { role: 'user', text: 'q1', timestamp: 't1' },
      { role: 'assistant', text: 'a1', timestamp: 't2' },
      { role: 'user', text: 'q2', timestamp: 't3' },
      { role: 'assistant', text: 'a2', timestamp: 't4' },
    ];
    const lines = buildCodexRollout(multi, metaTemplate(), undefined, { threadId: 'x', cwd: 'C:\\x', templateCwd: 'C:\\work\\old', now: () => 'now', uuid: crypto.randomUUID });
    const parsed = lines.map((l) => JSON.parse(l));

    const taskEvents = parsed.filter((l) => l.type === 'event_msg' && (l.payload.type === 'task_started' || l.payload.type === 'task_complete'));
    const [started1, completed1, started2, completed2] = taskEvents;
    expect(started1.payload.turn_id).toBe(completed1.payload.turn_id);
    expect(started2.payload.turn_id).toBe(completed2.payload.turn_id);
    expect(started1.payload.turn_id).not.toBe(started2.payload.turn_id); // 턴마다 새 turn_id

    const itemCompletedEvents = parsed.filter((l) => l.type === 'event_msg' && l.payload.type === 'item_completed');
    expect(itemCompletedEvents.map((l) => l.payload.item.id)).toEqual(['item-1', 'item-2', 'item-3', 'item-4']); // 스레드 전체에서 순차 증가
    expect(itemCompletedEvents[0].payload.turn_id).toBe(started1.payload.turn_id);
    expect(itemCompletedEvents[2].payload.turn_id).toBe(started2.payload.turn_id);
  });
});

describe('buildThreadRow', () => {
  const template = () => ({
    id: 'tpl-thread',
    rollout_path: 'C:\\home\\.codex\\sessions\\2026\\09\\28\\rollout-tpl.jsonl', // 실제 DB 는 대부분 접두어 없이 저장(23/123)
    created_at: 1000,
    updated_at: 2000,
    source: 'vscode',
    model_provider: 'openai',
    cwd: '\\\\?\\C:\\work\\old', // cwd 는 대부분 접두어 포함(118/123)
    title: '이전 제목',
    sandbox_policy: JSON.stringify({ mode: 'workspace-write', writable_roots: ['\\\\?\\C:\\work\\old', 'C:\\work\\old\\sub'], network_access: false }),
    approval_mode: 'on-request',
    tokens_used: 5,
    has_user_event: 0,
    archived: 0,
    archived_at: null,
    git_sha: 'abc',
    git_branch: 'main',
    git_origin_url: 'https://example.com/x',
    cli_version: '1.2.3',
    first_user_message: '이전 첫 메시지',
    agent_nickname: null,
    agent_role: null,
    memory_mode: 'enabled',
    model: 'gpt-5',
    reasoning_effort: 'medium',
    agent_path: null,
    created_at_ms: 1_000_000,
    updated_at_ms: 2_000_000,
    thread_source: 'user',
    preview: '이전 미리보기',
    recency_at: 2000,
    recency_at_ms: 2_000_000,
    history_mode: 'paginated',
    name: '이전 제목',
    is_pinned: 0,
    thread_section_id: null,
    section_position: null,
    section_entered_at_ms: null,
    project_id: 'proj-old',
    originator: 'vscode',
    daybreak_enabled: 0,
    creator_user_id: 'u1',
    creator_account_id: 'a1',
  });

  it('replaces the templated columns (rollout_path without prefix, cwd with prefix, has_user_event forced to 1), rewrites sandbox_policy paths, and leaves the template object untouched', () => {
    const t = template();
    const snapshot = JSON.parse(JSON.stringify(t));
    const longMessage = `이 세션은 Claude 의 '버그 수정' 에서 가져왔습니다\n\n${'가'.repeat(250)}`;

    const out = buildThreadRow(t, {
      threadId: 'new-thread',
      rolloutPath: 'C:\\home\\.codex\\sessions\\2026\\09\\29\\rollout-new.jsonl',
      cwd: 'C:\\work\\new',
      title: '[Claude] 새 제목',
      firstUserMessage: longMessage,
      nowMs: 5_000_000,
      projectId: 'proj-new',
      templateCwd: 'C:\\work\\old',
    });

    expect(out).toMatchObject({
      id: 'new-thread',
      rollout_path: 'C:\\home\\.codex\\sessions\\2026\\09\\29\\rollout-new.jsonl', // 접두어 없음
      cwd: '\\\\?\\C:\\work\\new', // 접두어 있음
      title: '[Claude] 새 제목',
      name: '[Claude] 새 제목',
      preview: longMessage.slice(0, 200),
      first_user_message: longMessage.slice(0, 200),
      created_at: 5000,
      updated_at: 5000,
      created_at_ms: 5_000_000,
      updated_at_ms: 5_000_000,
      recency_at_ms: 5_000_000,
      recency_at: 5000,
      tokens_used: 0,
      has_user_event: 1, // 템플릿은 0 이었지만 강제로 1
      archived: 0,
      archived_at: null,
      git_sha: null,
      git_branch: null,
      git_origin_url: null,
      history_mode: 'paginated', // legacy 로 쓰지 않는다
      thread_source: 'user',
      source: 'vscode',
      agent_nickname: null,
      agent_role: null,
      agent_path: null,
      is_pinned: 0,
      thread_section_id: null,
      section_position: null,
      section_entered_at_ms: null,
      project_id: 'proj-new',
      // 건드리지 않은 컬럼은 템플릿 그대로
      model_provider: 'openai',
      approval_mode: 'on-request',
      cli_version: '1.2.3',
      memory_mode: 'enabled',
      model: 'gpt-5',
      reasoning_effort: 'medium',
      originator: 'vscode',
      daybreak_enabled: 0,
      creator_user_id: 'u1',
      creator_account_id: 'a1',
    });

    expect(JSON.parse(out.sandbox_policy as string)).toEqual({
      mode: 'workspace-write',
      writable_roots: ['\\\\?\\C:\\work\\new', 'C:\\work\\new\\sub'],
      network_access: false,
    });

    expect(t).toEqual(snapshot); // 템플릿은 불변
  });

  it('replaces sandbox_policy paths case-insensitively even when the casing differs from the template cwd', () => {
    const rawPolicy = JSON.stringify({ writable_roots: ['c:\\WORK\\Old'] });
    const out = buildThreadRow(
      { sandbox_policy: rawPolicy },
      { threadId: 'n', rolloutPath: 'r', cwd: 'C:\\work\\new', title: 't', firstUserMessage: 'm', nowMs: 1, projectId: null, templateCwd: 'C:\\work\\old' },
    );
    expect(JSON.parse(out.sandbox_policy as string)).toEqual({ writable_roots: ['C:\\work\\new'] });
  });

  it('does not rewrite a sibling path that merely starts with the template cwd (sandbox_policy)', () => {
    const rawPolicy = JSON.stringify({ writable_roots: ['C:\\work', 'C:\\work-backup'] });
    const out = buildThreadRow(
      { sandbox_policy: rawPolicy },
      { threadId: 'n', rolloutPath: 'r', cwd: 'C:\\new', title: 't', firstUserMessage: 'm', nowMs: 1, projectId: null, templateCwd: 'C:\\work' },
    );
    expect(JSON.parse(out.sandbox_policy as string)).toEqual({ writable_roots: ['C:\\new', 'C:\\work-backup'] });
  });

  it('never introduces a column absent from the template', () => {
    const out = buildThreadRow(
      { id: 'tpl', source: 'vscode', cwd: 'C:\\old' },
      { threadId: 'n', rolloutPath: 'r', cwd: 'C:\\new', title: 't', firstUserMessage: 'm', nowMs: 1, projectId: null, templateCwd: 'C:\\old' },
    );
    expect(Object.keys(out).sort()).toEqual(['cwd', 'id', 'source'].sort());
  });

  it('throws when the sandbox_policy after substitution is not valid JSON', () => {
    expect(() =>
      buildThreadRow(
        { sandbox_policy: '{not valid json' },
        { threadId: 'n', rolloutPath: 'r', cwd: 'C:\\new', title: 't', firstUserMessage: 'm', nowMs: 1, projectId: null, templateCwd: 'C:\\old' },
      ),
    ).toThrow();
  });
});

describe('writeCodexSession', () => {
  async function setupTemplate(cwd = 'C:\\work\\proj') {
    const templateRollout = await writeRollout(p, 'rollout-template.jsonl', [
      {
        ordinal: 0,
        timestamp: '2026-09-01T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'tpl-thread',
          session_id: 'tpl-thread',
          timestamp: '2026-09-01T00:00:00.000Z',
          cwd: `\\\\?\\${cwd}`,
          originator: 'vscode',
          cli_version: '1.2.3',
          model_provider: 'openai',
          base_instructions: '너는 Codex 다.',
          history_mode: 'paginated',
          context_window: { window_id: 'tpl-window' },
        },
      },
      {
        ordinal: 1,
        timestamp: '2026-09-01T00:00:00.000Z',
        type: 'turn_context',
        payload: { cwd, model: 'gpt-5', approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' } },
      },
      {
        ordinal: 2,
        timestamp: '2026-09-01T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '템플릿 자신의 대화 - 복사되면 안 됨' }] },
      },
    ]);
    const db = codexStateDb(p);
    db.prepare(
      `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, archived, git_branch,
         cli_version, sandbox_policy, approval_mode, history_mode, name, preview, first_user_message, created_at_ms,
         updated_at_ms, recency_at, recency_at_ms, tokens_used, project_id, has_user_event)
       VALUES (@id, @rollout_path, @created_at, @updated_at, @source, @model_provider, @cwd, @title, @archived, @git_branch,
         @cli_version, @sandbox_policy, @approval_mode, @history_mode, @name, @preview, @first_user_message, @created_at_ms,
         @updated_at_ms, @recency_at, @recency_at_ms, @tokens_used, @project_id, @has_user_event)`,
    ).run({
      id: 'tpl-thread',
      rollout_path: templateRollout, // 실제 DB 는 대부분 접두어 없이 저장한다(23/123)
      created_at: 1000,
      updated_at: 2000,
      source: 'vscode',
      model_provider: 'openai',
      cwd: `\\\\?\\${cwd}`, // cwd 는 대부분 접두어를 포함한다(118/123)
      title: '이전 제목',
      archived: 0,
      git_branch: 'main',
      cli_version: '1.2.3',
      sandbox_policy: JSON.stringify({ mode: 'workspace-write', writable_roots: [cwd] }),
      approval_mode: 'on-request',
      history_mode: 'paginated',
      name: '이전 제목',
      preview: '이전 미리보기',
      first_user_message: '이전 첫 메시지',
      created_at_ms: 1_000_000,
      updated_at_ms: 2_000_000,
      recency_at: 2000,
      recency_at_ms: 2_000_000,
      tokens_used: 3,
      project_id: null,
      has_user_event: 0,
    });
    db.close();
    await writeFile(
      path.join(p.home, '.codex', 'session_index.jsonl'),
      jsonl({ id: 'tpl-thread', thread_name: '이전 제목', updated_at: '2026-09-01T00:00:00.000Z' }),
    );
    return { templateRollout, cwd };
  }

  it('writes a new paginated thread that round-trips through listCodexSessions/readCodexSession, resolves the project_id, and appends to session_index.jsonl', async () => {
    const { cwd } = await setupTemplate();
    const db = new Database(path.join(p.home, '.codex', 'state_5.sqlite')); // 재사용 - 같은 파일에 프로젝트 루트 추가
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p-shallow', '얕은 프로젝트', '{}', 0);
    db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p-shallow', 0, 'C:\\work');
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p-deep', '깊은 프로젝트', '{}', 1);
    db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p-deep', 0, 'C:\\work\\proj');
    db.close();

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    // 로컬 시간대와 무관하게 필드가 정확히 일치하도록 지역 생성자를 사용한다(월은 0-based).
    const now = () => new Date(2026, 8, 29, 3, 4, 5);

    const result = await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: '2026-09-01T00:00:00.000Z', cwd, now });

    expect(await exists(result.rolloutPath)).toBe(true);
    expect(path.basename(result.rolloutPath)).toBe(`rollout-2026-09-29T03-04-05-${result.threadId}.jsonl`);

    const raw = await readText(result.rolloutPath);
    expect(raw).not.toContain('복사되면 안 됨'); // 템플릿 자신의 대화는 절대 복사되지 않는다
    const rolloutLines = raw.trim().split('\n').map((l) => JSON.parse(l));
    rolloutLines.forEach((l, i) => expect(l.ordinal).toBe(i)); // ordinal 0 부터 순차 증가
    expect(rolloutLines[0].type).toBe('session_meta');
    expect(rolloutLines[0].payload.base_instructions).toBe('너는 Codex 다.');
    expect(rolloutLines[0].payload.history_mode).toBe('paginated');
    expect(rolloutLines[1].type).toBe('turn_context'); // 템플릿에 있었으므로 포함된다
    expect(rolloutLines.some((l) => l.type === 'event_msg' && l.payload.type === 'task_started')).toBe(true);
    expect(rolloutLines.some((l) => l.type === 'event_msg' && l.payload.type === 'task_complete')).toBe(true);

    // item_completed 가 없으면 앱의 히스토리 투영(thread_history_1.sqlite)이 비어 보인다(V7 실기기 검증) — 반드시 있어야 한다.
    const itemCompletedEvents = rolloutLines.filter((l) => l.type === 'event_msg' && l.payload.type === 'item_completed');
    expect(itemCompletedEvents).toHaveLength(2); // user 메시지 1개 + assistant 메시지 1개
    expect(itemCompletedEvents[0].payload).toMatchObject({ thread_id: result.threadId, item: { type: 'UserMessage', id: 'item-1' } });
    expect(typeof itemCompletedEvents[0].payload.item.client_id).toBe('string');
    expect(itemCompletedEvents[1].payload).toMatchObject({ thread_id: result.threadId, item: { type: 'AgentMessage', id: 'item-2', phase: 'final_answer' } });

    const { sessions } = listCodexSessions(p);
    const s = sessions.find((x) => x.sessionId === result.threadId);
    expect(s).toMatchObject({ tool: 'codex', title: '[Claude] 버그 수정', cwd, archived: false, file: result.rolloutPath });

    const read = await readCodexSession(result.rolloutPath, result.threadId);
    expect(read.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const notice = (read.messages[0]!.blocks[0] as { text: string }).text;
    expect(notice).toContain('이 세션은 Claude');
    expect(notice).toContain('고쳐줘');
    expect(read.messages[1]!.blocks).toEqual([{ kind: 'text', text: '고쳤어요' }]);

    const indexLines = (await readText(path.join(p.home, '.codex', 'session_index.jsonl'))).trim().split('\n');
    expect(indexLines).toHaveLength(2);
    const addedIndex = JSON.parse(indexLines[1]!);
    expect(addedIndex).toMatchObject({ id: result.threadId, thread_name: '[Claude] 버그 수정' });
    expect(addedIndex.updated_at).toBe(now().toISOString()); // ISO 문자열

    const verifyDb = new Database(path.join(p.home, '.codex', 'state_5.sqlite'), { readonly: true });
    const row = verifyDb.prepare('SELECT * FROM threads WHERE id = ?').get(result.threadId) as Record<string, unknown>;
    verifyDb.close();
    expect(row.project_id).toBe('p-deep'); // 가장 깊은(구체적인) 루트가 우선
    expect(row.source).toBe('vscode');
    expect(row.history_mode).toBe('paginated');
    expect(row.has_user_event).toBe(1);
    expect(row.cwd).toBe(`\\\\?\\${cwd}`); // cwd 는 접두어 포함
    expect(row.rollout_path).toBe(result.rolloutPath); // rollout_path 는 접두어 없음
    expect(row.sandbox_policy).toContain(cwd.replace(/\\/g, '\\\\'));
  });

  it('saves carried images as files under the app folder (so the app can show them), reads them back as image blocks, and removes them on rollback', async () => {
    const { cwd } = await setupTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const ir = fakeIr(cwd);
    ir.messages[0]!.blocks.push({ kind: 'image', mediaType: 'image/png', data: pngBase64(3840, 2160) }, { kind: 'image', mediaType: 'image/bmp', data: 'Qk0=' });
    const result = await writeCodexSession(p, tx, { ir, sourceCreatedAt: 'T', cwd });

    const file = path.join(p.appDataDir, 'images', 'codex', result.threadId, 'image-1.png');
    expect((await fs.readFile(file)).equals(Buffer.from(pngBase64(3840, 2160), 'base64'))).toBe(true); // Codex 는 큰 이미지도 받는다
    const raw = await readText(result.rolloutPath);
    expect(raw).toContain(JSON.stringify({ type: 'local_image', path: file }));
    const read = await readCodexSession(result.rolloutPath, result.threadId);
    const blocks = read.messages[0]!.blocks;
    expect(blocks).toContainEqual({ kind: 'image', mediaType: 'image/png', data: pngBase64(3840, 2160) });
    expect((blocks.find((b) => b.kind === 'text') as { text: string }).text.endsWith('고쳐줘\n[이미지]')).toBe(true); // BMP 는 표시만

    await tx.rollback();
    expect(await exists(file)).toBe(false);
  });

  it('writes a UNC cwd to threads.cwd as \\\\?\\UNC\\server\\share', async () => {
    const { cwd } = await setupTemplate();
    const unc = '\\\\srv\\share\\proj';
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeCodexSession(p, tx, { ir: fakeIr(unc), sourceCreatedAt: 'T', cwd: unc });
    expect(cwd).not.toBe(unc);
    const db = new Database(path.join(p.home, '.codex', 'state_5.sqlite'), { readonly: true });
    const row = db.prepare('SELECT cwd FROM threads WHERE id = ?').get(result.threadId) as { cwd: string };
    db.close();
    expect(row.cwd).toBe('\\\\?\\UNC\\srv\\share\\proj');
  });

  it('replaces session_index.jsonl via temp file + rename (no temp leftovers) and rollback restores the original', async () => {
    await setupTemplate();
    const indexFile = path.join(p.home, '.codex', 'session_index.jsonl');
    const original = await readText(indexFile);
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const renameSpy = vi.spyOn(fs, 'rename');
    try {
      await writeCodexSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', cwd: 'C:\\work\\proj' });
      const renamedToIndex = renameSpy.mock.calls.filter((c) => c[1] === indexFile);
      expect(renamedToIndex).toHaveLength(1);
      expect(String(renamedToIndex[0]![0])).toContain('.aab-tmp-');
    } finally {
      renameSpy.mockRestore();
    }
    const leftovers = (await fs.readdir(path.dirname(indexFile))).filter((f) => f.includes('.aab-tmp-'));
    expect(leftovers).toEqual([]);
    expect((await readText(indexFile)).split('\n').filter(Boolean)).toHaveLength(2);

    await tx.rollback();
    expect(await readText(indexFile)).toBe(original);
  });

  it('retries the session_index rename on EPERM up to 3 attempts, then fails without leaving temp files', async () => {
    await setupTemplate();
    const indexFile = path.join(p.home, '.codex', 'session_index.jsonl');
    const realRename = fs.rename.bind(fs);
    const busy = () => Object.assign(new Error('busy'), { code: 'EPERM' });

    let calls = 0;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (a, b) => {
      if (String(b) === indexFile && ++calls <= 2) throw busy();
      return realRename(a, b);
    });
    try {
      const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
      await writeCodexSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', cwd: 'C:\\work\\proj' });
      expect(calls).toBe(3);
      expect((await readText(indexFile)).split('\n').filter(Boolean)).toHaveLength(2);
      await tx.rollback();

      calls = -100; // 항상 실패
      spy.mockImplementation(async (a, b) => {
        if (String(b) === indexFile) { calls++; throw busy(); }
        return realRename(a, b);
      });
      const tx2 = new FsTransaction(path.join(p.appDataDir, 'backups'));
      await expect(writeCodexSession(p, tx2, { ir: fakeIr(), sourceCreatedAt: 'T', cwd: 'C:\\work\\proj' })).rejects.toThrow('busy');
      expect(calls).toBe(-97);
      await tx2.rollback();
    } finally {
      spy.mockRestore();
    }
    expect((await fs.readdir(path.dirname(indexFile))).filter((f) => f.includes('.aab-tmp-'))).toEqual([]);
  });

  it('adds a trailing newline to session_index.jsonl before appending, even if the existing file lacked one', async () => {
    const { cwd } = await setupTemplate();
    // 개행 없이 끝나는 기존 인덱스 파일을 재현한다.
    await writeFile(path.join(p.home, '.codex', 'session_index.jsonl'), JSON.stringify({ id: 'tpl-thread', thread_name: '이전 제목', updated_at: '2026-09-01T00:00:00.000Z' }));

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd });

    const content = await readText(path.join(p.home, '.codex', 'session_index.jsonl'));
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0]!)).not.toThrow(); // 첫 줄이 두 번째 줄과 섞이지 않았다
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: result.threadId });
  });

  it('creates session_index.jsonl when it does not exist yet, and removes it again on rollback', async () => {
    const { cwd } = await setupTemplate();
    const indexFile = path.join(p.home, '.codex', 'session_index.jsonl');
    await fs.rm(indexFile);

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd });

    const content = await readText(indexFile);
    expect(content.endsWith('\n')).toBe(true);
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: result.threadId });

    await tx.rollback();
    expect(await exists(indexFile)).toBe(false); // 새로 만든 파일이므로 되돌리면 사라진다
  });

  // Codex 26.1013 사이드바는 프로젝트 루트 안의 cwd·프로젝트 지정·projectless-thread-ids 로만 스레드를 보여 준다 —
  // 어느 프로젝트에도 속하지 않는 폴더의 스레드는 projectless-thread-ids 에 넣어야 '프로젝트 없음'에 보인다.
  it("lists a thread whose folder is in no Codex project under projectless-thread-ids, and undoes it on rollback", async () => {
    const { cwd } = await setupTemplate('C:\\other\\app');
    const stateFile = path.join(p.home, '.codex', '.codex-global-state.json');
    const original = JSON.stringify({
      'local-projects': { 'local-1': { id: 'local-1', name: 'proj', rootPaths: ['C:\\work\\proj'] } },
      'projectless-thread-ids': ['old-chat'],
      'other-key': { keep: true },
    });
    await writeFile(stateFile, original);

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd });

    const state = JSON.parse(await readText(stateFile));
    expect(state['projectless-thread-ids']).toEqual(['old-chat', result.threadId]);
    expect(state['other-key']).toEqual({ keep: true });
    expect(listCodexSessions(p).sessions.find((s) => s.sessionId === result.threadId)).toMatchObject({ projectless: true });

    await tx.rollback();
    expect(await readText(stateFile)).toBe(original);
  });

  it('leaves the app state alone when the folder is inside a Codex project (the app groups it by folder)', async () => {
    const { cwd } = await setupTemplate('C:\\work\\proj\\sub');
    const stateFile = path.join(p.home, '.codex', '.codex-global-state.json');
    const original = JSON.stringify({ 'local-projects': { 'local-1': { id: 'local-1', name: 'proj', rootPaths: ['\\\\?\\C:\\work\\proj'] } } });
    await writeFile(stateFile, original);

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd });

    expect(await readText(stateFile)).toBe(original);
  });

  it('does not create the app state file when Codex has none', async () => {
    const { cwd } = await setupTemplate('C:\\other\\x');
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd });
    expect(await exists(path.join(p.home, '.codex', '.codex-global-state.json'))).toBe(false);
  });

  it('generates a time-ordered UUID v7 thread id by default', async () => {
    const { cwd } = await setupTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const nowMs = new Date(2026, 8, 29, 3, 4, 5).getTime();

    const result = await writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd, now: () => new Date(nowMs) });

    expect(result.threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const embeddedMs = parseInt(result.threadId.replace(/-/g, '').slice(0, 12), 16);
    expect(embeddedMs).toBe(nowMs);
  });

  it('prefers the vscode template row with the same cwd over a more recently updated one with a different cwd', async () => {
    await setupTemplate('C:\\work\\proj'); // updated_at 2000
    const db = new Database(path.join(p.home, '.codex', 'state_5.sqlite'));
    const otherRollout = await writeRollout(p, 'rollout-other.jsonl', [
      { ordinal: 0, timestamp: 't', type: 'session_meta', payload: { id: 'other', cwd: '\\\\?\\C:\\work\\other', originator: 'vscode', model_provider: 'anthropic', cli_version: '9.9.9' } },
    ]);
    db.prepare(
      `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy)
       VALUES ('other-thread', @rollout_path, 9000, 9999, 'vscode', 'anthropic', 'C:\\work\\other', '다른 스레드', '{}')`,
    ).run({ rollout_path: otherRollout });
    db.close();

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeCodexSession(p, tx, { ir: fakeIr('C:\\work\\proj'), sourceCreatedAt: 'T', cwd: 'C:\\work\\proj' });

    const raw = await readText(result.rolloutPath);
    const meta = JSON.parse(raw.trim().split('\n')[0]!);
    expect(meta.payload.model_provider).toBe('openai'); // C:\work\proj 템플릿(같은 cwd)에서 상속, 'other-thread' 아님
  });

  it('throws when there is no Codex state DB at all', async () => {
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    await expect(writeCodexSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', cwd: 'C:\\work\\proj' })).rejects.toThrow('Codex 에서 세션을 하나 만든 뒤 다시 시도하세요.');
    expect(await exists(path.join(p.home, '.codex', 'sessions'))).toBe(false);
  });

  it('throws when the state DB has no vscode thread', async () => {
    const db = codexStateDb(p);
    db.prepare("INSERT INTO threads (id, source, cwd) VALUES ('t1', 'cli', 'C:\\work\\proj')").run();
    db.close();

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    await expect(writeCodexSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', cwd: 'C:\\work\\proj' })).rejects.toThrow('Codex 에서 세션을 하나 만든 뒤 다시 시도하세요.');
  });

  it('rolls back the created rollout file and session_index line when the INSERT fails', async () => {
    const { cwd } = await setupTemplate();
    const db = new Database(path.join(p.home, '.codex', 'state_5.sqlite'));
    db.prepare("INSERT INTO threads (id, source, cwd) VALUES ('dup-id', 'other', 'C:\\work\\elsewhere')").run(); // id 선점 - UNIQUE 충돌 유도
    db.close();

    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const now = () => new Date(2026, 8, 29, 3, 4, 5);
    const rolloutPath = path.join(p.home, '.codex', 'sessions', '2026', '09', '29', 'rollout-2026-09-29T03-04-05-dup-id.jsonl');

    await expect(
      writeCodexSession(p, tx, { ir: fakeIr(cwd), sourceCreatedAt: 'T', cwd, now, uuid: () => 'dup-id' }),
    ).rejects.toThrow();

    expect(await exists(rolloutPath)).toBe(true); // tx.rollback 전에는 아직 남아있다
    const beforeRollbackIndex = (await readText(path.join(p.home, '.codex', 'session_index.jsonl'))).trim().split('\n');
    expect(beforeRollbackIndex).toHaveLength(2); // 새 줄이 추가된 상태

    await tx.rollback();

    expect(await exists(rolloutPath)).toBe(false);
    const afterRollbackIndex = (await readText(path.join(p.home, '.codex', 'session_index.jsonl'))).trim().split('\n');
    expect(afterRollbackIndex).toHaveLength(1); // 원복됨
  });
});
