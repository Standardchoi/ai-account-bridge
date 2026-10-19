import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AppDb } from '../../src/main/infra/app-db.js';
import { BackupStore } from '../../src/main/infra/backup-store.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { encodeProjectDir } from '../../src/main/providers/claude/writer.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { AccountService } from '../../src/main/services/account-service.js';
import { ImportService } from '../../src/main/services/import-service.js';
import { LibraryService } from '../../src/main/services/library-service.js';
import { SwitchService, type SwitchPrompts } from '../../src/main/services/switch-service.js';
import { codexStateDb, jsonl, writeRollout } from '../helpers/fake-sessions.js';
import { FakeProcs } from '../helpers/fake-procs.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

const CODEX_APP_PATH = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
const CLAUDE_APP_PATH = 'C:\\Program Files\\WindowsApps\\Claude_1.2.3.0_x64__pzs8sxrjxfjjc\\Claude.exe';

let p: PathProvider;
let db: AppDb;
let library: LibraryService;
let switcher: SwitchService;
let svc: ImportService;
let procs: FakeProcs;
let gitStatus: Mock<(dir: string) => Promise<string[] | undefined>>;
const backupsDir = () => path.join(p.appDataDir, 'backups');

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  const providers = { codex: codexAuthProvider(p), claude: claudeAuthProvider(p) };
  const secrets = fakeSecretStore();
  const accounts = new AccountService({ db, secrets, paths: p, providers });
  procs = new FakeProcs();
  const prompts: { [K in keyof SwitchPrompts]: Mock<SwitchPrompts[K]> } = {
    confirmKill: vi.fn<SwitchPrompts['confirmKill']>(async () => true),
    confirmSaveUnknown: vi.fn<SwitchPrompts['confirmSaveUnknown']>(async () => null),
    confirmStrayCli: vi.fn<SwitchPrompts['confirmStrayCli']>(async () => true),
  };
  switcher = new SwitchService({
    accounts, db, providers, procs, prompts,
    backups: new BackupStore(backupsDir(), secrets),
    closeTimeoutMs: 0,
    sleep: async () => {},
    launchTimeoutMs: 1000,
    pollMs: 100,
  });
  library = new LibraryService({ paths: p, db });
  gitStatus = vi.fn<(dir: string) => Promise<string[] | undefined>>(async () => []);
  svc = new ImportService({ paths: p, db, library, switcher, backupsDir: backupsDir(), now: () => new Date('2026-09-29T00:00:00.000Z'), repoStatus: gitStatus });
  await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
});

// --- 픽스처 ---

async function makeCodexSource(id: string, cwd: string, createdAtSec: number): Promise<void> {
  const rollout = await writeRollout(p, `${id}.jsonl`, [
    { type: 'session_meta', payload: { cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '질문입니다' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '답변입니다' }] } },
  ]);
  const dbFile = path.join(p.home, '.codex', 'state_5.sqlite');
  const sdb = existsSync(dbFile) ? new Database(dbFile) : codexStateDb(p);
  sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, rollout, createdAtSec, createdAtSec, 'vscode', cwd, '원본 제목', 0);
  sdb.close();
}

async function makeCodexTemplate(cwd: string): Promise<void> {
  const templateRollout = await writeRollout(p, 'rollout-template.jsonl', [
    {
      ordinal: 0, timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta',
      payload: {
        id: 'tpl-thread', session_id: 'tpl-thread', timestamp: '2026-09-01T00:00:00.000Z', cwd: `\\\\?\\${cwd}`,
        originator: 'vscode', cli_version: '1.2.3', model_provider: 'openai', base_instructions: '너는 Codex 다.', history_mode: 'paginated',
      },
    },
  ]);
  const dbFile = path.join(p.home, '.codex', 'state_5.sqlite');
  const sdb = existsSync(dbFile) ? new Database(dbFile) : codexStateDb(p);
  sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
    .run('tpl-thread', templateRollout, 1000, 2000, 'vscode', cwd, '이전 제목', 0);
  sdb.close();
  await writeFile(path.join(p.home, '.codex', 'session_index.jsonl'), jsonl({ id: 'tpl-thread', thread_name: '이전 제목', updated_at: '2026-09-01T00:00:00.000Z' }));
}

async function makeClaudeTemplate(accountId: string, orgId: string): Promise<void> {
  await writeFile(
    path.join(p.appData, 'Claude', 'claude-code-sessions', accountId, orgId, 'local_template.json'),
    JSON.stringify({
      sessionId: 'local_template', cliSessionId: 'cli-template', cwd: 'C:\\old', title: 'old',
      createdAt: '1000', lastActivityAt: '2000', lastFocusedAt: '2000',
      originCwd: 'C:\\old', titleSource: 'ai', isArchived: false, completedTurns: 0,
    }),
  );
}

async function makeClaudeCodeSource(
  accountId: string, orgId: string, indexId: string, cliId: string, cwd: string, title: string, createdAtMs: string,
): Promise<{ transcriptPath: string; indexPath: string }> {
  const transcriptPath = path.join(p.home, '.claude', 'projects', encodeProjectDir(cwd), `${cliId}.jsonl`);
  await writeFile(
    transcriptPath,
    jsonl(
      { type: 'user', cwd, sessionId: cliId, message: { role: 'user', content: '질문입니다' } },
      { type: 'assistant', sessionId: cliId, message: { role: 'assistant', content: [{ type: 'text', text: '답변입니다' }] } },
    ),
  );
  const indexPath = path.join(p.appData, 'Claude', 'claude-code-sessions', accountId, orgId, `${indexId}.json`);
  await writeFile(
    indexPath,
    JSON.stringify({ sessionId: indexId, cliSessionId: cliId, cwd, title, createdAt: createdAtMs, lastActivityAt: createdAtMs, isArchived: false }),
  );
  return { transcriptPath, indexPath };
}

