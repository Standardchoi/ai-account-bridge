import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IrSession } from '../../src/main/core/ir.js';
import { FsTransaction } from '../../src/main/infra/fs-transaction.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { listClaudeSessions, readClaudeSession } from '../../src/main/providers/claude/sessions.js';
import { buildClaudeIndex, buildClaudeTranscript, encodeProjectDir, forkClaudeSession, writeClaudeSession } from '../../src/main/providers/claude/writer.js';
import { pngBase64 } from '../helpers/fake-sessions.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
beforeEach(async () => {
  p = await tmpPaths();
});

const fakeIr = (): IrSession => ({
  tool: 'codex',
  sessionId: 'src-1',
  title: '버그 수정',
  cwd: 'C:\\work\\app',
  model: 'gpt-5',
  messages: [
    { role: 'user', timestamp: '2026-09-01T00:00:01.000Z', blocks: [{ kind: 'text', text: '고쳐줘' }] },
    { role: 'assistant', timestamp: '2026-09-01T00:00:02.000Z', blocks: [{ kind: 'text', text: '고쳤어요' }] },
  ],
  stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transcriptObjects = async (file: string): Promise<any[]> =>
  (await readText(file))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

describe('encodeProjectDir', () => {
  it('normalizes the \\\\?\\ prefix and replaces non-alphanumeric characters with -', () => {
    expect(encodeProjectDir('\\\\?\\C:\\Users\\a b\\x')).toBe('C--Users-a-b-x');
  });
});

describe('buildClaudeTranscript', () => {
  it('builds user/assistant lines with a parentUuid chain and a trailing custom-title line, all JSON-parseable', () => {
    let n = 0;
    const uuid = () => `uuid-${++n}`;
    const now = () => '2026-09-01T00:00:05.000Z';
    const lines = buildClaudeTranscript(
      [
        { role: 'user', text: '질문', timestamp: '2026-09-01T00:00:00.000Z' },
        { role: 'assistant', text: '답변' },
      ],
      'claude-x',
      { sessionId: 'cli-1', cwd: 'C:\\work\\app', version: '2.1.247', gitBranch: 'main', title: '[Codex] 버그 수정', now, uuid },
    );

    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));

    expect(parsed[0]).toMatchObject({
      type: 'user',
      parentUuid: null,
      isSidechain: false,
      uuid: 'uuid-1',
      timestamp: '2026-09-01T00:00:00.000Z',
      userType: 'external',
      entrypoint: 'claude-desktop',
      cwd: 'C:\\work\\app',
      sessionId: 'cli-1',
      version: '2.1.247',
      gitBranch: 'main',
      promptId: 'uuid-2', // uuid() 로 만든 별도 id
      message: { role: 'user', content: '질문' },
    });

    expect(parsed[1]).toMatchObject({
      type: 'assistant',
      parentUuid: 'uuid-1', // 직전 줄의 uuid
      uuid: 'uuid-3',
      timestamp: '2026-09-01T00:00:05.000Z', // 원래 timestamp 없어서 now()
      message: {
        model: 'claude-x',
        id: 'msg_uuid3', // 'msg_' + 대시 없는 uuid
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '답변' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0,
          service_tier: 'standard', cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
    expect(parsed[1]).not.toHaveProperty('promptId');

    expect(parsed[2]).toEqual({ type: 'custom-title', customTitle: '[Codex] 버그 수정', sessionId: 'cli-1' });
  });

  it('falls back to model "imported" and gitBranch "HEAD" (as in real lines outside a named branch) when not given', () => {
    const lines = buildClaudeTranscript([{ role: 'user', text: 'x', timestamp: 't' }], undefined, {
      sessionId: 's', cwd: 'c', version: 'v', title: 'T', now: () => 'now', uuid: () => 'u1',
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({ gitBranch: 'HEAD' });
  });

  it('builds message ids from the uuid without dashes and gives every user line its own promptId', () => {
    let n = 0;
    const uuid = () => `aaaaaaaa-bbbb-cccc-dddd-${String(++n).padStart(12, '0')}`;
    const lines = buildClaudeTranscript(
      [{ role: 'user', text: 'a', timestamp: 't' }, { role: 'assistant', text: 'b', timestamp: 't' }, { role: 'user', text: 'c', timestamp: 't' }],
      'claude-x',
      { sessionId: 's', cwd: 'c', version: 'v', title: 'T', now: () => 'now', uuid },
    );
    const [u1, a1, u2] = lines.slice(0, 3).map((l) => JSON.parse(l));
    expect(a1.message.id).toBe(`msg_${a1.uuid.replace(/-/g, '')}`);
    expect(a1.message.id).not.toContain('-');
    expect(u1.promptId).toMatch(/^[0-9a-f-]+$/);
    expect(u1.promptId).not.toBe(u2.promptId);
    expect(u1.promptId).not.toBe(u1.uuid);
  });

  it('writes user images as base64 image blocks before the text (as Claude Code does), and image-only messages with no text block', () => {
    const img = { mediaType: 'image/png', data: pngBase64(10, 10) };
    const lines = buildClaudeTranscript(
      [{ role: 'user', text: '봐줘', images: [img], timestamp: 't' }, { role: 'assistant', text: 'ok', timestamp: 't' }, { role: 'user', text: '', images: [img], timestamp: 't' }],
      'claude-x',
      { sessionId: 's', cwd: 'c', version: 'v', title: 'T', now: () => 'now', uuid: () => 'u' },
    );
    const [u1, , u2] = lines.map((l) => JSON.parse(l));
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.data } };
    expect(u1.message.content).toEqual([block, { type: 'text', text: '봐줘' }]);
    expect(u2.message.content).toEqual([block]);
  });
});

describe('buildClaudeIndex', () => {
  const base = { indexId: 'local_new', cliSessionId: 'cli-new', cwd: 'C:\new', title: 'New Title', nowMs: 5000, turns: 4 };
  const template = () => ({
    sessionId: 'local_old', cliSessionId: 'cli-old', cwd: 'C:\old', title: 'Old',
    createdAt: '1000', lastActivityAt: '2000', lastFocusedAt: '3000',
    originCwd: 'C:\old', titleSource: 'ai', isArchived: true, completedTurns: 2,
    emailAddress: 'a@x.com',
  });

  const ALLOWLIST = [
    'sessionId', 'cliSessionId', 'cwd', 'originCwd', 'createdAt', 'lastActivityAt', 'lastFocusedAt', 'model', 'effort',
    'isArchived', 'title', 'titleSource', 'permissionMode', 'enabledMcpTools', 'remoteMcpServersConfig', 'completedTurns',
    'alwaysAllowedReasons', 'sessionPermissionUpdates',
  ].sort();

  it('replaces the templated fields and keeps the template timestamp types, without mutating the template', () => {
    const t = template();
    const snapshot = JSON.parse(JSON.stringify(t));

    const out = buildClaudeIndex(t, base);

    expect(out).toEqual({
      sessionId: 'local_new', cliSessionId: 'cli-new', cwd: 'C:\new', originCwd: 'C:\new', title: 'New Title',
      createdAt: '5000', lastActivityAt: '5000', lastFocusedAt: '5000', // 템플릿이 문자열 → 문자열로 유지
      titleSource: 'user', isArchived: false, completedTurns: 4, permissionMode: 'default',
      enabledMcpTools: {}, remoteMcpServersConfig: [], alwaysAllowedReasons: [], sessionPermissionUpdates: [],
    }); // emailAddress 같은 허용목록 밖 필드는 제외된다
    expect(t).toEqual(snapshot); // 원본 템플릿은 변경되지 않는다
  });

  it('keeps numeric template timestamps numeric', () => {
    const out = buildClaudeIndex({ createdAt: 1000, lastActivityAt: 2000, lastFocusedAt: 3000 }, { ...base, nowMs: 42 });
    expect(out.createdAt).toBe(42);
    expect(out.lastActivityAt).toBe(42);
    expect(out.lastFocusedAt).toBe(42);
  });

  it('always sets the identity, timestamp and reset fields even when the template lacks them', () => {
    const out = buildClaudeIndex({}, { indexId: 'local_y', cliSessionId: 'cli-y', cwd: 'C:\y', title: 'T2', nowMs: 9, turns: 1 });
    expect(out).toEqual({
      sessionId: 'local_y', cliSessionId: 'cli-y', cwd: 'C:\y', originCwd: 'C:\y', title: 'T2',
      createdAt: 9, lastActivityAt: 9, lastFocusedAt: 9,
      titleSource: 'user', isArchived: false, completedTurns: 1, permissionMode: 'default',
      enabledMcpTools: {}, remoteMcpServersConfig: [], alwaysAllowedReasons: [], sessionPermissionUpdates: [],
    });
    // model/effort 는 템플릿에 있을 때만 복사한다
    expect(out).not.toHaveProperty('model');
    expect(out).not.toHaveProperty('effort');
  });

  it('outputs exactly the allowlisted keys, dropping every other template field', () => {
    const t: Record<string, unknown> = {
      ...template(), model: 'claude-x', effort: 'high', enabledMcpTools: { a: true }, remoteMcpServersConfig: [{ id: 1 }],
      permissionMode: 'bypassPermissions', alwaysAllowedReasons: ['r'], sessionPermissionUpdates: [{ u: 1 }],
      postTurnSummary: 's', promptSuggestion: 'p', sessionSettings: {}, envScopeId: 'e', chromePermissionMode: 'ask',
      sshConfig: { host: 'x' }, cuAllowedApps: [], systemPrompt: 'sp', lastAssistantUuid: 'u', forkedFromSessionId: 'f',
    };

    const out = buildClaudeIndex(t, base);

    expect(Object.keys(out).sort()).toEqual(ALLOWLIST);
    expect(out).toMatchObject({ model: 'claude-x', effort: 'high', enabledMcpTools: { a: true }, remoteMcpServersConfig: [{ id: 1 }] });
  });

  it('resets permission state to safe defaults regardless of the template', () => {
    const out = buildClaudeIndex(
      { permissionMode: 'bypassPermissions', alwaysAllowedReasons: ['r'], sessionPermissionUpdates: [{ u: 1 }], titleSource: 'ai', isArchived: true },
      base,
    );
    expect(out).toMatchObject({
      permissionMode: 'default', alwaysAllowedReasons: [], sessionPermissionUpdates: [], titleSource: 'user', isArchived: false, completedTurns: 4,
    });
  });

  it('keeps the template model (never overridden by the source tool)', () => {
    expect(buildClaudeIndex({ model: 'claude-old' }, base).model).toBe('claude-old');
  });

  it('keeps remoteMcpServersConfig from the template by default and clears it with clearRemoteMcp', () => {
    const t = { enabledMcpTools: { a: true }, remoteMcpServersConfig: [{ id: 1 }] };
    expect(buildClaudeIndex(t, base)).toMatchObject({ enabledMcpTools: { a: true }, remoteMcpServersConfig: [{ id: 1 }] });
    expect(buildClaudeIndex(t, { ...base, clearRemoteMcp: true })).toMatchObject({ enabledMcpTools: { a: true }, remoteMcpServersConfig: [] });
  });

  it('does not share nested values with the template, and enabledMcpTools is a name-to-boolean object (as in real files), never an array', () => {
    const t = { enabledMcpTools: { a: true } };
    const out = buildClaudeIndex(t, base);
    (out.enabledMcpTools as Record<string, boolean>).b = true;
    expect(t.enabledMcpTools).toEqual({ a: true });
    expect(buildClaudeIndex({ enabledMcpTools: ['legacy'] }, base).enabledMcpTools).toEqual({});
  });
});

describe('writeClaudeSession', () => {
  const A = 'acct-1', O = 'org-1';

  async function writeTemplate() {
    await writeFile(
      path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'local_template.json'),
      JSON.stringify({
        sessionId: 'local_template', cliSessionId: 'cli-template', cwd: 'C:\\old', title: 'old',
        createdAt: '1000', lastActivityAt: '2000', lastFocusedAt: '2000',
        originCwd: 'C:\\old', titleSource: 'ai', isArchived: false, completedTurns: 0,
        model: 'claude-template', permissionMode: 'bypassPermissions', sshConfig: { host: 'x' },
        enabledMcpTools: { 'tool-a': true }, remoteMcpServersConfig: [{ id: 'srv' }], postTurnSummary: 'x',
      }),
    );
  }

  it('creates a transcript and index file that round-trip through listClaudeSessions/readClaudeSession', async () => {
    await writeTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    let n = 0;
    const uuid = () => `uuid-${++n}`;
    const now = () => new Date('2026-09-02T00:00:00.000Z');

    const result = await writeClaudeSession(p, tx, {
      ir: fakeIr(), sourceCreatedAt: '2026-09-01T00:00:00.000Z', account: { accountId: A, orgId: O }, cwd: 'C:\\work\\app', now, uuid,
    });

    expect(await exists(result.transcriptPath)).toBe(true);
    expect(await exists(result.indexPath)).toBe(true);
    expect(result.transcriptPath.endsWith(path.join('C--work-app', `${result.cliSessionId}.jsonl`))).toBe(true);

    const sessions = listClaudeSessions(p);
    const s = sessions.find((x) => x.sessionId === result.cliSessionId);
    expect(s).toMatchObject({ tool: 'claude', kind: 'code', title: '[Codex] 버그 수정', cwd: 'C:\\work\\app', accountRef: { accountId: A, orgId: O } });
    expect(s!.file).toBe(result.transcriptPath);

    const read = await readClaudeSession(result.transcriptPath, result.cliSessionId);
    expect(read.title).toBe('[Codex] 버그 수정'); // custom-title 줄에서 복원
    expect(read.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(read.messages[0]!.blocks[0]).toMatchObject({ kind: 'text' });
    const noticeAndFirst = (read.messages[0]!.blocks[0] as { text: string }).text;
    expect(noticeAndFirst).toContain('이 세션은 Codex');
    expect(noticeAndFirst).toContain('고쳐줘');
    expect(read.messages[1]!.blocks).toEqual([{ kind: 'text', text: '고쳤어요' }]);

    const index = JSON.parse(await readText(result.indexPath));
    expect(index).toMatchObject({ sessionId: result.indexId, cliSessionId: result.cliSessionId, cwd: 'C:\\work\\app', title: '[Codex] 버그 수정', titleSource: 'user', isArchived: false, model: 'claude-template', permissionMode: 'default' });
    expect(index).not.toHaveProperty('sshConfig'); // 템플릿의 원격 신원 필드는 제거된다
    expect(index).not.toHaveProperty('postTurnSummary');
    expect(index).toMatchObject({ enabledMcpTools: { 'tool-a': true }, remoteMcpServersConfig: [{ id: 'srv' }], alwaysAllowedReasons: [], sessionPermissionUpdates: [] }); // 같은 계정이므로 MCP 설정은 유지
  });

  it('carries source images Claude accepts and leaves a marker for one it could reject (over 2000px), round-tripping through readClaudeSession', async () => {
    await writeTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const ir = fakeIr();
    ir.messages[0]!.blocks.push({ kind: 'image', mediaType: 'image/png', data: pngBase64(1280, 720) }, { kind: 'image', mediaType: 'image/png', data: pngBase64(3840, 2160) });
    const result = await writeClaudeSession(p, tx, { ir, sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\\work\\app' });
    const first = (await transcriptObjects(result.transcriptPath)).find((o) => o.type === 'user');
    expect(first.message.content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64(1280, 720) } });
    expect(first.message.content[1].text.endsWith('고쳐줘\n[이미지]')).toBe(true);
    const read = await readClaudeSession(result.transcriptPath, result.cliSessionId);
    expect(read.messages[0]!.blocks[0]).toEqual({ kind: 'image', mediaType: 'image/png', data: pngBase64(1280, 720) });
  });

  it('uses the template Claude model (not the source Codex model) in the index and transcript assistant lines', async () => {
    await writeTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\\work\\app' });
    const index = JSON.parse(await readText(result.indexPath));
    expect(index.model).toBe('claude-template');
    const assistant = (await transcriptObjects(result.transcriptPath)).find((o) => o.type === 'assistant');
    expect(assistant.message.model).toBe('claude-template');
  });

  it('passes the source gitBranch into transcript lines, defaulting to HEAD', async () => {
    await writeTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const withBranch = await writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\work\app', gitBranch: 'feat/x' });
    expect((await transcriptObjects(withBranch.transcriptPath)).filter((o) => o.type === 'user' || o.type === 'assistant').map((o) => o.gitBranch)).toEqual(['feat/x', 'feat/x']);
    const without = await writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\work\app' });
    expect((await transcriptObjects(without.transcriptPath)).filter((o) => o.type === 'user').map((o) => o.gitBranch)).toEqual(['HEAD']);
  });

  it('falls back to claude-sonnet-4-5 in transcript assistant lines when the template has no model', async () => {
    await writeFile(
      path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'local_template.json'),
      JSON.stringify({ sessionId: 'local_template', cliSessionId: 'cli-template', cwd: 'C:\\old', title: 'old' }),
    );
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\\work\\app' });
    const assistant = (await transcriptObjects(result.transcriptPath)).find((o) => o.type === 'assistant');
    expect(assistant.message.model).toBe('claude-sonnet-4-5');
  });

  it('throws and creates nothing when the target account folder has no template index', async () => {
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    await expect(
      writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: 'no-such', orgId: 'org' }, cwd: 'C:\\x' }),
    ).rejects.toThrow();
    expect(await exists(path.join(p.home, '.claude', 'projects'))).toBe(false);
  });

  it('skips template files that fail JSON.parse and uses the newest valid one', async () => {
    const dir = path.join(p.appData, 'Claude', 'claude-code-sessions', A, O);
    await writeFile(path.join(dir, 'local_broken.json'), '{not json');
    await writeTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\\work\\app' });
    expect(await exists(result.indexPath)).toBe(true);
  });

  it('removes both created files after tx.rollback()', async () => {
    await writeTemplate();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await writeClaudeSession(p, tx, { ir: fakeIr(), sourceCreatedAt: 'T', account: { accountId: A, orgId: O }, cwd: 'C:\\work\\app' });

    await tx.rollback();

    expect(await exists(result.transcriptPath)).toBe(false);
    expect(await exists(result.indexPath)).toBe(false);
  });
});

