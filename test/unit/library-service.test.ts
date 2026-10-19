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
    const loose = r.projects.find((x) => x.key === 'loose')!; // Codex 앱처럼 프로젝트 밖 대화는 한 묶음
    expect(loose.name).toBe('프로젝트 없음');
    expect(loose.sessions.map((s) => [s.sessionId, s.accountKey])).toEqual([['late', `acct:${row.id}`]]);
    expect(r.projects.map((x) => x.key)).toEqual(['proj:p1', 'loose']);
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
    const session = await lib.read('codex', 'codex:late');
    expect(session.messages[0]!.blocks[0]).toEqual({ kind: 'text', text: 'q' });
    await expect(lib.read('codex', 'codex:nope')).rejects.toThrow('알 수 없는 세션');
  });

  it('throws a friendly error when the session has no conversation file', async () => {
    const f = await writeRollout(p, 'r.jsonl', []);
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run('nofile', '', 100, 100, 'vscode', 'C:\\x', '제목', 0);
    sdb.close();
    void f;
    const r = lib.list('codex', {});
    expect(r.projects.flatMap((x) => x.sessions).find((s) => s.sessionId === 'nofile')).toBeDefined();
    await expect(lib.read('codex', 'codex:nofile')).rejects.toThrow('대화 파일을 찾을 수 없습니다');
  });

  it('treats sessions after a deleted account as unassigned rather than reverting to the previous account', async () => {
    const f = await writeRollout(p, 'r.jsonl', []);
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run('s', f, 250, 250, 'vscode', 'C:\\x', '제목', 0);
    sdb.close();
    const work = db.upsertAccount({ tool: 'codex', accountId: 'A', orgId: '', email: 'a@x', displayName: null, label: 'work', snapshotPath: 'x', snapshotAt: 'x' }).row;
    const personal = db.upsertAccount({ tool: 'codex', accountId: 'B', orgId: '', email: 'b@x', displayName: null, label: 'personal', snapshotPath: 'x', snapshotAt: 'x' }).row;
    db.recordSwitch('codex', work.id, 'saved', new Date(100_000).toISOString());
    db.recordSwitch('codex', personal.id, 'saved', new Date(200_000).toISOString());

    const before = lib.list('codex', {});
    expect(before.projects.flatMap((x) => x.sessions).find((s) => s.sessionId === 's')!.accountKey).toBe(`acct:${personal.id}`);

    db.deleteAccount(personal.id);
    const after = lib.list('codex', {});
    expect(after.projects.flatMap((x) => x.sessions).find((s) => s.sessionId === 's')!.accountKey).toBe('unassigned');
  });

  it('reports a friendly error when a listed file has since been deleted from disk', async () => {
    await codexFixture();
    lib.list('codex', {});
    await fs.rm(path.join(p.home, '.codex', 'sessions', '2026', '09', '28', 'r.jsonl'));
    await expect(lib.read('codex', 'codex:late')).rejects.toThrow('대화 파일을 찾을 수 없습니다');
  });

  it('marks previously-imported session keys via a single imports-table query, regardless of destination', async () => {
    await codexFixture();
    db.recordImport({ srcTool: 'codex', srcKey: 'codex:late', dstTool: 'claude', dstAccountKey: 'a/o', dstSessionId: 'x', importedAt: '2026-09-29T00:00:00.000Z', statsJson: '{}' });
    const r = lib.list('codex', {});
    expect(r.imported).toEqual(['codex:late']);
  });

  it('groups a session run in a git worktree with the project of its main repository', async () => {
    const main = path.join(p.home, 'work', 'base-docs');
    const wt = path.join(p.home, 'codex_home', 'worktrees', '31f3', 'base-docs');
    await fs.mkdir(path.join(main, '.git', 'worktrees', 'base-docs'), { recursive: true });
    await writeFile(path.join(wt, '.git'), `gitdir: ${main.replaceAll('\\', '/')}/.git/worktrees/base-docs`);
    const f = await writeRollout(p, 'w.jsonl', []);
    const sdb = codexStateDb(p);
    const ins = sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('in-root', f, 1, 2, 'vscode', `\\\\?\\${main}`, '원본에서', 0);
    ins.run('in-worktree', f, 1, 3, 'vscode', `\\\\?\\${wt}`, '작업 트리에서', 0);
    ins.run('loose-root', f, 1, 1, 'vscode', path.join(p.home, 'loose'), '프로젝트 밖', 0);
    sdb.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('base', 'base-docs', '{}', 0);
    sdb.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('base', 0, main);
    sdb.close();
    const r = lib.list('codex', {});
    const proj = r.projects.find((x) => x.key === 'proj:base')!;
    expect(proj.sessions.map((s) => s.sessionId)).toEqual(['in-worktree', 'in-root']);
    expect(r.projects.filter((x) => x.name === 'base-docs')).toHaveLength(1);
  });

  it('keeps only Codex projects as groups and puts every other conversation into one group last', async () => {
    const f = await writeRollout(p, 'n.jsonl', []);
    const sdb = codexStateDb(p);
    const ins = sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived, project_id) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('chat-new', f, 1, 9, 'vscode', 'C:\\Docs\\Codex\\2026-09-11\\new-chat', '새 채팅', 0, null);
    ins.run('chat-old', f, 1, 2, 'vscode', 'C:\\Docs\\Codex\\2026-08-27\\new-chat', '예전 채팅', 0, null);
    ins.run('in-proj', f, 1, 5, 'vscode', 'C:\\work\\app\\src', '프로젝트 작업', 0, null);
    ins.run('assigned', f, 1, 4, 'vscode', 'C:\\elsewhere', '프로젝트에 넣은 대화', 0, 'app');
    sdb.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('app', 'app', '{}', 0);
    sdb.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('app', 0, 'C:\\work\\app');
    sdb.close();
    const r = lib.list('codex', {});
    expect(r.projects.map((x) => [x.name, x.sessions.map((s) => s.sessionId)])).toEqual([
      ['app', ['in-proj', 'assigned']],
      ['프로젝트 없음', ['chat-new', 'chat-old']],
    ]);
  });

  it('matches project roots through folder links and honours projectless threads', async () => {
    const real = path.join(p.home, 'real', 'ChatBot');
    await fs.mkdir(real, { recursive: true });
    const alias = path.join(p.home, 'alias');
    await fs.symlink(path.join(p.home, 'real'), alias, 'junction'); // C:\Users\olduser → C:\Users\me 같은 연결
    const f = await writeRollout(p, 'l.jsonl', []);
    const sdb = codexStateDb(p);
    const ins = sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)');
    ins.run('via-real', f, 1, 3, 'vscode', real, '실제 경로', 0);
    ins.run('pulled-out', f, 1, 2, 'vscode', real, '프로젝트 밖으로 뺀 대화', 0);
    sdb.close();
    await writeFile(
      path.join(p.home, '.codex', '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': [],
        'local-projects': { 'local-c': { id: 'local-c', name: 'ChatBot', rootPaths: [path.join(alias, 'ChatBot')] } },
        'projectless-thread-ids': ['pulled-out'],
      }),
    );
    const r = lib.list('codex', {});
    expect(r.projects.map((x) => [x.name, x.sessions.map((s) => s.sessionId)])).toEqual([
      ['ChatBot', ['via-real']],
      ['프로젝트 없음', ['pulled-out']],
    ]);
  });

  it('tells apart different Claude folders with the same name by their parent folder', async () => {
    const proj = path.join(p.home, '.claude', 'projects');
    await writeFile(path.join(proj, 'C--x-app', 'c1.jsonl'), jsonl({ type: 'user', cwd: 'C:\\x\\app', timestamp: '2026-09-02T00:00:00Z', message: { role: 'user', content: 'a' } }));
    await writeFile(path.join(proj, 'C--y-app', 'c2.jsonl'), jsonl({ type: 'user', cwd: 'C:\\y\\app', timestamp: '2026-09-01T00:00:00Z', message: { role: 'user', content: 'b' } }));
    await writeFile(path.join(proj, 'C--solo', 'c3.jsonl'), jsonl({ type: 'user', cwd: 'C:\\solo', message: { role: 'user', content: 'c' } }));
    expect(lib.list('claude', {}).projects.map((x) => x.name).sort()).toEqual(['app · x', 'app · y', 'solo']);
  });

  it('picks the deepest matching project root when projects are nested', async () => {
    const f = await writeRollout(p, 'r.jsonl', []);
    const sdb = codexStateDb(p);
    sdb.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
      .run('nested', f, 100, 100, 'vscode', 'C:\\work\\sub\\proj', '제목', 0);
    sdb.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('outer', '바깥', '{}', 0);
    sdb.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('outer', 0, 'C:\\work');
    sdb.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('inner', '안쪽', '{}', 1);
    sdb.prepare('INSERT INTO project_roots VALUES (?,?,?)').run('inner', 0, 'C:\\work\\sub');
    sdb.close();
    const r = lib.list('codex', {});
    const proj = r.projects.find((x) => x.sessions.some((s) => s.sessionId === 'nested'))!;
    expect(proj.key).toBe('proj:inner');
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
