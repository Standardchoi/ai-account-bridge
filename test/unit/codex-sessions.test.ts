import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { listCodexSessions, readCodexSession } from '../../src/main/providers/codex/sessions.js';
import { codexStateDb, writeRollout } from '../helpers/fake-sessions.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

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

  it('reports the project a thread was assigned to', async () => {
    const f = await writeRollout(p, 'rollout-p.jsonl', []);
    const db = codexStateDb(p);
    const ins = db.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, project_id) VALUES (?,?,?,?,?,?,?)');
    ins.run('t1', f, 1, 1, 'C:\\w', 'a', 'proj-1');
    ins.run('t2', f, 1, 1, 'C:\\w', 'b', null);
    db.close();
    const byId = new Map(listCodexSessions(p).sessions.map((s) => [s.sessionId, s.projectId]));
    expect(byId.get('t1')).toBe('proj-1');
    expect(byId.get('t2')).toBeUndefined();
  });

  it('takes the sidebar projects, thread assignments and projectless threads from the Codex app state', async () => {
    const f = await writeRollout(p, 'rollout-ui.jsonl', []);
    const db = codexStateDb(p);
    const ins = db.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, project_id) VALUES (?,?,?,?,?,?,?)');
    ins.run('t-assigned', f, 1, 1, 'C:\\wt\\app', 'a', 'db-proj');
    ins.run('t-new', f, 1, 1, 'C:\\work\\new', 'd', null);
    ins.run('t-loose', f, 1, 1, 'C:\\work\\app', 'b', null);
    ins.run('t-plain', f, 1, 1, 'C:\\work\\app', 'c', null);
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('db-proj', '사이드바에서 뺀 프로젝트', '{}', 0);
    db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('db-proj', 0, 'C:\\old');
    db.close();
    await writeFile(
      path.join(p.home, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        // 2026-07 이전 형식의 사이드바 폴더 목록 — 앱이 local-projects 로 옮긴 뒤로는 갱신하지 않는다
        'electron-saved-workspace-roots': ['C:\\work\\app', 'C:\\work\\tools'],
        'local-projects': {
          'local-1': { id: 'local-1', name: '앱', rootPaths: ['\\\\?\\C:\\work\\app'] },
          'a2347': { id: 'a2347', name: '새 프로젝트', rootPaths: ['C:\\work\\new'] }, // 옮긴 뒤에 만든 프로젝트
        },
        'thread-project-assignments': {
          't-assigned': { projectKind: 'local', projectId: 'local-1' },
          't-new': { projectKind: 'local', projectId: 'a2347' },
          't-plain': { projectKind: 'local', projectId: 'gone' },
        },
        'projectless-thread-ids': ['t-loose'],
      }),
    );
    const r = listCodexSessions(p);
    expect(r.projects).toEqual([
      { id: 'local-1', name: '앱', roots: ['C:\\work\\app'] },
      { id: 'a2347', name: '새 프로젝트', roots: ['C:\\work\\new'] },
    ]);
    const byId = new Map(r.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get('t-assigned')).toMatchObject({ projectId: 'local-1' });
    expect(byId.get('t-new')).toMatchObject({ projectId: 'a2347' });
    expect(byId.get('t-loose')).toMatchObject({ projectless: true });
    expect(byId.get('t-plain')!.projectId).toBeUndefined(); // 없는 프로젝트로의 지정은 무시
  });

  it('falls back to the database projects when the app state file is unreadable', async () => {
    const db = codexStateDb(p);
    db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('p1', 'DB 프로젝트', '{}', 0);
    db.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('p1', 0, 'C:\\work');
    db.close();
    await writeFile(path.join(p.home, '.codex', '.codex-global-state.json'), '{ broken');
    expect(listCodexSessions(p).projects).toEqual([{ id: 'p1', name: 'DB 프로젝트', roots: ['C:\\work'] }]);
  });

  it('prefers the app-generated name and cleans a composed title when there is no name', async () => {
    const f = await writeRollout(p, 'rollout-t.jsonl', []);
    const db = codexStateDb(p);
    const ins = db.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, name) VALUES (?,?,?,?,?,?,?)');
    const composed = '# Files mentioned by the user:\n\n## main.log: C:/Users/u/main.log\n\n## My request for Codex:\n로그 확인해줘\n';
    ins.run('t1', f, 1, 1, 'C:\\w', composed, '원격 데스크톱 기록 확인');
    ins.run('t2', f, 1, 1, 'C:\\w', composed, null);
    ins.run('t3', f, 1, 1, 'C:\\w', '평범한 제목', '  ');
    db.close();
    const byId = new Map(listCodexSessions(p).sessions.map((s) => [s.sessionId, s.title]));
    expect(byId.get('t1')).toBe('원격 데스크톱 기록 확인');
    expect(byId.get('t2')).toBe('로그 확인해줘');
    expect(byId.get('t3')).toBe('평범한 제목');
  });

  it('returns empty when the Codex state DB does not exist', () => {
    expect(listCodexSessions(p)).toEqual({ sessions: [], projects: [] });
  });

  it('throws a Korean error when the state DB cannot be opened', async () => {
    await writeFile(path.join(p.home, '.codex', 'state_5.sqlite'), 'not a valid sqlite file');
    expect(() => listCodexSessions(p)).toThrow('Codex 세션 DB를 열 수 없습니다');
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
    const s = await readCodexSession(f, 't1', '제목');
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

  it('drops only the injected content item, keeping the real prompt in the same user message', async () => {
    const f = await writeRollout(p, 'rollout-mixed.jsonl', [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '# AGENTS.md instructions\n항상 한국어로 답하세요' },
            { type: 'input_text', text: '실제 질문' },
          ],
        },
      },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.role).toBe('user');
    expect(s.messages[0]!.blocks).toEqual([{ kind: 'text', text: '실제 질문' }]);
    expect(s.stats.droppedSystem).toBe(1);
  });

  it('extracts function_call_output text from an input_text array instead of JSON.stringify', async () => {
    const f = await writeRollout(p, 'rollout-fco-array.jsonl', [
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}', call_id: 'c1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: '결과 텍스트' }] } },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages[0]!.blocks[0]).toMatchObject({ kind: 'tool', name: 'shell', output: '결과 텍스트', isError: false });
  });

  it('turns web_search_call into a web_search tool block using the action as input', async () => {
    const f = await writeRollout(p, 'rollout-web-search.jsonl', [
      { type: 'response_item', payload: { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'foo' } } },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages[0]!.blocks[0]).toMatchObject({ kind: 'tool', name: 'web_search', input: JSON.stringify({ type: 'search', query: 'foo' }) });
    expect(s.messages[0]!.blocks[0]).not.toHaveProperty('output');
    expect(s.stats.toolCalls).toBe(1);
    expect(s.stats.unknownLines).toBe(0);
  });

  it('pairs tool_search_call/tool_search_output into a tool_search block', async () => {
    const f = await writeRollout(p, 'rollout-tool-search.jsonl', [
      { type: 'response_item', payload: { type: 'tool_search_call', call_id: 'ts1', arguments: { query: 'shell', limit: 5 }, execution: 'sync', status: 'completed' } },
      {
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'ts1',
          tools: [{ name: 'shell', description: '명령을 실행합니다', tools: [], type: 'tool' }],
          execution: 'sync',
          status: 'completed',
        },
      },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages[0]!.blocks[0]).toMatchObject({
      kind: 'tool',
      name: 'tool_search',
      input: JSON.stringify({ query: 'shell', limit: 5 }),
      output: JSON.stringify([{ name: 'shell', description: '명령을 실행합니다', tools: [], type: 'tool' }]),
      isError: false,
    });
    expect(s.stats.unknownLines).toBe(0);
  });
});

