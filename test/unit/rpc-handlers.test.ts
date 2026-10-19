import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AppDb } from '../../src/main/infra/app-db.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { createHandlers, type Handlers, type PromptKind } from '../../src/rpc/handlers.js';
import { writeClaudeAuth, writeCodexAuth } from '../helpers/fake-auth.js';
import { FakeProcs } from '../helpers/fake-procs.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { codexStateDb, writeRollout } from '../helpers/fake-sessions.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

const CODEX_APP_PATH = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';

let p: PathProvider;
let db: AppDb;
let procs: FakeProcs;
let prompt: Mock<(kind: PromptKind, data: unknown) => Promise<unknown>>;
let handlers: Handlers;

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  procs = new FakeProcs();
  // SwitchService 는 여기서 실제 타이머로 동작하므로(sleep 미주입), launch() 가 즉시 프로세스를 띄운 것처럼
  // 만들어서 launchAndVerify 의 폴링이 실제로 대기하지 않고 바로 끝나게 한다.
  procs.startsOnLaunch = { pid: 999, name: 'ChatGPT', path: CODEX_APP_PATH };
  prompt = vi.fn<(kind: PromptKind, data: unknown) => Promise<unknown>>(async () => {
    throw new Error('unexpected prompt');
  });
  handlers = createHandlers({
    paths: p,
    db,
    secrets: fakeSecretStore(),
    procs,
    makeProviders: (withAppProfile) => ({
      codex: codexAuthProvider(p, { withAppProfile }),
      claude: claudeAuthProvider(p, { withAppProfile }),
    }),
    prompt,
  });
});

