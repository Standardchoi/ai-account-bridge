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

  it('gives index entries without cliSessionId distinct sessionIds and no transcript file', async () => {
    await writeFile(path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'local_ddd.json'),
      JSON.stringify({ sessionId: 'local_ddd', cwd: 'C:\\work\\a', title: 'D', createdAt: '1000', lastActivityAt: '2000', isArchived: false }));
    await writeFile(path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'local_eee.json'),
      JSON.stringify({ sessionId: 'local_eee', cwd: 'C:\\work\\b', title: 'E', createdAt: '1000', lastActivityAt: '2000', isArchived: false }));
    const list = listClaudeSessions(p);
    const byKey = Object.fromEntries(list.map((s) => [s.key, s]));
    expect(byKey['claude:code:local_ddd']).toMatchObject({ sessionId: 'local_ddd', file: '' });
    expect(byKey['claude:code:local_eee']).toMatchObject({ sessionId: 'local_eee', file: '' });
    expect(byKey['claude:code:local_ddd']!.sessionId).not.toBe(byKey['claude:code:local_eee']!.sessionId);
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
    const s = await readClaudeSession(f, 's1');
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

  it('keeps pasted base64 images as image blocks (before the text, as written) and marks other image sources', async () => {
    const f = path.join(p.home, 'img.jsonl');
    await writeFile(f, jsonl(
      { type: 'user', message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/PNG', data: 'iVBORw0KGgo=' } },
        { type: 'text', text: '이 화면 봐줘' },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }] } },
    ));
    const s = await readClaudeSession(f, 's-img');
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.blocks).toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
      { kind: 'text', text: '이 화면 봐줘' },
      { kind: 'text', text: '[이미지]' },
    ]);
  });

  it('drops synthetic command-wrapper user text as system context', async () => {
    const f = path.join(p.home, 'y.jsonl');
    await writeFile(f, jsonl(
      { type: 'user', message: { role: 'user', content: '<command-name>/foo</command-name>\n<command-message>bar</command-message>' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] } },
      { type: 'user', message: { role: 'user', content: '진짜 질문' } },
    ));
    const s = await readClaudeSession(f, 's2');
    expect(s.messages.map((m) => m.role)).toEqual(['user']);
    expect(s.messages[0]!.blocks).toEqual([{ kind: 'text', text: '진짜 질문' }]);
    expect(s.stats.droppedSystem).toBe(2);
  });

  it('reduces task notifications to a one-line note and strips the in-app browser context', async () => {
    const f = path.join(p.home, 'z.jsonl');
    const notice = '<task-notification>\n<task-id>ab62</task-id>\n<status>completed</status>\n<summary>Agent "Implement Task 8" finished</summary>\n<result>## Status: DONE\n긴 결과 본문</result>\n</task-notification>';
    await writeFile(f, jsonl(
      { type: 'user', message: { role: 'user', content: notice } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<status>failed</status>\n<summary>빌드 실패</summary>\n</task-notification>' }] } },
      { type: 'user', message: { role: 'user', content: '<in-app-browser-context source="ambient-ui-state">\nstate\n# In app browser:\n- url\n</in-app-browser-context>\n## My request:\n이 페이지 고쳐줘' } },
    ));
    const s = await readClaudeSession(f, 's3');
    expect(s.messages.flatMap((m) => m.blocks)).toEqual([
      { kind: 'text', text: '[백그라운드 작업 완료: Agent "Implement Task 8" finished]' },
      { kind: 'text', text: '[백그라운드 작업 실패: 빌드 실패]' },
      { kind: 'text', text: '이 페이지 고쳐줘' },
    ]);
    expect(s.stats.droppedSystem).toBe(3);
  });
});

describe('listClaudeSessions title fallback', () => {
  it('skips synthetic command-wrapper text when picking a CLI session title fallback', async () => {
    await writeFile(path.join(p.home, '.claude', 'projects', 'C--work-z', 'cli-9.jsonl'), jsonl(
      { type: 'user', cwd: 'C:\\work\\z', message: { role: 'user', content: '<command-name>/foo</command-name>' } },
      { type: 'user', message: { role: 'user', content: '진짜 첫 질문' } },
    ));
    const list = listClaudeSessions(p);
    const s = list.find((x) => x.sessionId === 'cli-9');
    expect(s?.title).toBe('진짜 첫 질문');
  });

  it('skips task notifications and strips the in-app browser context in the title fallback', async () => {
    await writeFile(path.join(p.home, '.claude', 'projects', 'C--work-y', 'cli-8.jsonl'), jsonl(
      { type: 'user', cwd: 'C:\\work\\y', message: { role: 'user', content: '<task-notification>\n<summary>x</summary>\n</task-notification>' } },
      { type: 'user', message: { role: 'user', content: '<in-app-browser-context source="ambient-ui-state">\ns\n</in-app-browser-context>\n## My request:\n실제 첫 요청' } },
    ));
    const s = listClaudeSessions(p).find((x) => x.sessionId === 'cli-8');
    expect(s?.title).toBe('실제 첫 요청');
  });
});