describe('ImportService — 도구 실행 기록(fullToolLog)', () => {
  const claudeTarget = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };

  it('summarises tool calls by default and moves them in full only when asked, in both directions', async () => {
    const rollout = await writeRollout(p, 'codex-tools.jsonl', [
      { type: 'session_meta', payload: { cwd: 'C:\\work\\proj' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '테스트 돌려 줘' }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell_command', arguments: JSON.stringify({ command: 'npm test' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 0\nOutput:\n테스트 출력 원문' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '모두 통과했어요' }] } },
    ]);
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run('codex-tools', rollout, 1000, 1000, 'vscode', 'C:\\work\\proj', '도구 대화', 0);
    sdb.close();
    await makeClaudeTemplate('acct-A', 'org-A');
    const transcript = (id: string) => readText(path.join(p.home, '.claude', 'projects', encodeProjectDir('C:\\work\\proj'), `${id}.jsonl`));

    const slim = await svc.run('codex', ['codex:codex-tools'], claudeTarget, 'copy');
    const full = await svc.run('codex', ['codex:codex-tools'], claudeTarget, 'copy', undefined, { fullToolLog: true });
    if (slim.status !== 'done' || full.status !== 'done') throw new Error('unreachable');
    const slimText = await transcript(slim.results[0]!.dstSessionId!);
    const fullText = await transcript(full.results[0]!.dstSessionId!);
    expect(slimText).toContain('🔧 [Codex: shell_command] npm test');
    expect(slimText).not.toContain('테스트 출력 원문');
    expect(slimText).toContain('도구 실행 기록은 실행한 명령·파일만 한 줄씩');
    expect(fullText).toContain('테스트 출력 원문');

    // Claude→Codex 도 같은 옵션을 따른다
    const claudeTranscript = path.join(p.home, '.claude', 'projects', encodeProjectDir('C:\\work\\proj'), 'cli-tools.jsonl');
    await writeFile(claudeTranscript, jsonl(
      { type: 'user', cwd: 'C:\\work\\proj', sessionId: 'cli-tools', message: { role: 'user', content: '파일 봐 줘' } },
      { type: 'assistant', sessionId: 'cli-tools', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'C:\\work\\proj\\a.ts' } }] } },
      { type: 'user', sessionId: 'cli-tools', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: '파일 내용 원문' }] } },
      { type: 'assistant', sessionId: 'cli-tools', message: { role: 'assistant', content: [{ type: 'text', text: '봤어요' }] } },
    ));
    await writeFile(path.join(p.appData, 'Claude', 'claude-code-sessions', 'acct-A', 'org-A', 'local_tools.json'),
      JSON.stringify({ sessionId: 'local_tools', cliSessionId: 'cli-tools', cwd: 'C:\\work\\proj', title: 'Claude 도구', createdAt: '1000', lastActivityAt: '1000', isArchived: false }));
    await makeCodexTemplate('C:\\work\\proj');
    const toCodex = await svc.run('claude', ['claude:code:local_tools'], { tool: 'codex' }, 'copy');
    const toCodexFull = await svc.run('claude', ['claude:code:local_tools'], { tool: 'codex' }, 'copy', undefined, { fullToolLog: true });
    if (toCodex.status !== 'done' || toCodexFull.status !== 'done') throw new Error('unreachable');
    const rolloutOf = (id: string) => {
      const db2 = new Database(path.join(p.home, '.codex', 'state_5.sqlite'), { readonly: true });
      try {
        return (db2.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id) as { rollout_path: string }).rollout_path;
      } finally {
        db2.close();
      }
    };
    const codexSlim = await readText(rolloutOf(toCodex.results[0]!.dstSessionId!));
    const codexFull = await readText(rolloutOf(toCodexFull.results[0]!.dstSessionId!));
    expect(codexSlim).toContain('🔧 [Claude: Read] C:\\\\work\\\\proj\\\\a.ts');
    expect(codexSlim).not.toContain('파일 내용 원문');
    expect(codexFull).toContain('파일 내용 원문');
  });
});