describe('createHandlers', () => {
  describe('state', () => {
    it('reports not-logged-in tools as an error and an empty account list', async () => {
      const result = (await handlers.handle('state', {})) as any;
      expect(result.tools.codex.current.error).toContain('로그인');
      expect(result.tools.claude.current.error).toContain('로그인');
      expect(result.accounts).toEqual([]);
    });

    it('reports the current identity and registered label once saved', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      const result = (await handlers.handle('state', {})) as any;
      expect(result.tools.codex.current).toEqual({ email: 'a@x.com', accountId: 'acct-A', registeredLabel: 'work' });
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0]).toMatchObject({ tool: 'codex', label: 'work', email: 'a@x.com', status: 'ok' });
    });

    it('reports the resolved data folders, with the home folder shortened to ~', async () => {
      const q: PathProvider = {
        ...p,
        appDataDir: path.join(p.home, '.ai-account-bridge'),
        claudeDesktop: path.join(p.home, 'AppData', 'Local', 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude'),
      };
      const h = createHandlers({
        paths: q,
        db,
        secrets: fakeSecretStore(),
        procs,
        makeProviders: (withAppProfile) => ({
          codex: codexAuthProvider(q, { withAppProfile }),
          claude: claudeAuthProvider(q, { withAppProfile }),
        }),
        prompt,
      });
      const result = (await h.handle('state', {})) as any;
      expect(result.paths).toEqual({
        appDataDir: path.join('~', '.ai-account-bridge'),
        claudeDesktop: path.join('~', 'AppData', 'Local', 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude'),
      });
    });
  });

  describe('save', () => {
    it('saves the current login under a label', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      const result = await handlers.handle('save', { tool: 'codex', label: 'work' });
      expect(result).toEqual({ created: true, label: 'work' });
    });

    it('rejects an unknown tool', async () => {
      await expect(handlers.handle('save', { tool: 'nope', label: 'x' })).rejects.toThrow();
    });

    it('rejects an empty label', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await expect(handlers.handle('save', { tool: 'codex', label: '' })).rejects.toThrow();
    });

    it('rejects a label longer than 64 characters', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await expect(handlers.handle('save', { tool: 'codex', label: 'x'.repeat(65) })).rejects.toThrow();
    });

    it('rejects non-object params', async () => {
      await expect(handlers.handle('save', 'nope')).rejects.toThrow();
    });
  });

  describe('switch', () => {
    beforeEach(async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      await writeCodexAuth(p, 'acct-B', 'b@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'personal' });
    });

    it('switches accounts and launches the app', async () => {
      const result = (await handlers.handle('switch', { tool: 'codex', label: 'work' })) as any;
      expect(result.status).toBe('switched');
      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
    });

    it(
      'force-kills the app after the graceful-close wait without prompting confirmKill (RPC backend runs with autoKill)',
      async () => {
        procs.running = [{ pid: 10, name: 'ChatGPT', path: CODEX_APP_PATH }];
        procs.closesOnRequest = false;
        const result = (await handlers.handle('switch', { tool: 'codex', label: 'work' })) as any;
        expect(result.status).toBe('switched');
        expect(procs.killed).toEqual([10]);
        expect(prompt).not.toHaveBeenCalled();
      },
      8_000, // switchServiceFor 의 closeTimeoutMs(3s) 만큼 실제로 대기하므로 넉넉히 잡음
    );

    it('rejects an unknown tool', async () => {
      await expect(handlers.handle('switch', { tool: 'nope', label: 'work' })).rejects.toThrow();
    });
  });

  describe('restore', () => {
    it('rejects a file outside appDataDir', async () => {
      const outside = path.join(p.home, 'evil.bin');
      await writeFile(outside, 'x');
      await expect(handlers.handle('restore', { tool: 'codex', file: outside })).rejects.toThrow();
    });

    it('rejects a non-.bin file inside appDataDir', async () => {
      const file = path.join(p.appDataDir, 'backups', 'codex', 'note.txt');
      await writeFile(file, 'x');
      await expect(handlers.handle('restore', { tool: 'codex', file })).rejects.toThrow();
    });

    it('rejects a .bin path inside appDataDir that does not exist', async () => {
      const file = path.join(p.appDataDir, 'backups', 'codex', 'missing.bin');
      await expect(handlers.handle('restore', { tool: 'codex', file })).rejects.toThrow();
    });

    it('restores from a valid backup file under appDataDir/backups', async () => {
      const provider = codexAuthProvider(p);
      await writeCodexAuth(p, 'acct-Z', 'z@x.com', 'rZ');
      const { BackupStore } = await import('../../src/main/infra/backup-store.js');
      const backups = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore());
      const file = await backups.save(await provider.readCurrentAuth());
      await writeCodexAuth(p, 'acct-B', 'b@x.com');

      const result = (await handlers.handle('restore', { tool: 'codex', file })) as any;
      expect(result.status).toBe('restored');
    });
  });

  describe('addAccount', () => {
    it('prepares a new login by clearing the auth files and returns a backup path', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      const result = (await handlers.handle('addAccount', { tool: 'codex' })) as any;
      expect(result.status).toBe('ready');
      expect(typeof result.backupPath).toBe('string');
      expect(procs.launched).toEqual(['OpenAI.Codex_2p2nqsd0c76g0!App']);
    });

    it('rejects an unknown tool', async () => {
      await expect(handlers.handle('addAccount', { tool: 'nope' })).rejects.toThrow();
    });

    it('rejects non-object params', async () => {
      await expect(handlers.handle('addAccount', 'nope')).rejects.toThrow();
    });
  });

  describe('rename', () => {
    it('renames a registered account', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      const result = (await handlers.handle('rename', { tool: 'codex', label: 'work', newLabel: 'main' })) as any;
      expect(result).toEqual({ label: 'main' });
    });

    it('rejects an unknown tool', async () => {
      await expect(handlers.handle('rename', { tool: 'nope', label: 'work', newLabel: 'main' })).rejects.toThrow();
    });

    it('rejects an empty newLabel', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      await expect(handlers.handle('rename', { tool: 'codex', label: 'work', newLabel: '' })).rejects.toThrow();
    });

    it('rejects a newLabel longer than 64 characters', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      await expect(
        handlers.handle('rename', { tool: 'codex', label: 'work', newLabel: 'x'.repeat(65) }),
      ).rejects.toThrow();
    });

    it('rejects non-object params', async () => {
      await expect(handlers.handle('rename', 'nope')).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('deletes a registered account', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });
      const result = (await handlers.handle('delete', { tool: 'codex', label: 'work' })) as any;
      expect(result).toEqual({ deleted: true });
      const state = (await handlers.handle('state', {})) as any;
      expect(state.accounts).toEqual([]);
    });

    it('rejects an unknown tool', async () => {
      await expect(handlers.handle('delete', { tool: 'nope', label: 'work' })).rejects.toThrow();
    });

    it('rejects an empty label', async () => {
      await expect(handlers.handle('delete', { tool: 'codex', label: '' })).rejects.toThrow();
    });

    it('rejects non-object params', async () => {
      await expect(handlers.handle('delete', 'nope')).rejects.toThrow();
    });
  });

  describe('backupsDir', () => {
    it('returns the backups directory path under appDataDir', async () => {
      const dir = await handlers.handle('backupsDir', undefined);
      expect(dir).toBe(path.join(p.appDataDir, 'backups'));
    });
  });

  describe('appIcons', () => {
    it('reads each tool icon by the package family of its app, once', async () => {
      const readAppIcon = vi.fn(async (family: string) => (family.startsWith('Claude_') ? 'data:image/png;base64,QQ==' : null));
      const h = createHandlers({
        paths: p,
        db,
        secrets: fakeSecretStore(),
        procs,
        makeProviders: (withAppProfile) => ({
          codex: codexAuthProvider(p, { withAppProfile }),
          claude: claudeAuthProvider(p, { withAppProfile }),
        }),
        prompt,
        readAppIcon,
      });
      expect(await h.handle('appIcons', undefined)).toEqual({ codex: null, claude: 'data:image/png;base64,QQ==' });
      await h.handle('appIcons', undefined);
      expect(readAppIcon.mock.calls.map((c) => c[0]).sort()).toEqual(['Claude_pzs8sxrjxfjjc', 'OpenAI.Codex_2p2nqsd0c76g0']);
    });
  });

  describe('libraryList / librarySession', () => {
    async function codexFixture(): Promise<string> {
      await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
      const f = await writeRollout(p, 'r.jsonl', [
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } },
      ]);
      const sdb = codexStateDb(p);
      sdb
        .prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
        .run('t1', f, 100, 200, 'vscode', 'C:\\work\\proj', '세션1', 0);
      sdb.close();
      return f;
    }

    it('returns { accounts, projects } for a known tool, with hasTranscript instead of file', async () => {
      await codexFixture();
      const result = (await handlers.handle('libraryList', { tool: 'codex' })) as any;
      expect(result.accounts).toBeInstanceOf(Array);
      expect(result.projects).toHaveLength(1);
      const [session] = result.projects[0].sessions;
      expect(session.sessionId).toBe('t1');
      expect(session.hasTranscript).toBe(true);
      expect(session.file).toBeUndefined();
    });

    it('reports hasTranscript: false when the session has no conversation file', async () => {
      await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
      const sdb = codexStateDb(p);
      sdb
        .prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
        .run('nofile', '', 100, 100, 'vscode', 'C:\\x', '제목', 0);
      sdb.close();
      const result = (await handlers.handle('libraryList', { tool: 'codex' })) as any;
      const session = result.projects.flatMap((pr: any) => pr.sessions).find((s: any) => s.sessionId === 'nofile');
      expect(session.hasTranscript).toBe(false);
      expect(session.file).toBeUndefined();
    });

    it('rejects an unknown tool', async () => {
      await expect(handlers.handle('libraryList', { tool: 'bogus' })).rejects.toThrow();
    });

    it('reads a listed session, truncating to 300 messages and 8000 chars per text block', async () => {
      await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
      const rows = [];
      for (let i = 0; i < 305; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        const contentType = role === 'user' ? 'input_text' : 'output_text';
        const text = i === 0 ? 'x'.repeat(9000) : `line ${i}`;
        rows.push({ type: 'response_item', payload: { type: 'message', role, content: [{ type: contentType, text }] } });
      }
      const f = await writeRollout(p, 'big.jsonl', rows);
      const sdb = codexStateDb(p);
      sdb
        .prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
        .run('big', f, 100, 200, 'vscode', 'C:\\work\\proj', '큰 세션', 0);
      sdb.close();

      await handlers.handle('libraryList', { tool: 'codex' });
      const result = (await handlers.handle('librarySession', { tool: 'codex', key: 'codex:big' })) as any;
      expect(result.session.messages).toHaveLength(300);
      expect(result.messagesTruncated).toBe(true);
      expect(result.blocksTruncated).toBe(false);
      const firstText = result.session.messages[0].blocks[0].text as string;
      expect(firstText.length).toBeLessThan(9000);
      expect(firstText).toContain('생략');
    });

    it('caps total blocks at 2000 across the returned messages, keeping message boundaries', async () => {
      await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
      const rows = [];
      for (let i = 0; i < 2100; i++) {
        rows.push({ type: 'response_item', payload: { type: 'function_call', call_id: `c${i}`, name: `tool${i}`, arguments: '{}' } });
      }
      const f = await writeRollout(p, 'blocks.jsonl', rows);
      const sdb = codexStateDb(p);
      sdb
        .prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
        .run('blocky', f, 100, 200, 'vscode', 'C:\\work\\proj', '도구 호출 세션', 0);
      sdb.close();

      await handlers.handle('libraryList', { tool: 'codex' });
      const result = (await handlers.handle('librarySession', { tool: 'codex', key: 'codex:blocky' })) as any;
      // 모든 tool call 이 연속된 assistant 메시지 하나로 병합되므로 메시지 하나에 블록 2100개가 생긴다.
      expect(result.session.messages).toHaveLength(1);
      expect(result.session.messages[0].blocks).toHaveLength(2000);
      expect(result.blocksTruncated).toBe(true);
      expect(result.messagesTruncated).toBe(false);
    });

    it('rejects a session key not in the last listing', async () => {
      await codexFixture();
      await handlers.handle('libraryList', { tool: 'codex' });
      await expect(handlers.handle('librarySession', { tool: 'codex', key: 'codex:nope' })).rejects.toThrow('알 수 없는 세션');
    });

    it('succeeds while a mutating switch is in flight (read-only, no lock)', async () => {
      await codexFixture();
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });

      let release: () => void = () => {};
      procs.listGate = new Promise((resolve) => {
        release = resolve;
      });

      const first = handlers.handle('switch', { tool: 'codex', label: 'work' });
      const listResult = (await handlers.handle('libraryList', { tool: 'codex' })) as any;
      expect(listResult.projects).toHaveLength(1);

      release();
      const firstResult = (await first) as any;
      expect(firstResult.status).toBe('switched');
    });
  });

  describe('importSessions / importHistory', () => {
    async function makeCodexSource(id: string, cwd: string, createdAtSec: number): Promise<void> {
      await fs.mkdir(path.join(p.home, '.codex'), { recursive: true });
      const rollout = await writeRollout(p, `${id}.jsonl`, [
        { type: 'session_meta', payload: { cwd } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '질문입니다' }] } },
      ]);
      const sdb = codexStateDb(p);
      sdb
        .prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, rollout, createdAtSec, createdAtSec, 'vscode', cwd, '원본 제목', 0);
      sdb.close();
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

    it('imports a Codex session into a registered Claude account via accountKey acct:<id>, reporting progress', async () => {
      await makeCodexSource('codex-1', 'C:\\work\\proj', 1000);
      await makeClaudeTemplate('acct-A', 'org-A');
      const { row } = db.upsertAccount({
        tool: 'claude', accountId: 'acct-A', orgId: 'org-A', email: 'a@x.com', displayName: null,
        label: 'work', snapshotPath: 'x', snapshotAt: 'x',
      });

      const steps: string[] = [];
      const result = (await handlers.handle(
        'importSessions',
        { srcTool: 'codex', keys: ['codex:codex-1'], target: { tool: 'claude', accountKey: `acct:${row.id}` }, policy: 'skip' },
        { progress: (s) => steps.push(s) },
      )) as any;
      expect(result.status).toBe('done');
      expect(result.results).toEqual([{ key: 'codex:codex-1', status: 'imported', dstSessionId: expect.any(String) }]);
      expect(steps).toContain('변환');
      expect(steps).toContain('이력 기록');
    });

    it('resolves accountKey "current" to the currently logged-in Claude identity', async () => {
      await makeCodexSource('codex-2', 'C:\\work\\proj', 1000);
      await writeClaudeAuth(p, 'acct-cur', 'org-cur', 'cur@x.com');
      await makeClaudeTemplate('acct-cur', 'org-cur');

      const result = (await handlers.handle('importSessions', {
        srcTool: 'codex', keys: ['codex:codex-2'], target: { tool: 'claude', accountKey: 'current' }, policy: 'skip',
      })) as any;
      expect(result.status).toBe('done');
      expect(result.results[0]).toMatchObject({ status: 'imported' });
    });

    it('rejects accountKey "current" when Claude is not logged in', async () => {
      await makeCodexSource('codex-nc', 'C:\\work\\proj', 1000);
      await expect(
        handlers.handle('importSessions', {
          srcTool: 'codex', keys: ['codex:codex-nc'], target: { tool: 'claude', accountKey: 'current' }, policy: 'skip',
        }),
      ).rejects.toThrow();
    });

    it('rejects an accountKey pointing at a non-existent registered account', async () => {
      await expect(
        handlers.handle('importSessions', {
          srcTool: 'codex', keys: ['codex:x'], target: { tool: 'claude', accountKey: 'acct:9999' }, policy: 'skip',
        }),
      ).rejects.toThrow('등록된 Claude 계정을 찾을 수 없습니다');
    });

    it('rejects an accountKey pointing at a registered account of a different tool', async () => {
      await writeCodexAuth(p, 'codex-acct', 'c@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'codex-work' });
      const codexRow = db.listAccounts('codex')[0]!;
      await expect(
        handlers.handle('importSessions', {
          srcTool: 'codex', keys: ['codex:x'], target: { tool: 'claude', accountKey: `acct:${codexRow.id}` }, policy: 'skip',
        }),
      ).rejects.toThrow('등록된 Claude 계정을 찾을 수 없습니다');
    });

    it('rejects a malformed accountKey', async () => {
      await expect(
        handlers.handle('importSessions', { srcTool: 'codex', keys: ['codex:x'], target: { tool: 'claude', accountKey: 'nope' }, policy: 'skip' }),
      ).rejects.toThrow();
    });

    it('rejects a claude target with no accountKey', async () => {
      await expect(
        handlers.handle('importSessions', { srcTool: 'codex', keys: ['codex:x'], target: { tool: 'claude' }, policy: 'skip' }),
      ).rejects.toThrow();
    });

    it('rejects an empty keys array', async () => {
      await expect(
        handlers.handle('importSessions', { srcTool: 'codex', keys: [], target: { tool: 'codex' }, policy: 'skip' }),
      ).rejects.toThrow();
    });

    it('rejects more than 200 keys', async () => {
      await expect(
        handlers.handle('importSessions', {
          srcTool: 'codex', keys: Array.from({ length: 201 }, (_, i) => `codex:${i}`), target: { tool: 'codex' }, policy: 'skip',
        }),
      ).rejects.toThrow();
    });

    it('rejects an invalid policy', async () => {
      await expect(
        handlers.handle('importSessions', { srcTool: 'codex', keys: ['codex:x'], target: { tool: 'codex' }, policy: 'bogus' }),
      ).rejects.toThrow();
    });

    it('rejects a non-boolean copyInstructions', async () => {
      await expect(
        handlers.handle('importSessions', { srcTool: 'codex', keys: ['codex:x'], target: { tool: 'codex' }, policy: 'skip', copyInstructions: 'yes' }),
      ).rejects.toThrow('copyInstructions');
    });

    it('passes copyInstructions through and returns the created instruction file', async () => {
      const proj = path.join(p.home, 'proj');
      await writeFile(path.join(proj, 'AGENTS.md'), '# 규칙\n');
      await makeCodexSource('codex-ci', proj, 1000);
      await makeClaudeTemplate('acct-A', 'org-A');
      const { row } = db.upsertAccount({
        tool: 'claude', accountId: 'acct-A', orgId: 'org-A', email: 'a@x.com', displayName: null,
        label: 'work', snapshotPath: 'x', snapshotAt: 'x',
      });

      const result = (await handlers.handle('importSessions', {
        srcTool: 'codex', keys: ['codex:codex-ci'], target: { tool: 'claude', accountKey: `acct:${row.id}` }, policy: 'skip', copyInstructions: true,
      })) as any;
      expect(result.results[0]).toMatchObject({ status: 'imported', instructions: { path: path.join(proj, 'CLAUDE.md'), status: 'created' } });
    });

    it('rejects an unknown srcTool', async () => {
      await expect(
        handlers.handle('importSessions', { srcTool: 'nope', keys: ['x'], target: { tool: 'codex' }, policy: 'skip' }),
      ).rejects.toThrow();
    });

    it('rejects a concurrent mutating request while importSessions is in flight', async () => {
      await makeCodexSource('codex-lock', 'C:\\work\\proj', 1000);
      await makeClaudeTemplate('acct-A', 'org-A');
      const { row } = db.upsertAccount({
        tool: 'claude', accountId: 'acct-A', orgId: 'org-A', email: 'a@x.com', displayName: null,
        label: 'work', snapshotPath: 'x', snapshotAt: 'x',
      });

      let release: () => void = () => {};
      procs.listGate = new Promise((resolve) => {
        release = resolve;
      });

      const first = handlers.handle('importSessions', {
        srcTool: 'codex', keys: ['codex:codex-lock'], target: { tool: 'claude', accountKey: `acct:${row.id}` }, policy: 'skip',
      });
      await expect(handlers.handle('save', { tool: 'codex', label: 'x' })).rejects.toThrow('다른 작업이 진행 중입니다');

      release();
      const firstResult = (await first) as any;
      expect(firstResult.status).toBe('done');
    });

    it('reports import history for a source session across destinations, empty when none exist', async () => {
      await makeCodexSource('codex-hist', 'C:\\work\\proj', 1000);
      await makeClaudeTemplate('acct-A', 'org-A');
      const { row } = db.upsertAccount({
        tool: 'claude', accountId: 'acct-A', orgId: 'org-A', email: 'a@x.com', displayName: null,
        label: 'work', snapshotPath: 'x', snapshotAt: 'x',
      });
      await handlers.handle('importSessions', {
        srcTool: 'codex', keys: ['codex:codex-hist'], target: { tool: 'claude', accountKey: `acct:${row.id}` }, policy: 'skip',
      });

      const result = (await handlers.handle('importHistory', { srcTool: 'codex', key: 'codex:codex-hist' })) as any;
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]).toMatchObject({ srcTool: 'codex', srcKey: 'codex:codex-hist', dstTool: 'claude' });

      const none = (await handlers.handle('importHistory', { srcTool: 'codex', key: 'codex:nope' })) as any;
      expect(none.imports).toEqual([]);
    });

    it('answers importHistory (read-only, no lock) while a mutating switch is in flight', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await handlers.handle('save', { tool: 'codex', label: 'work' });

      let release: () => void = () => {};
      procs.listGate = new Promise((resolve) => {
        release = resolve;
      });

      const first = handlers.handle('switch', { tool: 'codex', label: 'work' });
      const history = (await handlers.handle('importHistory', { srcTool: 'codex', key: 'codex:whatever' })) as any;
      expect(history).toEqual({ imports: [] });

      release();
      const firstResult = (await first) as any;
      expect(firstResult.status).toBe('switched');
    });
  });

  it('rejects an unknown method', async () => {
    await expect(handlers.handle('nope', {})).rejects.toThrow();
  });

  it('rejects a concurrent mutating request while one is in flight', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    await handlers.handle('save', { tool: 'codex', label: 'work' });

    let release: () => void = () => {};
    procs.listGate = new Promise((resolve) => {
      release = resolve;
    });

    const first = handlers.handle('switch', { tool: 'codex', label: 'work' });
    await expect(handlers.handle('save', { tool: 'codex', label: 'other' })).rejects.toThrow('다른 작업이 진행 중입니다');

    release();
    const firstResult = (await first) as any;
    expect(firstResult.status).toBe('switched');
  });

  it('rejects delete while a switch is in flight', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    await handlers.handle('save', { tool: 'codex', label: 'work' });

    let release: () => void = () => {};
    procs.listGate = new Promise((resolve) => {
      release = resolve;
    });

    const first = handlers.handle('switch', { tool: 'codex', label: 'work' });
    await expect(handlers.handle('delete', { tool: 'codex', label: 'work' })).rejects.toThrow('다른 작업이 진행 중입니다');

    release();
    const firstResult = (await first) as any;
    expect(firstResult.status).toBe('switched');
  });

  it('rejects rename while addAccount is in flight', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    await handlers.handle('save', { tool: 'codex', label: 'work' });

    let release: () => void = () => {};
    procs.listGate = new Promise((resolve) => {
      release = resolve;
    });

    const first = handlers.handle('addAccount', { tool: 'codex' });
    await expect(handlers.handle('rename', { tool: 'codex', label: 'work', newLabel: 'main' })).rejects.toThrow(
      '다른 작업이 진행 중입니다',
    );

    release();
    const firstResult = (await first) as any;
    expect(firstResult.status).toBe('ready');
  });
});

describe('cross-process operation lock', () => {
  it('rejects a mutating call while another live process holds op.lock, and releases afterwards', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    await fs.mkdir(p.appDataDir, { recursive: true });
    const lock = path.join(p.appDataDir, 'op.lock');
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), op: 'switch' }));
    await expect(handlers.handle('save', { tool: 'codex', label: 'work' })).rejects.toThrow('다른 창(또는 CLI)에서 작업이 진행 중입니다');
    await fs.unlink(lock);
    await handlers.handle('save', { tool: 'codex', label: 'work' });
    await expect(fs.access(lock)).rejects.toThrow();
  });
});