describe('forkClaudeSession', () => {
  const A = 'acct-1', O = 'org-1', B = 'acct-2', O2 = 'org-2';

  async function setupSource() {
    const sourceTranscriptPath = path.join(p.home, '.claude', 'projects', 'C--work-app', 'cli-src.jsonl');
    await writeFile(
      sourceTranscriptPath,
      `${[
        JSON.stringify({ type: 'user', sessionId: 'cli-src', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'custom-title', customTitle: '제목', sessionId: 'cli-src' }),
        'not json',
      ].join('\n')}\n`,
    );
    const sourceIndexPath = path.join(p.appData, 'Claude', 'claude-code-sessions', A, O, 'local_src.json');
    await writeFile(
      sourceIndexPath,
      JSON.stringify({
        sessionId: 'local_src', cliSessionId: 'cli-src', cwd: 'C:\\work\\app', title: '제목',
        createdAt: '1000', lastActivityAt: '2000', completedTurns: 3,
        sshConfig: { host: 'x' }, permissionMode: 'bypassPermissions',
        enabledMcpTools: { 'tool-a': true }, remoteMcpServersConfig: [{ id: 'srv' }],
      }),
    );
    return { sourceTranscriptPath, sourceIndexPath };
  }

  it('forks the transcript with a new sessionId in every parseable line, leaves the original untouched, and writes a stripped index into the target folder', async () => {
    const { sourceTranscriptPath, sourceIndexPath } = await setupSource();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    let n = 0;
    const uuid = () => `uuid-${++n}`;
    const now = () => new Date('2026-09-03T00:00:00.000Z');

    const result = await forkClaudeSession(p, tx, { sourceIndexPath, sourceTranscriptPath, to: { accountId: B, orgId: O2 }, uuid, now });

    expect(result.cliSessionId).toBe('uuid-1');
    expect(result.indexId).toBe('local_uuid-2');
    expect(result.transcriptPath).toBe(path.join(path.dirname(sourceTranscriptPath), 'uuid-1.jsonl'));
    expect(result.transcriptPath).not.toBe(sourceTranscriptPath);

    const forkedLines = (await readText(result.transcriptPath)).split('\n');
    expect(JSON.parse(forkedLines[0]!)).toMatchObject({ sessionId: 'uuid-1', uuid: 'u1' }); // sessionId 만 바뀐다
    expect(JSON.parse(forkedLines[1]!)).toEqual({ type: 'custom-title', customTitle: '제목', sessionId: 'uuid-1' });
    expect(forkedLines[2]).toBe('not json'); // 파싱 안 되는 줄은 그대로 복사

    const originalLines = (await readText(sourceTranscriptPath)).split('\n');
    expect(JSON.parse(originalLines[0]!)).toMatchObject({ sessionId: 'cli-src' }); // 원본은 그대로

    expect(result.indexPath).toBe(path.join(p.appData, 'Claude', 'claude-code-sessions', B, O2, `${result.indexId}.json`));
    const index = JSON.parse(await readText(result.indexPath));
    expect(index).toMatchObject({ sessionId: result.indexId, cliSessionId: 'uuid-1', cwd: 'C:\\work\\app', title: '제목', completedTurns: 3, permissionMode: 'default' });
    expect(index).not.toHaveProperty('sshConfig'); // buildClaudeIndex 를 거치므로 원격 신원 필드는 딸려오지 않는다
    expect(index.enabledMcpTools).toEqual({ 'tool-a': true }); // 다른 계정으로 포크: 원격 MCP 서버 설정만 비운다
    expect(index.remoteMcpServersConfig).toEqual([]);
  });

  it('throws when the source transcript is missing', async () => {
    const { sourceIndexPath } = await setupSource();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    await expect(
      forkClaudeSession(p, tx, {
        sourceIndexPath,
        sourceTranscriptPath: path.join(p.home, '.claude', 'projects', 'C--work-app', 'missing.jsonl'),
        to: { accountId: B, orgId: O2 },
      }),
    ).rejects.toThrow();
  });

  it('removes both the forked transcript and index after tx.rollback(), leaving the original transcript in place', async () => {
    const { sourceTranscriptPath, sourceIndexPath } = await setupSource();
    const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
    const result = await forkClaudeSession(p, tx, { sourceIndexPath, sourceTranscriptPath, to: { accountId: B, orgId: O2 } });

    await tx.rollback();

    expect(await exists(result.transcriptPath)).toBe(false);
    expect(await exists(result.indexPath)).toBe(false);
    expect(await exists(sourceTranscriptPath)).toBe(true);
  });
});