describe('ImportService', () => {
  it('imports a Codex session into a Claude account (Codex→Claude)', async () => {
    await makeCodexSource('codex-1', 'C:\\work\\proj', 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], { tool: 'claude', account: { accountId: 'acct-A', orgId: 'org-A' } }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'codex:codex-1', status: 'imported', dstSessionId: expect.any(String) }]);

    const { listClaudeSessions, readClaudeSession } = await import('../../src/main/providers/claude/sessions.js');
    const sessions = listClaudeSessions(p);
    const s = sessions.find((x) => x.sessionId === r.results[0]!.dstSessionId)!;
    expect(s).toMatchObject({ kind: 'code', cwd: 'C:\\work\\proj', accountRef: { accountId: 'acct-A', orgId: 'org-A' } });
    const read = await readClaudeSession(s.file, s.sessionId);
    const notice = (read.messages[0]!.blocks[0] as { text: string }).text;
    expect(notice).toContain('이 세션은 Codex');
    expect(notice).toContain('질문입니다');

    expect(db.findImports('codex', 'codex:codex-1', 'claude', 'acct-A/org-A')).toHaveLength(1);
  });

  it('replaces an invalid source createdAt with the current time and records it in stats', async () => {
    await makeCodexSource('codex-bad', 'C:\work\proj', 1e20);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-bad'], { tool: 'claude', account: { accountId: 'acct-A', orgId: 'org-A' } }, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported' });
    const rec = db.findImports('codex', 'codex:codex-bad', 'claude', 'acct-A/org-A')[0]!;
    expect(JSON.parse(rec.statsJson)).toMatchObject({ invalidCreatedAt: true });
  });

  it('passes the Codex thread git branch into the imported Claude transcript lines (Codex→Claude)', async () => {
    await makeCodexSource('codex-gb', 'C:\\work\\proj', 1000);
    const sdb = new Database(path.join(p.home, '.codex', 'state_5.sqlite'));
    sdb.prepare('UPDATE threads SET git_branch = ? WHERE id = ?').run('feat/x', 'codex-gb');
    sdb.close();
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-gb'], { tool: 'claude', account: { accountId: 'acct-A', orgId: 'org-A' } }, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    const { listClaudeSessions } = await import('../../src/main/providers/claude/sessions.js');
    const s = listClaudeSessions(p).find((x) => x.sessionId === r.results[0]!.dstSessionId)!;
    const branches = (await readText(s.file))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === 'user' || o.type === 'assistant')
      .map((o) => o.gitBranch);
    expect(branches).toEqual(['feat/x', 'feat/x']);
  });

  it('imports a Claude Code session into Codex (Claude→Codex)', async () => {
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', 'C:\\work\\proj', '원본 제목', '1000');
    await makeCodexTemplate('C:\\work\\proj');

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'codex' }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'claude:code:local_src', status: 'imported', dstSessionId: expect.any(String) }]);

    const { listCodexSessions, readCodexSession } = await import('../../src/main/providers/codex/sessions.js');
    const { sessions } = listCodexSessions(p);
    const s = sessions.find((x) => x.sessionId === r.results[0]!.dstSessionId)!;
    expect(s).toMatchObject({ cwd: 'C:\\work\\proj' });
    const read = await readCodexSession(s.file, s.sessionId);
    const notice = (read.messages[0]!.blocks[0] as { text: string }).text;
    expect(notice).toContain('이 세션은 Claude');
    expect(notice).toContain('질문입니다');
  });

  it('prunes transaction backups down to the newest 50 after a committed import', async () => {
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', 'C:\\work\\proj', '원본 제목', '1000');
    await makeCodexTemplate('C:\\work\\proj');
    for (let i = 0; i < 60; i++) {
      const f = path.join(backupsDir(), `00000000-0000-4000-8000-${String(i).padStart(12, '0')}-old.jsonl`);
      await writeFile(f, 'x');
      await fs.utimes(f, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
    }

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'codex' }, 'skip');
    expect(r.status).toBe('done');

    const left = (await fs.readdir(backupsDir())).filter((n) => /^[0-9a-f-]{36}-/.test(n));
    expect(left).toHaveLength(50);
  });

  it('forks a Claude Code session from one account to another without IR conversion (Claude A→B)', async () => {
    const { transcriptPath } = await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', 'C:\\work\\proj', '공유할 세션', '1000');

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'claude', account: { accountId: 'acct-B', orgId: 'org-B' } }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'claude:code:local_src', status: 'forked', dstSessionId: expect.any(String) }]);

    const { listClaudeSessions } = await import('../../src/main/providers/claude/sessions.js');
    const sessions = listClaudeSessions(p);
    const forked = sessions.find((x) => x.sessionId === r.results[0]!.dstSessionId)!;
    expect(forked.accountRef).toMatchObject({ accountId: 'acct-B', orgId: 'org-B' });
    expect(forked.title).toBe('공유할 세션');
    // 원본은 그대로 남아 있다
    expect(await readText(transcriptPath)).toContain('cli-src');
    // 포크도 일반 이관처럼 imports 테이블에 기록되어 '이관됨' 배지/중복 확인에 쓰인다
    expect(db.findImports('claude', 'claude:code:local_src', 'claude', 'acct-B/org-B')).toHaveLength(1);
  });

  it('fails with a friendly message when sharing a non-Code Claude session between accounts', async () => {
    await writeFile(
      path.join(p.home, '.claude', 'projects', 'C--cli', 'cli-only.jsonl'),
      jsonl({ type: 'user', cwd: 'C:\\cli', message: { role: 'user', content: 'hi' } }),
    );
    const r = await svc.run('claude', ['claude:cli:cli-only'], { tool: 'claude', account: { accountId: 'acct-B', orgId: 'org-B' } }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'claude:cli:cli-only', status: 'failed', reason: 'Claude 계정 간 공유는 Code 세션만 가능합니다' }]);
  });

  it('fails with a friendly message when a Cowork session has no hostFolder and the target is Codex', async () => {
    await writeFile(
      path.join(p.appData, 'Claude', 'local-agent-mode-sessions', 'acct-A', 'org-A', 'local_cw.json'),
      JSON.stringify({ sessionId: 'local_cw', cliSessionId: 'cli-cw', cwd: '/sessions/happy-cat', title: '코워크', createdAt: '1000', lastActivityAt: '2000' }),
    );
    await writeFile(
      path.join(p.appData, 'Claude', 'local-agent-mode-sessions', 'acct-A', 'org-A', 'local_cw', '.claude', 'projects', '-sessions-happy-cat', 'cli-cw.jsonl'),
      jsonl({ type: 'user', message: { role: 'user', content: 'cw' } }),
    );
    const r = await svc.run('claude', ['claude:cowork:local_cw'], { tool: 'codex' }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'claude:cowork:local_cw', status: 'failed', reason: '작업 폴더를 알 수 없습니다' }]);
  });

  it('skips an already-imported session when policy is skip, and creates a new copy when policy is copy', async () => {
    await makeCodexSource('codex-1', 'C:\\work\\proj', 1000);
    await makeClaudeTemplate('acct-A', 'org-A');
    const target = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };

    const first = await svc.run('codex', ['codex:codex-1'], target, 'skip');
    expect(first.status).toBe('done');
    if (first.status !== 'done') throw new Error('unreachable');

    const second = await svc.run('codex', ['codex:codex-1'], target, 'skip');
    expect(second.status).toBe('done');
    if (second.status !== 'done') throw new Error('unreachable');
    expect(second.results).toEqual([{ key: 'codex:codex-1', status: 'skipped' }]);

    const third = await svc.run('codex', ['codex:codex-1'], target, 'copy');
    expect(third.status).toBe('done');
    if (third.status !== 'done') throw new Error('unreachable');
    expect(third.results[0]).toMatchObject({ key: 'codex:codex-1', status: 'imported' });
    expect(third.results[0]!.dstSessionId).not.toBe(first.results[0]!.dstSessionId);

    expect(db.findImports('codex', 'codex:codex-1', 'claude', 'acct-A/org-A')).toHaveLength(2);
  });

  it('keeps other sessions succeeding when one fails, leaving no file behind for the failed one', async () => {
    await makeCodexSource('good', 'C:\\work\\proj', 1000);
    await makeCodexSource('bad-no-cwd', '', 1100); // cwd 없음 → 실패
    await makeClaudeTemplate('acct-A', 'org-A');
    const target = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };

    const r = await svc.run('codex', ['codex:good', 'codex:bad-no-cwd'], target, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ key: 'codex:good', status: 'imported' });
    expect(r.results[1]).toMatchObject({ key: 'codex:bad-no-cwd', status: 'failed', reason: '작업 폴더를 알 수 없습니다' });

    const { listClaudeSessions } = await import('../../src/main/providers/claude/sessions.js');
    const after = listClaudeSessions(p);
    // 템플릿 인덱스(local_template) 자체도 인덱스 엔트리로 하나 잡히므로, 실제로 새로 생성된 것만 센다.
    const created = after.filter((s) => s.sessionId !== 'cli-template');
    expect(created).toHaveLength(1); // 실패한 세션은 파일을 남기지 않는다
    expect(created[0]!.sessionId).toBe(r.results[0]!.dstSessionId);
  });

  it('reports a friendly error and leaves nothing behind when the session has no transcript', async () => {
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run('no-transcript', '', 1000, 1000, 'vscode', 'C:\\work\\proj', '제목', 0);
    sdb.close();
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:no-transcript'], { tool: 'claude', account: { accountId: 'acct-A', orgId: 'org-A' } }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'codex:no-transcript', status: 'failed', reason: '대화 기록이 없습니다' }]);
  });

  it('stops the target app before writing and relaunches it afterwards', async () => {
    await makeCodexSource('codex-1', 'C:\\work\\proj', 1000);
    await makeClaudeTemplate('acct-A', 'org-A');
    procs.running = [{ pid: 30, name: 'Claude', path: CLAUDE_APP_PATH }];
    procs.startsOnLaunch = { pid: 31, name: 'Claude', path: CLAUDE_APP_PATH };

    const r = await svc.run('codex', ['codex:codex-1'], { tool: 'claude', account: { accountId: 'acct-A', orgId: 'org-A' } }, 'skip');
    expect(r.status).toBe('done');
    expect(procs.launched).toEqual(['Claude_pzs8sxrjxfjjc!Claude']);
  });

  it('reports progress steps for each imported session', async () => {
    await makeCodexSource('codex-1', 'C:\\work\\proj', 1000);
    await makeClaudeTemplate('acct-A', 'org-A');
    const steps: string[] = [];

    const r = await svc.run('codex', ['codex:codex-1'], { tool: 'claude', account: { accountId: 'acct-A', orgId: 'org-A' } }, 'skip', (s) => steps.push(s));
    expect(r.status).toBe('done');
    expect(steps).toEqual(['세션 읽는 중 (1/1)', '저장소 상태 확인', '변환', '대상 앱에 등록', '이력 기록']);
  });

  it('undoes the Codex thread insert (not just the rollout file) when recordImport fails after the write', async () => {
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', 'C:\\work\\proj', '원본 제목', '1000');
    await makeCodexTemplate('C:\\work\\proj');

    const beforeIndex = await readText(path.join(p.home, '.codex', 'session_index.jsonl'));
    const dbFile = path.join(p.home, '.codex', 'state_5.sqlite');
    const countThreads = () => {
      const sdb = new Database(dbFile, { readonly: true });
      const n = (sdb.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
      sdb.close();
      return n;
    };
    const countRolloutFiles = async () => {
      const dir = path.join(p.home, '.codex', 'sessions');
      let n = 0;
      const walk = async (d: string) => {
        for (const entry of await fs.readdir(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.name.endsWith('.jsonl')) n++;
        }
      };
      await walk(dir);
      return n;
    };

    expect(countThreads()).toBe(1); // 템플릿 스레드만 있음
    expect(await countRolloutFiles()).toBe(1); // 템플릿 rollout 만 있음

    vi.spyOn(db, 'recordImport').mockImplementation(() => { throw new Error('recordImport failed'); });

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'codex' }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results).toEqual([{ key: 'claude:code:local_src', status: 'failed', reason: 'recordImport failed' }]);

    expect(countThreads()).toBe(1); // 새로 생성됐던 스레드 행이 롤백으로 삭제됨
    expect(await countRolloutFiles()).toBe(1); // 새 rollout 파일도 삭제됨
    expect(await readText(path.join(p.home, '.codex', 'session_index.jsonl'))).toBe(beforeIndex); // 되돌아감
  });

  it('reports a rollback failure with cleanup guidance instead of aborting the batch, when the rollback itself fails', async () => {
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src1', 'cli-src1', 'C:\\work\\proj', '첫 세션', '1000');
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src2', 'cli-src2', 'C:\\work\\proj', '두번째 세션', '1000');
    await makeCodexTemplate('C:\\work\\proj');

    // 첫 세션은 recordImport 에서 실패하고, 그 실패를 되돌리는 tx.rollback() 자체도 실패한다(예: 되돌리기용
    // 재연결이 DB 잠김/삭제 등으로 실패하는 상황을 대표한다).
    vi.spyOn(db, 'recordImport').mockImplementationOnce(() => { throw new Error('recordImport failed'); });
    const { FsTransaction } = await import('../../src/main/infra/fs-transaction.js');
    vi.spyOn(FsTransaction.prototype, 'rollback').mockImplementationOnce(async () => {
      throw new Error('database is locked');
    });

    const r = await svc.run('claude', ['claude:code:local_src1', 'claude:code:local_src2'], { tool: 'codex' }, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');

    expect(r.results[0]!.key).toBe('claude:code:local_src1');
    expect(r.results[0]!.status).toBe('failed');
    expect(r.results[0]!.reason).toContain('recordImport failed');
    expect(r.results[0]!.reason).toContain('되돌리기 실패');
    expect(r.results[0]!.reason).toContain('수동 확인이 필요합니다');
    expect(r.results[0]!.reason).toContain('codex 대상');
    expect(r.results[0]!.reason).toMatch(/새 세션 [0-9a-f-]{20,}/); // 실패했어도 writer 가 만든 dstSessionId 를 안내에 담는다
    expect(r.results[0]!.reason).toContain('database is locked');

    // 첫 세션의 되돌리기 실패가 나머지 배치를 중단시키지 않는다 — 두 번째 세션은 정상적으로 이관된다.
    expect(r.results[1]).toMatchObject({ key: 'claude:code:local_src2', status: 'imported' });
  });

  it('aborts without touching the target app when every requested key is unknown', async () => {
    await makeClaudeTemplate('acct-A', 'org-A');
    procs.running = [{ pid: 30, name: 'Claude', path: CLAUDE_APP_PATH }];
    const target = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };

    const r = await svc.run('codex', ['codex:nope1', 'codex:nope2'], target, 'skip');
    expect(r).toEqual({ status: 'aborted', reason: '가져올 수 있는 세션이 없습니다' });
    // 대상 앱을 종료/재실행하지 않았다 — 여전히 실행 중이고 launch/kill 도 호출되지 않았다.
    expect(procs.running).toEqual([{ pid: 30, name: 'Claude', path: CLAUDE_APP_PATH }]);
    expect(procs.launched).toEqual([]);
    expect(procs.killed).toEqual([]);
  });

  it('still runs (and stops the app) when only some requested keys are unknown', async () => {
    await makeCodexSource('good', 'C:\\work\\proj', 1000);
    await makeClaudeTemplate('acct-A', 'org-A');
    const target = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };

    const r = await svc.run('codex', ['codex:good', 'codex:nope'], target, 'skip');
    expect(r.status).toBe('done');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ key: 'codex:good', status: 'imported' });
    expect(r.results[1]).toMatchObject({ key: 'codex:nope', status: 'failed', reason: '알 수 없는 세션입니다' });
  });

  it('aborts the whole run when the target app fails to close', async () => {
    await makeClaudeTemplate('acct-A', 'org-A');
    procs.running = [{ pid: 30, name: 'Claude', path: CLAUDE_APP_PATH }];
    procs.closesOnRequest = false;
    procs.kill = async () => {}; // 강제 종료도 실패
    const target = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };
    const r = await svc.run('codex', ['codex:nope'], target, 'skip');
    expect(r).toMatchObject({ status: 'aborted' });
  });
});

