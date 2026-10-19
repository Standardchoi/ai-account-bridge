import { openSqlite } from './sqlite.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { displayPath, type PathProvider } from './path-provider.js';

export type MigrationResult =
  | { status: 'skipped' } // 새 위치에 이미 app.db 가 있음
  | { status: 'none' } // 옮길 후보가 없음
  | { status: 'migrated'; source: string; accounts: number };

interface Candidate {
  dir: string;
  db: string;
  accounts: number;
  mtimeMs: number;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

// MSIX 앱 안에서 실행된 프로세스의 %APPDATA% 쓰기는 %LOCALAPPDATA%\Packages\<패키지>\LocalCache\Roaming 으로
// 가상화된다. 예전 저장소가 어느 쪽에 있을지 모르므로 모든 패키지 폴더를 먼저, 실제 %APPDATA% 를 마지막에 본다.
export async function legacyDataDirs(paths: PathProvider): Promise<string[]> {
  const dirs: string[] = [];
  const pkgRoot = path.join(paths.localAppData, 'Packages');
  let pkgs: string[] = [];
  try {
    pkgs = (await fs.readdir(pkgRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* Packages 폴더 없음 */
  }
  for (const pkg of pkgs) dirs.push(path.join(pkgRoot, pkg, 'LocalCache', 'Roaming', 'ai-account-bridge'));
  dirs.push(path.join(paths.appData, 'ai-account-bridge'));
  return dirs;
}

// 원본은 절대 건드리지 않는다: app.db(+wal/shm)를 임시 폴더로 복사한 뒤 그 복사본을 연다.
async function copyDbToTemp(dbFile: string, tmpDir: string): Promise<string> {
  const copy = path.join(tmpDir, 'app.db');
  await fs.copyFile(dbFile, copy);
  for (const ext of ['-wal', '-shm']) {
    if (await exists(dbFile + ext)) await fs.copyFile(dbFile + ext, copy + ext);
  }
  return copy;
}

function countAccounts(dbFile: string): number {
  const db = openSqlite(dbFile);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const norm = (p: string) => path.normalize(p).toLowerCase();

// oldDirs 중 하나로 시작하는 snapshot_path 를 newDir 아래 같은 상대 경로로 바꾼다 (복사본 DB 에서만).
function rewriteSnapshotPaths(dbFile: string, oldDirs: string[], newDir: string): void {
  const db = openSqlite(dbFile);
  try {
    const rows = db.prepare('SELECT id, snapshot_path AS p FROM accounts').all() as { id: number; p: string }[];
    const update = db.prepare('UPDATE accounts SET snapshot_path = ? WHERE id = ?');
    db.transaction(() => {
      for (const r of rows) {
        const np = norm(r.p);
        const old = oldDirs.find((d) => np.startsWith(norm(d) + path.sep));
        if (old) update.run(path.join(newDir, path.normalize(r.p).slice(path.normalize(old).length + 1)), r.id);
      }
    })();
  } finally {
    db.close();
  }
}

export async function migrateAppData(paths: PathProvider, log: (line: string) => void): Promise<MigrationResult> {
  const newDb = path.join(paths.appDataDir, 'app.db');
  if (await exists(newDb)) return { status: 'skipped' };

  const all = await legacyDataDirs(paths);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aab-migrate-'));
  try {
    const candidates: (Candidate & { tmpCopy: string })[] = [];
    for (const dir of all) {
      const dbFile = path.join(dir, 'app.db');
      let st;
      try {
        st = await fs.stat(dbFile);
      } catch {
        continue;
      }
      const sub = await fs.mkdtemp(path.join(tmpDir, 'c-'));
      try {
        const tmpCopy = await copyDbToTemp(dbFile, sub);
        candidates.push({ dir, db: dbFile, accounts: countAccounts(tmpCopy), mtimeMs: st.mtimeMs, tmpCopy });
      } catch (e) {
        log(`이전 데이터 후보 건너뜀 (${displayPath(dir, paths.home)}): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (candidates.length === 0) return { status: 'none' };
    candidates.sort((a, b) => b.accounts - a.accounts || b.mtimeMs - a.mtimeMs);
    const best = candidates[0]!;

    await fs.mkdir(paths.appDataDir, { recursive: true });
    for (const sub of ['profiles', 'backups']) {
      const src = path.join(best.dir, sub);
      if (await exists(src)) await fs.cp(src, path.join(paths.appDataDir, sub), { recursive: true });
    }
    rewriteSnapshotPaths(best.tmpCopy, all, paths.appDataDir);
    // app.db 는 커밋 마커 — 임시 이름으로 완성한 뒤 rename 해서, 중간에 실패해도 다음 실행이 다시 시도하게 한다.
    const partial = `${newDb}.migrating`;
    await fs.rm(partial, { force: true });
    const tmpDb = openSqlite(best.tmpCopy);
    try {
      await tmpDb.backup(partial);
    } finally {
      tmpDb.close();
    }
    await fs.rename(partial, newDb);

    log(`이전 데이터 이전: ${displayPath(best.dir, paths.home)} (계정 ${best.accounts}개)`);
    return { status: 'migrated', source: best.dir, accounts: best.accounts };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
