import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/main/infra/sqlite.js';

afterEach(() => {
  delete process.env.AAB_SQLITE_ADDON;
});

describe('openSqlite', () => {
  it('opens a database with the default native module', () => {
    const db = openSqlite(':memory:');
    expect(db.prepare('SELECT 1 + 1 AS v').get()).toEqual({ v: 2 });
    db.close();
  });

  it('loads the native module from AAB_SQLITE_ADDON (sidecar executable, where require cannot load .node files)', () => {
    process.env.AAB_SQLITE_ADDON = path.resolve('node_modules/better-sqlite3/prebuilds/win32-x64.node');
    const db = openSqlite(':memory:', { timeout: 1000 });
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (7)');
    expect(db.prepare('SELECT x FROM t').get()).toEqual({ x: 7 });
    db.close();
  });
});