describe('ImportService — 지침 파일 복사(copyInstructions)', () => {
  const claudeTarget = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };
  const projDir = () => path.join(p.home, 'proj');

  it('creates CLAUDE.md containing "@AGENTS.md" when the cwd has AGENTS.md only (Codex→Claude)', async () => {
    await writeFile(path.join(projDir(), 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    const dst = path.join(projDir(), 'CLAUDE.md');
    expect(r.results[0]).toMatchObject({ status: 'imported', instructions: { path: dst, status: 'created' } });
    expect(await readText(dst)).toBe('@AGENTS.md\n');
    expect(await readText(path.join(projDir(), 'AGENTS.md'))).toBe('# 규칙\n');
  });

  it('copies CLAUDE.md bytes exactly into a new AGENTS.md (Claude→Codex)', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 한글 규칙\r\n- 항목\r\n', 'utf8')]);
    await fs.mkdir(projDir(), { recursive: true });
    await fs.writeFile(path.join(projDir(), 'CLAUDE.md'), bytes);
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', projDir(), '원본 제목', '1000');
    await makeCodexTemplate(projDir());

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'codex' }, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    const dst = path.join(projDir(), 'AGENTS.md');
    expect(r.results[0]).toMatchObject({ status: 'imported', instructions: { path: dst, status: 'created' } });
    expect((await fs.readFile(dst)).equals(bytes)).toBe(true);
  });

  it('leaves an existing target file untouched and reports "exists"', async () => {
    await writeFile(path.join(projDir(), 'AGENTS.md'), '# 규칙\n');
    await writeFile(path.join(projDir(), 'CLAUDE.md'), '기존 내용\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', instructions: { path: path.join(projDir(), 'CLAUDE.md'), status: 'exists' } });
    expect(await readText(path.join(projDir(), 'CLAUDE.md'))).toBe('기존 내용\n');
  });

  it('skips with a reason when the source instruction file is missing', async () => {
    await fs.mkdir(projDir(), { recursive: true });
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', instructions: { status: 'skipped', reason: expect.stringContaining('AGENTS.md') } });
    expect(await exists(path.join(projDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('skips with a reason (not a failure) when the cwd is not an existing directory', async () => {
    await makeCodexSource('codex-1', 'C:\\work\\proj-does-not-exist', 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', instructions: { status: 'skipped', reason: expect.any(String) } });
  });

  it('removes the created CLAUDE.md when the item fails later and is rolled back', async () => {
    await writeFile(path.join(projDir(), 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');
    vi.spyOn(db, 'recordImport').mockImplementation(() => { throw new Error('recordImport failed'); });

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'failed', reason: 'recordImport failed' });
    expect(await exists(path.join(projDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('does not create any file when the option is off', async () => {
    await writeFile(path.join(projDir(), 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]!.instructions).toBeUndefined();
    expect(await exists(path.join(projDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('reports the created file once when several sessions share a cwd', async () => {
    await writeFile(path.join(projDir(), 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeCodexSource('codex-2', projDir(), 1100);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1', 'codex:codex-2'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', instructions: { status: 'created' } });
    expect(r.results[1]).toMatchObject({ status: 'imported' });
    expect(r.results[1]!.instructions).toBeUndefined();
  });

  it('retries on the next session sharing the cwd when the item that created the file was rolled back', async () => {
    await writeFile(path.join(projDir(), 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeCodexSource('codex-2', projDir(), 1100);
    await makeClaudeTemplate('acct-A', 'org-A');
    vi.spyOn(db, 'recordImport').mockImplementationOnce(() => { throw new Error('recordImport failed'); });

    const r = await svc.run('codex', ['codex:codex-1', 'codex:codex-2'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'failed' });
    expect(r.results[1]).toMatchObject({ status: 'imported', instructions: { status: 'created' } });
    expect(await readText(path.join(projDir(), 'CLAUDE.md'))).toBe('@AGENTS.md\n');
  });

  it('also creates CLAUDE.md next to AGENTS.md in sub-folders such as nested repos (Codex→Claude)', async () => {
    const hub = projDir();
    await writeFile(path.join(hub, 'app-agent', 'AGENTS.md'), '# 에이전트 규칙\n');
    await writeFile(path.join(hub, 'app-backend', 'AGENTS.md'), '# 백엔드 규칙\n');
    await writeFile(path.join(hub, 'app-backend', 'CLAUDE.md'), '기존\n');
    await makeCodexSource('codex-1', hub, 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({
      status: 'imported',
      instructions: { status: 'skipped', reason: expect.stringContaining('AGENTS.md') }, // 작업 폴더 자신에는 AGENTS.md 가 없다
      subInstructions: [
        { path: path.join(hub, 'app-agent', 'CLAUDE.md'), status: 'created' },
        { path: path.join(hub, 'app-backend', 'CLAUDE.md'), status: 'exists' },
      ],
    });
    expect(await readText(path.join(hub, 'app-agent', 'CLAUDE.md'))).toBe('@AGENTS.md\n');
    expect(await readText(path.join(hub, 'app-backend', 'CLAUDE.md'))).toBe('기존\n');
  });

  it('copies CLAUDE.md into AGENTS.md in sub-folders too (Claude→Codex)', async () => {
    await writeFile(path.join(projDir(), 'svc', 'CLAUDE.md'), '# 서비스 규칙\n');
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', projDir(), '원본 제목', '1000');
    await makeCodexTemplate(projDir());

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'codex' }, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', subInstructions: [{ path: path.join(projDir(), 'svc', 'AGENTS.md'), status: 'created' }] });
    expect(await readText(path.join(projDir(), 'svc', 'AGENTS.md'))).toBe('# 서비스 규칙\n');
  });

  it('removes sub-folder files it created when the item is rolled back', async () => {
    await writeFile(path.join(projDir(), 'app-agent', 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', projDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');
    vi.spyOn(db, 'recordImport').mockImplementation(() => { throw new Error('recordImport failed'); });

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'failed' });
    expect(await exists(path.join(projDir(), 'app-agent', 'CLAUDE.md'))).toBe(false);
  });

  it('does nothing for same-tool imports (Claude A→B)', async () => {
    await writeFile(path.join(projDir(), 'CLAUDE.md'), '# 규칙\n');
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', projDir(), '공유', '1000');

    const r = await svc.run('claude', ['claude:code:local_src'], { tool: 'claude', account: { accountId: 'acct-B', orgId: 'org-B' } }, 'skip', undefined, { copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'forked' });
    expect(r.results[0]!.instructions).toBeUndefined();
    expect(await exists(path.join(projDir(), 'AGENTS.md'))).toBe(false);
  });
});

describe('ImportService — 작업 폴더 복사(copyWorkFolder)', () => {
  const claudeTarget = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };
  // Codex 가 프로젝트 없이 시작한 대화마다 만드는 폴더('<문서>\Codex\<날짜>\<이름>')와 그 복사본 자리
  const chatDir = () => path.join(p.home, 'Documents', 'Codex', '2026-07-20', 'ctx-bridge');
  const copyDir = (suffix = '') => path.join(p.home, 'Documents', 'Claude', '2026-07-20', `ctx-bridge${suffix}`);
  const transcriptIn = (cwd: string, id: string) => path.join(p.home, '.claude', 'projects', encodeProjectDir(cwd), `${id}.jsonl`);

  async function makeChatFolder(): Promise<void> {
    await writeFile(path.join(chatDir(), 'work', 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(chatDir(), 'work', 'repo', 'README.md'), '# 받아 온 저장소\n');
    await writeFile(path.join(chatDir(), 'outputs', 'report.md'), '결과물\n');
  }

  it('copies the GPT conversation folder (with its git repo) to <Documents>\\Claude\\<date>\\<name> and points the new session at the copy', async () => {
    await makeChatFolder();
    await makeCodexSource('codex-1', chatDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyWorkFolder: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', folderCopy: { from: chatDir(), to: copyDir(), status: 'copied' } });
    expect(await readText(path.join(copyDir(), 'work', 'repo', '.git', 'HEAD'))).toBe('ref: refs/heads/main\n');
    expect(await readText(path.join(copyDir(), 'outputs', 'report.md'))).toBe('결과물\n');
    expect(await exists(transcriptIn(copyDir(), r.results[0]!.dstSessionId!))).toBe(true);
    expect(await exists(path.join(chatDir(), 'outputs', 'report.md'))).toBe(true); // 원본은 그대로
  });

  it('rewrites the original folder in the moved conversation to the copy and says so up front', async () => {
    await makeChatFolder();
    const rollout = await writeRollout(p, 'codex-paths.jsonl', [
      { type: 'session_meta', payload: { cwd: chatDir() } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${chatDir()}\\outputs 정리해 줘` }] } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell_command', arguments: JSON.stringify({ command: 'dir', workdir: chatDir() }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: `${chatDir()}\\outputs\\report.md` } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[보고서](${chatDir().replace(/\\/g, '/')}/outputs/report.md)` }] } },
    ]);
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run('codex-paths', rollout, 1000, 1000, 'vscode', chatDir(), '경로 대화', 0);
    sdb.close();
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-paths'], claudeTarget, 'skip', undefined, { copyWorkFolder: true, fullToolLog: true });
    if (r.status !== 'done') throw new Error('unreachable');
    const raw = await readText(transcriptIn(copyDir(), r.results[0]!.dstSessionId!));
    const original = path.join('Documents', 'Codex', '2026-07-20', 'ctx-bridge');
    const count = (form: string) => raw.split(JSON.stringify(form).slice(1, -1)).length - 1;
    expect(count(original)).toBe(1); // 첫머리 안내에서 원본을 한 번 밝히는 것 말고는 남지 않는다
    expect(count(original.replace(/\\/g, '\\\\'))).toBe(0); // 도구 호출의 JSON 이스케이프 경로
    expect(count(original.replace(/\\/g, '/'))).toBe(0); // 답변의 슬래시 링크
    expect(raw).toContain('[작업 폴더 안내]');
    expect(raw).toContain(JSON.stringify(path.join(copyDir(), 'outputs', 'report.md')).slice(1, -1));
  });

  it('adds " (2)" when the destination already exists, leaving the existing folder untouched', async () => {
    await makeChatFolder();
    await writeFile(path.join(copyDir(), 'mine.txt'), '이미 있던 폴더\n');
    await makeCodexSource('codex-1', chatDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyWorkFolder: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ folderCopy: { to: copyDir(' (2)'), status: 'copied' } });
    expect(await readText(path.join(copyDir(), 'mine.txt'))).toBe('이미 있던 폴더\n');
    expect(await exists(path.join(copyDir(), 'outputs'))).toBe(false);
  });

  it('makes one copy per folder in a run — the next session from the same folder reuses it', async () => {
    await makeChatFolder();
    await makeCodexSource('codex-1', chatDir(), 1000);
    await makeCodexSource('codex-2', chatDir(), 1100);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1', 'codex:codex-2'], claudeTarget, 'skip', undefined, { copyWorkFolder: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results.map((x) => x.folderCopy?.status)).toEqual(['copied', 'reused']);
    expect(r.results[1]!.folderCopy!.to).toBe(copyDir());
    expect(await exists(copyDir(' (2)'))).toBe(false);
    expect(await exists(transcriptIn(copyDir(), r.results[1]!.dstSessionId!))).toBe(true);
  });

  it('removes the copy when the item fails later, and the next session from that folder copies again', async () => {
    await makeChatFolder();
    await makeCodexSource('codex-1', chatDir(), 1000);
    await makeCodexSource('codex-2', chatDir(), 1100);
    await makeClaudeTemplate('acct-A', 'org-A');
    vi.spyOn(db, 'recordImport').mockImplementationOnce(() => { throw new Error('recordImport failed'); });

    const r = await svc.run('codex', ['codex:codex-1', 'codex:codex-2'], claudeTarget, 'skip', undefined, { copyWorkFolder: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'failed' });
    expect(r.results[1]).toMatchObject({ status: 'imported', folderCopy: { to: copyDir(), status: 'copied' } });
    expect(await exists(copyDir(' (2)'))).toBe(false); // 실패한 항목의 복사본은 지워져 같은 자리를 다시 쓴다
  });

  it('keeps the original folder and still imports when the GPT folder no longer exists', async () => {
    await makeCodexSource('codex-1', chatDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyWorkFolder: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ status: 'imported', folderCopy: { from: chatDir(), status: 'skipped' } });
    expect(await exists(transcriptIn(chatDir(), r.results[0]!.dstSessionId!))).toBe(true);
  });

  it('creates the instruction file in the copy, not in the GPT folder', async () => {
    await makeChatFolder();
    await writeFile(path.join(chatDir(), 'AGENTS.md'), '# 규칙\n');
    await makeCodexSource('codex-1', chatDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyWorkFolder: true, copyInstructions: true });
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results[0]).toMatchObject({ instructions: { path: path.join(copyDir(), 'CLAUDE.md'), status: 'created' } });
    expect(await exists(path.join(chatDir(), 'CLAUDE.md'))).toBe(false);
  });

  it('leaves project folders, Claude→Codex imports and runs without the option alone', async () => {
    const proj = path.join(p.home, 'proj');
    await writeFile(path.join(proj, 'a.txt'), 'x');
    await makeChatFolder();
    await makeCodexSource('codex-1', proj, 1000);
    await makeCodexSource('codex-2', chatDir(), 1100);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r1 = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip', undefined, { copyWorkFolder: true });
    const r2 = await svc.run('codex', ['codex:codex-2'], claudeTarget, 'skip');
    if (r1.status !== 'done' || r2.status !== 'done') throw new Error('unreachable');
    expect(r1.results[0]!.folderCopy).toBeUndefined();
    expect(r2.results[0]!.folderCopy).toBeUndefined();
    expect(await exists(path.join(p.home, 'Documents', 'Claude'))).toBe(false);

    await makeClaudeCodeSource('acct-A', 'org-A', 'local_src', 'cli-src', chatDir(), '원본', '1000');
    await makeCodexTemplate(chatDir());
    const r3 = await svc.run('claude', ['claude:code:local_src'], { tool: 'codex' }, 'skip', undefined, { copyWorkFolder: true });
    if (r3.status !== 'done') throw new Error('unreachable');
    expect(r3.results[0]).toMatchObject({ status: 'imported' });
    expect(r3.results[0]!.folderCopy).toBeUndefined();
  });
});

describe('ImportService — 작업 폴더 상태(저장소별 브랜치·변경)', () => {
  const claudeTarget = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };
  const hubDir = () => path.join(p.home, 'hub');

  async function makeHub(): Promise<void> {
    await writeFile(path.join(hubDir(), 'agent', '.git', 'HEAD'), 'ref: refs/heads/master\n');
    await writeFile(path.join(hubDir(), 'backend', '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
    gitStatus.mockImplementation(async (dir) => (dir === path.join(hubDir(), 'backend') ? ['M app/router.py', '?? notes.md'] : []));
  }

  async function firstUserText(tool: 'claude' | 'codex', dstSessionId: string): Promise<string> {
    if (tool === 'claude') {
      const { listClaudeSessions, readClaudeSession } = await import('../../src/main/providers/claude/sessions.js');
      const s = listClaudeSessions(p).find((x) => x.sessionId === dstSessionId)!;
      return ((await readClaudeSession(s.file, s.sessionId)).messages[0]!.blocks[0] as { text: string }).text;
    }
    const { listCodexSessions, readCodexSession } = await import('../../src/main/providers/codex/sessions.js');
    const s = listCodexSessions(p).sessions.find((x) => x.sessionId === dstSessionId)!;
    return ((await readCodexSession(s.file, s.sessionId)).messages[0]!.blocks[0] as { text: string }).text;
  }

  it('starts the moved conversation with each repo, its branch and uncommitted changes (Codex→Claude)', async () => {
    await makeHub();
    await makeCodexSource('codex-1', hubDir(), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    const text = await firstUserText('claude', r.results[0]!.dstSessionId!);
    expect(text).toContain('[작업 폴더 상태]');
    expect(text).toContain('- agent (master): 커밋하지 않은 변경 없음');
    expect(text).toContain('- backend (feat/x): M app/router.py, ?? notes.md');
    expect(text.indexOf('이 세션은 Codex')).toBeLessThan(text.indexOf('[작업 폴더 상태]'));
    expect(text.indexOf('[작업 폴더 상태]')).toBeLessThan(text.indexOf('질문입니다'));
  });

  it('adds the same note for Claude→Codex and reads each folder once per run', async () => {
    await makeHub();
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_1', 'cli-1', hubDir(), '하나', '1000');
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_2', 'cli-2', hubDir(), '둘', '1100');
    await makeCodexTemplate(hubDir());

    const r = await svc.run('claude', ['claude:code:local_1', 'claude:code:local_2'], { tool: 'codex' }, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(r.results.map((x) => x.status)).toEqual(['imported', 'imported']);
    expect(await firstUserText('codex', r.results[1]!.dstSessionId!)).toContain('- backend (feat/x): M app/router.py');
    expect(gitStatus).toHaveBeenCalledTimes(2); // 저장소 2개, 세션 2개 — 폴더마다 한 번
  });

  it('adds nothing when the folder has no git repo', async () => {
    await writeFile(path.join(p.home, 'plain', 'a.txt'), 'x');
    await makeCodexSource('codex-1', path.join(p.home, 'plain'), 1000);
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    expect(await firstUserText('claude', r.results[0]!.dstSessionId!)).not.toContain('[작업 폴더 상태]');
    expect(gitStatus).not.toHaveBeenCalled();
  });
});

describe('ImportService — 같은 폴더의 다른 경로 표기(Claude 로 가져올 때)', () => {
  const claudeTarget = { tool: 'claude' as const, account: { accountId: 'acct-A', orgId: 'org-A' } };
  const realDir = () => path.join(p.home, 'real-proj');
  const aliasDir = () => path.join(p.home, 'alias'); // realDir 을 가리키는 정션 — 예: 이름을 바꾼 사용자 폴더 C:\Users\olduser

  async function makeAlias(): Promise<void> {
    await fs.mkdir(realDir(), { recursive: true });
    await fs.symlink(realDir(), aliasDir(), 'junction');
  }

  async function codexSessionMentioning(id: string, cwd: string): Promise<void> {
    const rollout = await writeRollout(p, `${id}.jsonl`, [
      { type: 'session_meta', payload: { cwd } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${cwd}\\a.txt 봐 줘` }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '봤어요' }] } },
    ]);
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, rollout, 1000, 1000, 'vscode', cwd, '경로 대화', 0);
    sdb.close();
  }

  async function imported(dstSessionId: string) {
    const { listClaudeSessions, readClaudeSession } = await import('../../src/main/providers/claude/sessions.js');
    const s = listClaudeSessions(p).find((x) => x.sessionId === dstSessionId)!;
    return { s, text: JSON.stringify((await readClaudeSession(s.file, s.sessionId)).messages) };
  }

  it('writes the session under the real folder and rewrites the old spelling in the conversation', async () => {
    await makeAlias();
    await codexSessionMentioning('codex-1', aliasDir());
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    const { s, text } = await imported(r.results[0]!.dstSessionId!);
    expect(s.cwd).toBe(realDir());
    expect(s.file).toBe(path.join(p.home, '.claude', 'projects', encodeProjectDir(realDir()), `${s.sessionId}.jsonl`));
    expect(text).toContain(JSON.stringify(`${realDir()}\\a.txt`).slice(1, -1));
    expect(text).not.toContain(JSON.stringify(aliasDir()).slice(1, -1));
  });

  it('keeps the spelling Claude already uses for that folder', async () => {
    await makeAlias();
    await makeClaudeCodeSource('acct-A', 'org-A', 'local_old', 'cli-old', aliasDir(), '예전 Claude 세션', '5000');
    await codexSessionMentioning('codex-1', realDir());
    await makeClaudeTemplate('acct-A', 'org-A');

    const r = await svc.run('codex', ['codex:codex-1'], claudeTarget, 'skip');
    if (r.status !== 'done') throw new Error('unreachable');
    const { s } = await imported(r.results[0]!.dstSessionId!);
    expect(s.cwd).toBe(aliasDir());
  });
});
