import Database from 'better-sqlite3';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDb, type NewAccount } from '../../src/main/infra/app-db.js';
import { tmpPaths } from '../helpers/tmp-paths.js';

const acct = (over: Partial<NewAccount> = {}): NewAccount => ({
  tool: 'codex', accountId: 'A', orgId: '', email: 'a@x.com', displayName: null,
  label: 'work', snapshotPath: 'C:\\s\\a.bin', snapshotAt: '2026-09-23T00:00:00Z', ...over,
});

let db: AppDb;
beforeEach(() => { db = new AppDb(':memory:'); });

describe('AppDb accounts', () => {
  it('inserts a new account', () => {
    const r = db.upsertAccount(acct());
    expect(r.created).toBe(true);
    expect(r.row).toMatchObject({ tool: 'codex', accountId: 'A', label: 'work', status: 'ok' });
    expect(db.findAccountByLabel('codex', 'work')?.id).toBe(r.row.id);
  });

  it('updates the snapshot of an existing identity but keeps its label', () => {
    db.upsertAccount(acct());
    const r = db.upsertAccount(acct({ label: 'renamed', snapshotAt: '2026-09-24T00:00:00Z' }));
    expect(r.created).toBe(false);
    expect(r.row.label).toBe('work');
    expect(r.row.snapshotAt).toBe('2026-09-24T00:00:00Z');
    expect(db.listAccounts()).toHaveLength(1);
  });

  it('rejects a label already used by another identity of the same tool', () => {
    db.upsertAccount(acct());
    expect(() => db.upsertAccount(acct({ accountId: 'B' }))).toThrow("'work'");
  });

  it('treats the same accountId under different orgs as different accounts', () => {
    db.upsertAccount(acct({ tool: 'claude', orgId: 'o1', label: 'a' }));
    db.upsertAccount(acct({ tool: 'claude', orgId: 'o2', label: 'b' }));
    expect(db.listAccounts('claude')).toHaveLength(2);
    expect(db.findAccountByIdentity('claude', 'A', 'o2')?.label).toBe('b');
  });

  it('updates account status', () => {
    const { row } = db.upsertAccount(acct());
    db.setAccountStatus(row.id, 'needs_relogin');
    expect(db.findAccountByLabel('codex', 'work')?.status).toBe('needs_relogin');
  });
});

describe('AppDb migrations', () => {
  it('does not re-run migrations when reopening an existing file DB', async () => {
    const paths = await tmpPaths();
    const file = path.join(paths.appData, 'app.db');
    const first = new AppDb(file);
    first.upsertAccount(acct());
    first.close();

    const second = new AppDb(file);
    expect(second.listAccounts()).toHaveLength(1);
    second.close();
  });
});

describe('AppDb rename/delete', () => {
  it('renames an account label', () => {
    const { row } = db.upsertAccount(acct());
    const updated = db.renameAccount(row.id, 'new-label');
    expect(updated.label).toBe('new-label');
    expect(db.findAccountByLabel('codex', 'new-label')?.id).toBe(row.id);
    expect(db.findAccountByLabel('codex', 'work')).toBeUndefined();
  });

  it('rejects renaming to a label already used by another account of the same tool', () => {
    const { row } = db.upsertAccount(acct());
    db.upsertAccount(acct({ accountId: 'B', label: 'other' }));
    expect(() => db.renameAccount(row.id, 'other')).toThrow("'other'");
    expect(db.findAccountByLabel('codex', 'work')?.id).toBe(row.id);
  });

  it('allows renaming to the same label (no-op)', () => {
    const { row } = db.upsertAccount(acct());
    expect(() => db.renameAccount(row.id, 'work')).not.toThrow();
  });

  it('deletes an account and nulls out its switch_events instead of removing them', () => {
    const { row } = db.upsertAccount(acct());
    db.recordSwitch('codex', row.id, 'ok', '2026-09-23T01:00:00Z');
    db.deleteAccount(row.id);
    expect(db.findAccountByLabel('codex', 'work')).toBeUndefined();
    expect(db.listSwitches('codex')).toEqual([{ accountRowId: null, switchedAt: '2026-09-23T01:00:00Z', result: 'ok' }]);
  });
});

