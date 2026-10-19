import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppDb } from '../../src/main/infra/app-db.js';
import { migrateAppData } from '../../src/main/infra/data-migration.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { exists, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

async function setup(): Promise<PathProvider> {
  const p = await tmpPaths();
  // 실제 머신처럼 AppData 가 홈 아래에 있게 한다 (로그의 ~ 치환 검증)
  const appData = path.join(p.home, 'AppData', 'Roaming');
  const localAppData = path.join(p.home, 'AppData', 'Local');
  return { home: p.home, appData, localAppData, claudeDesktop: path.join(appData, 'Claude'), appDataDir: path.join(p.home, '.ai-account-bridge') };
}

const pkgDir = (p: PathProvider, pkg: string) => path.join(p.localAppData, 'Packages', pkg, 'LocalCache', 'Roaming', 'ai-account-bridge');
const roamingDir = (p: PathProvider) => path.join(p.appData, 'ai-account-bridge');

// dir 에 app.db 를 만들고 labels 마다 계정을 넣는다. keepOpen 이면 닫지 않고 돌려줘서 -wal 이 남게 한다.
async function makeDb(dir: string, labels: string[], keepOpen = false): Promise<AppDb | undefined> {
  await fs.mkdir(dir, { recursive: true });
  const db = new AppDb(path.join(dir, 'app.db'));
  for (const label of labels) {
    db.upsertAccount({
      tool: 'codex',
      accountId: `id-${label}`,
      orgId: '',
      email: `${label}@x.com`,
      displayName: label,
      label,
      snapshotPath: path.join(dir, 'profiles', 'codex', `${label}.bin`),
      snapshotAt: '2026-01-01T00:00:00.000Z',
    });
  }
  if (keepOpen) return db;
  db.close();
  return undefined;
}

function rawUpdate(dbFile: string, sql: string, ...args: unknown[]): void {
  const raw = new Database(dbFile);
  raw.prepare(sql).run(...args);
  raw.close();
}

const logs = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
};

describe('migrateAppData', () => {
  it('is a no-op when the new DB already exists', async () => {
    const p = await setup();
    await makeDb(p.appDataDir, ['new']);
    await makeDb(pkgDir(p, 'Claude_x'), ['a', 'b']);
    const { lines, log } = logs();
    expect(await migrateAppData(p, log)).toEqual({ status: 'skipped' });
    const db = new AppDb(path.join(p.appDataDir, 'app.db'));
    expect(db.listAccounts().map((a) => a.label)).toEqual(['new']);
    db.close();
    expect(lines).toEqual([]);
  });

  it('returns none when there is no candidate', async () => {
    const p = await setup();
    expect(await migrateAppData(p, () => {})).toEqual({ status: 'none' });
    expect(await exists(path.join(p.appDataDir, 'app.db'))).toBe(false);
  });

  it('picks the candidate with accounts over an empty fresh one, and copies profiles/backups', async () => {
    const p = await setup();
    await makeDb(roamingDir(p), []); // GUI 가 실제 %APPDATA% 에 만든 빈 DB (더 최근)
    const src = pkgDir(p, 'Claude_pzs8sxrjxfjjc');
    await makeDb(src, ['one', 'two']);
    await writeFile(path.join(src, 'profiles', 'codex', 'one.bin'), 'AAA');
    await writeFile(path.join(src, 'backups', 'codex', 'b1.bin'), 'BBB');
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(roamingDir(p), 'app.db'), future, future);

    const { lines, log } = logs();
    const r = await migrateAppData(p, log);
    expect(r).toEqual({ status: 'migrated', source: src, accounts: 2 });
    const db = new AppDb(path.join(p.appDataDir, 'app.db'));
    expect(db.listAccounts().map((a) => a.label)).toEqual(['one', 'two']);
    db.close();
    expect(await fs.readFile(path.join(p.appDataDir, 'profiles', 'codex', 'one.bin'), 'utf8')).toBe('AAA');
    expect(await fs.readFile(path.join(p.appDataDir, 'backups', 'codex', 'b1.bin'), 'utf8')).toBe('BBB');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('계정 2개');
    expect(lines[0]).toContain('~');
    expect(lines[0]).not.toContain(p.home);
    expect(await exists(path.join(p.appDataDir, 'app.db.migrating'))).toBe(false);
  });

  it('breaks an account-count tie by newest app.db mtime', async () => {
    const p = await setup();
    const older = pkgDir(p, 'Old_pkg');
    const newer = roamingDir(p);
    await makeDb(older, ['x']);
    await makeDb(newer, ['y']);
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(path.join(older, 'app.db'), past, past);
    expect(await migrateAppData(p, () => {})).toMatchObject({ status: 'migrated', source: newer });
  });

  it('includes WAL content and never modifies the sources', async () => {
    const p = await setup();
    const src = pkgDir(p, 'Claude_x');
    const live = (await makeDb(src, ['walonly'], true))!; // 열어 둔 채 → -wal 에 내용이 있을 수 있음
    const snapshotSource = async () => {
      const out: Record<string, string> = {};
      for (const f of (await fs.readdir(src)).sort()) {
        const st = await fs.stat(path.join(src, f));
        out[f] = `${st.size}:${st.mtimeMs}`;
      }
      return out;
    };
    const before = await snapshotSource();
    const r = await migrateAppData(p, () => {});
    const after = await snapshotSource();
    live.close();
    expect(r).toMatchObject({ status: 'migrated', accounts: 1 });
    expect(after).toEqual(before);
    const db = new AppDb(path.join(p.appDataDir, 'app.db'));
    expect(db.listAccounts().map((a) => a.label)).toEqual(['walonly']);
    db.close();
  });

  it('rewrites snapshot_path recorded as the real APPDATA path (virtualized writes) to the new dir', async () => {
    const p = await setup();
    const src = pkgDir(p, 'Claude_x');
    await makeDb(src, ['one']);
    rawUpdate(path.join(src, 'app.db'), 'UPDATE accounts SET snapshot_path = ?', path.join(roamingDir(p), 'profiles', 'codex', 'one.bin'));

    await migrateAppData(p, () => {});
    const db = new AppDb(path.join(p.appDataDir, 'app.db'));
    expect(db.listAccounts()[0]!.snapshotPath).toBe(path.join(p.appDataDir, 'profiles', 'codex', 'one.bin'));
    db.close();
  });

  it('rewrites paths under the selected dir, leaves unrelated paths alone, and does not touch the source DB', async () => {
    const p = await setup();
    const src = pkgDir(p, 'Claude_x');
    await makeDb(src, ['one', 'two']);
    rawUpdate(path.join(src, 'app.db'), "UPDATE accounts SET snapshot_path = ? WHERE label = 'two'", 'D:\\elsewhere\\two.bin');
    await migrateAppData(p, () => {});

    const db = new AppDb(path.join(p.appDataDir, 'app.db'));
    const byLabel = Object.fromEntries(db.listAccounts().map((a) => [a.label, a.snapshotPath]));
    expect(byLabel.one).toBe(path.join(p.appDataDir, 'profiles', 'codex', 'one.bin'));
    expect(byLabel.two).toBe('D:\\elsewhere\\two.bin');
    db.close();

    const orig = new AppDb(path.join(src, 'app.db'));
    expect(orig.listAccounts().find((a) => a.label === 'one')!.snapshotPath).toBe(path.join(src, 'profiles', 'codex', 'one.bin'));
    orig.close();
  });
});
