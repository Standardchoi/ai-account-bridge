import crypto from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

async function statOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

interface CreatedEntry { kind: 'created'; path: string }
interface ModifiedEntry { kind: 'modified'; path: string; original: Buffer; backupPath: string }
interface CompensateEntry { kind: 'compensate'; fn: () => Promise<void> | void }
type Entry = CreatedEntry | ModifiedEntry | CompensateEntry;

// 아직 commit/rollback 되지 않은 트랜잭션이 복원에 쓸 백업 파일 — pruneBackups 가 지우지 않는다.
const liveBackups = new Set<string>();
const TX_BACKUP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/;

// FsTransaction 이 만든 백업 파일(<uuid>-<원본이름>)만 최근 keep 개 남기고 지운다. 하위 폴더(BackupStore 의 도구별
// 폴더 등)와 다른 이름의 파일, 진행 중인 트랜잭션의 백업은 건드리지 않는다. 폴더가 없으면 아무것도 하지 않는다.
export async function pruneBackups(dir: string, keep: number): Promise<void> {
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const files: { full: string; mtime: number }[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !TX_BACKUP_NAME.test(d.name)) continue;
    const full = path.join(dir, d.name);
    if (liveBackups.has(full)) continue;
    try {
      files.push({ full, mtime: (await fs.stat(full)).mtimeMs });
    } catch {
      // 그 사이 사라진 파일은 무시
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(Math.max(0, keep))) await fs.rm(f.full, { force: true });
}

// 이관 쓰기 작업을 추적해 실패 시 되돌릴 수 있게 하는 간단한 파일 시스템 트랜잭션.
// 생성한 파일은 삭제하고, 수정한 파일은 원본 바이트로 복원한다(역순으로).
export class FsTransaction {
  private entries: Entry[] = [];
  private ownBackups: string[] = [];

  constructor(private readonly backupDir: string) {}

  async createFile(filePath: string, data: string | Buffer): Promise<void> {
    if ((await statOrUndefined(filePath)) !== undefined) throw new Error(`file already exists: ${filePath}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // 임시 파일에 먼저 쓰고 원자적으로 rename 해서, 쓰다 만 파일이 최종 경로에 남지 않게 한다.
    const tmpPath = `${filePath}.aab-tmp-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(tmpPath, data);
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
    this.entries.push({ kind: 'created', path: filePath });
  }

  async backupThenModify(filePath: string, fn: () => Promise<void>): Promise<void> {
    const original = await fs.readFile(filePath);
    await fs.mkdir(this.backupDir, { recursive: true });
    const backupPath = path.join(this.backupDir, `${crypto.randomUUID()}-${path.basename(filePath)}`);
    await fs.writeFile(backupPath, original);
    liveBackups.add(backupPath);
    this.ownBackups.push(backupPath);
    this.entries.push({ kind: 'modified', path: filePath, original, backupPath });
    await fn();
  }

  // 파일 되돌리기만으로는 표현할 수 없는 되돌리기(예: DB 행 삭제)를 등록한다. rollback() 시 등록 역순으로,
  // 파일 되돌리기와 같은 목록에서 함께 실행된다.
  onRollback(fn: () => Promise<void> | void): void {
    this.entries.push({ kind: 'compensate', fn });
  }

  // 실패한 되돌리기는 목록에 남겨 다음 rollback() 호출에서 다시 시도할 수 있게 한다.
  async rollback(): Promise<void> {
    const remaining: Entry[] = [];
    const errors: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      try {
        if (entry.kind === 'created') {
          await fs.rm(entry.path, { force: true });
        } else if (entry.kind === 'modified') {
          await fs.writeFile(entry.path, entry.original);
        } else {
          await entry.fn();
        }
      } catch (err) {
        errors.push(err);
        remaining.push(entry);
      }
    }
    this.entries = remaining.reverse();
    this.releaseBackups();
    if (errors.length > 0) {
      throw new Error(`rollback failed for ${errors.length} item(s): ${errors.map(String).join('; ')}`);
    }
  }

  commit(): void {
    this.entries = [];
    this.releaseBackups();
  }

  // 아직 남은(되돌리기 실패) 항목의 백업만 live 로 유지한다.
  private releaseBackups(): void {
    const needed = new Set(this.entries.flatMap((e) => (e.kind === 'modified' ? [e.backupPath] : [])));
    for (const b of this.ownBackups) if (!needed.has(b)) liveBackups.delete(b);
    this.ownBackups = this.ownBackups.filter((b) => needed.has(b));
  }
}