describe('AppDb imports', () => {
  it('records imports and finds previous ones by source and target', () => {
    const at = '2026-09-29T00:00:00.000Z';
    db.recordImport({ srcTool: 'codex', srcKey: 'codex:t1', dstTool: 'claude', dstAccountKey: 'acctA/orgA', dstSessionId: 'new-1', importedAt: at, statsJson: '{}' });
    expect(db.findImports('codex', 'codex:t1', 'claude', 'acctA/orgA')).toEqual([
      { srcTool: 'codex', srcKey: 'codex:t1', dstTool: 'claude', dstAccountKey: 'acctA/orgA', dstSessionId: 'new-1', importedAt: at, statsJson: '{}' },
    ]);
    expect(db.findImports('codex', 'codex:t1', 'claude', 'other')).toEqual([]);
  });
  it('finds import history by source regardless of destination, and lists imported src keys once per tool', () => {
    const at = '2026-09-29T00:00:00.000Z';
    db.recordImport({ srcTool: 'codex', srcKey: 'codex:t1', dstTool: 'claude', dstAccountKey: 'acctA/orgA', dstSessionId: 'new-1', importedAt: at, statsJson: '{}' });
    db.recordImport({ srcTool: 'codex', srcKey: 'codex:t1', dstTool: 'claude', dstAccountKey: 'acctB/orgB', dstSessionId: 'new-2', importedAt: at, statsJson: '{}' });
    db.recordImport({ srcTool: 'codex', srcKey: 'codex:t2', dstTool: 'claude', dstAccountKey: 'acctA/orgA', dstSessionId: 'new-3', importedAt: at, statsJson: '{}' });

    expect(db.findImportsBySource('codex', 'codex:t1')).toHaveLength(2);
    expect(db.findImportsBySource('codex', 'codex:nope')).toEqual([]);

    expect(db.listImportedSrcKeys('codex')).toEqual(new Set(['codex:t1', 'codex:t2']));
    expect(db.listImportedSrcKeys('claude')).toEqual(new Set());
  });

  it('finds an account by its row id', () => {
    const { row } = db.upsertAccount(acct());
    expect(db.findAccountById(row.id)).toEqual(row);
    expect(db.findAccountById(row.id + 999)).toBeUndefined();
  });

  it('migrates a real v1-schema file database, preserving existing rows', async () => {
    const paths = await tmpPaths();
    const file = path.join(paths.appData, 'v1.db');

    // 마이그레이션 1만 적용된 실제 v1 스키마 DB 파일을 직접 만든다.
    const v1 = new Database(file);
    v1.exec(`
      CREATE TABLE accounts (
        id            INTEGER PRIMARY KEY,
        tool          TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        org_id        TEXT NOT NULL DEFAULT '',
        email         TEXT,
        display_name  TEXT,
        label         TEXT NOT NULL,
        snapshot_path TEXT NOT NULL,
        snapshot_at   TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'ok',
        UNIQUE (tool, account_id, org_id),
        UNIQUE (tool, label)
      );
      CREATE TABLE switch_events (
        id          INTEGER PRIMARY KEY,
        tool        TEXT NOT NULL,
        account_id  INTEGER REFERENCES accounts(id),
        switched_at TEXT NOT NULL,
        result      TEXT NOT NULL
      );
    `);
    v1.prepare(
      `INSERT INTO accounts (tool, account_id, org_id, email, display_name, label, snapshot_path, snapshot_at, status)
       VALUES ('codex', 'A', '', 'a@x.com', NULL, 'work', 'C:\\s\\a.bin', '2026-09-23T00:00:00Z', 'ok')`,
    ).run();
    v1.pragma('user_version = 1');
    v1.close();

    const opened = new AppDb(file);
    expect((opened as unknown as { db: { pragma(s: string, o: object): unknown } }).db.pragma('user_version', { simple: true })).toBe(3);
    expect(opened.listAccounts()).toEqual([
      {
        id: 1, tool: 'codex', accountId: 'A', orgId: '', email: 'a@x.com', displayName: null,
        label: 'work', snapshotPath: 'C:\\s\\a.bin', snapshotAt: '2026-09-23T00:00:00Z', status: 'ok', scope: 'auth',
      },
    ]);
    opened.recordImport({ srcTool: 'codex', srcKey: 'k', dstTool: 'claude', dstAccountKey: 'a/o', dstSessionId: 's', importedAt: '2026-09-29T00:00:00.000Z', statsJson: '{}' });
    expect(opened.findImports('codex', 'k', 'claude', 'a/o')).toHaveLength(1);
    opened.close();
  });
});

describe('AppDb scope column (migration 3)', () => {
  it('migrates a v2 file DB: existing rows get scope auth and new rows can record app-profile', async () => {
    const p = await tmpPaths();
    const file = path.join(p.appDataDir, 'v2.db');
    await import('node:fs/promises').then((f) => f.mkdir(p.appDataDir, { recursive: true }));
    const v2 = new Database(file);
    v2.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY, tool TEXT NOT NULL, account_id TEXT NOT NULL, org_id TEXT NOT NULL DEFAULT '',
        email TEXT, display_name TEXT, label TEXT NOT NULL, snapshot_path TEXT NOT NULL, snapshot_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ok', UNIQUE (tool, account_id, org_id), UNIQUE (tool, label)
      );
      CREATE TABLE switch_events (id INTEGER PRIMARY KEY, tool TEXT NOT NULL, account_id INTEGER REFERENCES accounts(id), switched_at TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE imports (id INTEGER PRIMARY KEY, src_tool TEXT NOT NULL, src_key TEXT NOT NULL, dst_tool TEXT NOT NULL, dst_account_key TEXT NOT NULL, dst_session_id TEXT NOT NULL, imported_at TEXT NOT NULL, stats_json TEXT NOT NULL);
      INSERT INTO accounts (tool, account_id, org_id, email, label, snapshot_path, snapshot_at) VALUES ('codex', 'A', '', 'a@x.com', 'work', 'C:\s\a.bin', '2026-09-23T00:00:00Z');
    `);
    v2.pragma('user_version = 2');
    v2.close();

    const opened = new AppDb(file);
    expect(opened.listAccounts().map((a) => a.scope)).toEqual(['auth']);
    opened.upsertAccount(acct({ accountId: 'B', label: 'prof', scope: 'auth+app-profile' }));
    expect(opened.findAccountByLabel('codex', 'prof')?.scope).toBe('auth+app-profile');
    // 같은 신원으로 다시 저장하면 범위도 갱신된다
    expect(opened.upsertAccount(acct({ accountId: 'B', label: 'prof', scope: 'auth' })).row.scope).toBe('auth');
    opened.close();
  });
});

describe('AppDb switch events', () => {
  it('records switches in order', () => {
    const { row } = db.upsertAccount(acct());
    db.recordSwitch('codex', row.id, 'ok', '2026-09-23T01:00:00Z');
    db.recordSwitch('codex', null, 'rolled_back', '2026-09-23T02:00:00Z');
    expect(db.listSwitches('codex')).toEqual([
      { accountRowId: row.id, switchedAt: '2026-09-23T01:00:00Z', result: 'ok' },
      { accountRowId: null, switchedAt: '2026-09-23T02:00:00Z', result: 'rolled_back' },
    ]);
  });
});