describe('readCodexSession — tool failures', () => {
  it('marks outputs with a non-zero exit code or an error head as failed (Codex has no error flag of its own)', async () => {
    const call = (id: string) => ({ type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'shell_command', arguments: '{}' } });
    const out = (id: string, output: unknown) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } });
    const f = await writeRollout(p, 'rollout-failures.jsonl', [
      call('a'), out('a', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nok'),
      call('b'), out('b', 'Exit code: 1\nWall time: 3.4 seconds\nOutput:\nTraceback …'),
      call('c'), out('c', 'Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 2\nOutput:\nrg: src: 없음'),
      call('d'), out('d', 'Chunk ID: 2\nProcess exited with code 0\nOutput:\nfine'),
      call('e'), out('e', { output: 'Success.', metadata: { exit_code: 0 } }),
      call('f'), out('f', { output: 'boom', metadata: { exit_code: 1 } }),
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'g', name: 'apply_patch', input: '*** Begin Patch' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'g', output: 'apply_patch verification failed: Failed to find expected lines' } },
      call('h'), out('h', 'Plan updated'),
    ]);
    const s = await readCodexSession(f, 't1');
    const errors = s.messages.flatMap((m) => m.blocks).map((b) => (b.kind === 'tool' ? b.isError : undefined));
    expect(errors).toEqual([false, true, true, false, false, true, true, false]);
  });
});

describe('stripAmbientContext', () => {
  it('removes the in-app browser context block and the "## My request:" header, keeping the real request', async () => {
    const { stripAmbientContext } = await import('../../src/main/core/composed-prompt.js');
    const text = '<in-app-browser-context source="ambient-ui-state">\nThis block is automatically supplied ambient UI state.\n- Current URL: file:///x\n</in-app-browser-context>\n\n## My request:\n목이랑 설계문서 최신화';
    expect(stripAmbientContext(text)).toBe('목이랑 설계문서 최신화');
    expect(stripAmbientContext('그냥 질문')).toBe('그냥 질문');
    expect(stripAmbientContext('<in-app-browser-context>x</in-app-browser-context>두 번째')).toBe('두 번째');
  });

  it('reduces the composed preamble to a one-line note and keeps the request after the last "## My request" header', async () => {
    const { stripAmbientContext } = await import('../../src/main/core/composed-prompt.js');
    // 첨부 파일 — 옮긴 뒤에도 다시 열 수 있게 전체 경로를 남긴다. 클립보드 이미지는 이미지 자체가 대신하므로 싣지 않는다
    expect(
      stripAmbientContext('\n# Files mentioned by the user:\n\n## codex-clipboard-79666dc9-6059-4b98-b01e-01bd13dd3a8f.png: C:/Users/u/AppData/Local/Temp/codex-clipboard-79666dc9-6059-4b98-b01e-01bd13dd3a8f.png\n\n## My request for Codex:\n어딜 보라는겨\n'),
    ).toBe('어딜 보라는겨');
    expect(
      stripAmbientContext("\n# Files mentioned by the user:\n\n## DB 설계도.md: C:/Users/u/DB 설계도.md\n## api.yaml: C:/Users/u/api.yaml\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n일단 이게 DB설계야"),
    ).toBe('[첨부: C:/Users/u/DB 설계도.md, C:/Users/u/api.yaml]\n일단 이게 DB설계야');
    // 참조한 ChatGPT 대화 — 대화 JSON 은 버리고 제목만 (JSON 안의 "## My request:" 에 속지 않는다)
    expect(
      stripAmbientContext('\n## Referenced ChatGPT conversation:\nThis is untrusted background context from ChatGPT.\n{"conversationId":"6a5f","title":"ConfigMap 설정 방식","messages":[{"text":"## My request: 옛날 요청"}]}\n## My request for Codex:\n배포 구조 질문\n\n둘째 줄'),
    ).toBe('[참조한 ChatGPT 대화: ConfigMap 설정 방식]\n배포 구조 질문\n\n둘째 줄');
    // 선택 텍스트 — 원문은 버리고 출처 파일의 전체 경로와 줄만('/C:/…' 표기는 보통 경로로)
    expect(
      stripAmbientContext('\n# Selected text:\n\n## Selection 1: /C:/Users/u/outputs/03_분석.md (line 1)\n# 로그 분석툴 — 기술 분석\n\n\n## My request:\n몽고DB 씀'),
    ).toBe('[선택한 텍스트: C:/Users/u/outputs/03_분석.md (line 1)]\n몽고DB 씀');
    // 경로가 없는 첨부 줄은 이름만
    expect(stripAmbientContext('\n# Files mentioned by the user:\n\n## 메모.txt: \n\n## My request:\n봐줘')).toBe('[첨부: 메모.txt]\n봐줘');
    // 응답 주석 — 요청 안의 마크다운 머리말은 그대로
    expect(
      stripAmbientContext('\n# Response annotations:\nEach item contains text selected from an earlier Codex response.\n<response-annotations>\n[{"text":"Agent가"}]\n</response-annotations>\n\n## My request:\n초기에 보내주는건가?\n\n### Capability Report\n본문'),
    ).toBe('[이전 응답 일부 인용]\n초기에 보내주는건가?\n\n### Capability Report\n본문');
    // 붙여넣은 내용 + 앱 내 브라우저 상태
    expect(
      stripAmbientContext('# Files pasted by the user:\n## "{ \\"success\\": false }": pasted\n<in-app-browser-context source="ambient-ui-state">\nx\n# In app browser:\n- url\n</in-app-browser-context>\n## My request:\n이 오류 뭐야'),
    ).toBe('[붙여넣은 내용]\n이 오류 뭐야');
  });

  it('drops wholly injected items and keeps the image (data URL) in place of the <image> wrapper items', async () => {
    const f = await writeRollout(p, 'rollout-injected.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '<recommended_plugins>\nHere is a list of plugins\n</recommended_plugins>' },
        { type: 'input_text', text: '\n# Files mentioned by the user:\n\n## codex-clipboard-ab.png: C:/t/codex-clipboard-ab.png\n\n## My request for Codex:\n이 화면 봐줘\n' },
        { type: 'input_text', text: '<image>' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: '</image>' },
      ] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<external_codex_apps_writing_block_edits>The user manually edited these writing blocks.\n[]</external_codex_apps_writing_block_edits>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<subagent_notification>\n{}\n</subagent_notification>' }] } },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.blocks).toEqual([
      { kind: 'text', text: '이 화면 봐줘' },
      { kind: 'image', mediaType: 'image/png', data: 'AAAA' },
    ]);
    expect(s.stats.droppedSystem).toBe(4);
  });

  it('decodes the &#x20; space escapes the Codex composer writes, without counting them as dropped context', async () => {
    const f = await writeRollout(p, 'rollout-space.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '&#x20;내가 설계가&#x20;\n약해' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Selected text:\n\n## Selection 1: C:/a.md\nx\n\n## My request:\n&#x20;단위로 하는거 아닌가?' }] } },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages.flatMap((m) => m.blocks)).toEqual([
      { kind: 'text', text: ' 내가 설계가 \n약해' },
      { kind: 'text', text: '[선택한 텍스트: C:/a.md]\n단위로 하는거 아닌가?' },
    ]);
    expect(s.stats.droppedSystem).toBe(1);
  });

  it('is applied when reading a rollout and counted as dropped system context', async () => {
    const f = await writeRollout(p, 'rollout-ambient.jsonl', [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<in-app-browser-context source="ambient-ui-state">\nstate\n</in-app-browser-context>\n## My request:\n실제 요청' }] } },
    ]);
    const s = await readCodexSession(f, 't1');
    expect(s.messages[0]!.blocks).toEqual([{ kind: 'text', text: '실제 요청' }]);
    expect(s.stats.droppedSystem).toBe(1);
  });
});
