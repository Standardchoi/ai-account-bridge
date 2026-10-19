import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FsTransaction, pruneBackups } from '../../src/main/infra/fs-transaction.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

describe('FsTransaction', () => {
  it('deletes a created file on rollback', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'new.txt');
    const tx = new FsTransaction(backupDir);

    await tx.createFile(target, 'hello');
    expect(await exists(target)).toBe(true);

    await tx.rollback();
    expect(await exists(target)).toBe(false);
  });

  it('restores the original bytes of a modified file on rollback', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'existing.txt');
    await writeFile(target, 'original');
    const tx = new FsTransaction(backupDir);

    await tx.backupThenModify(target, async () => {
      await fs.writeFile(target, 'modified');
    });
    expect(await readText(target)).toBe('modified');

    await tx.rollback();
    expect(await readText(target)).toBe('original');
  });

  it('rejects createFile when the file already exists', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'existing.txt');
    await writeFile(target, 'original');
    const tx = new FsTransaction(backupDir);

    await expect(tx.createFile(target, 'new')).rejects.toThrow();
  });

  it('does nothing on rollback after commit', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'new.txt');
    const tx = new FsTransaction(backupDir);

    await tx.createFile(target, 'hello');
    tx.commit();
    await tx.rollback();

    expect(await exists(target)).toBe(true);
    expect(await readText(target)).toBe('hello');
  });

  it('does not throw when a created file was already deleted by someone else', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'new.txt');
    const tx = new FsTransaction(backupDir);

    await tx.createFile(target, 'hello');
    await fs.rm(target);

    await expect(tx.rollback()).resolves.not.toThrow();
  });

  it('writes backups under backupDir', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'existing.txt');
    await writeFile(target, 'original');
    const tx = new FsTransaction(backupDir);

    await tx.backupThenModify(target, async () => {
      await fs.writeFile(target, 'modified');
    });

    const files = await fs.readdir(backupDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it('retries only the entries that failed to undo on a later rollback() call', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'existing.txt');
    await writeFile(target, 'original');
    const tx = new FsTransaction(backupDir);

    await tx.backupThenModify(target, async () => {
      await fs.writeFile(target, 'modified');
    });

    // obstruct the restore: replace the file with a directory so writeFile fails
    await fs.rm(target, { force: true });
    await fs.mkdir(target);

    await expect(tx.rollback()).rejects.toThrow();
    expect((await fs.stat(target)).isDirectory()).toBe(true);

    // fix the obstacle, then retry
    await fs.rmdir(target);
    await tx.rollback();
    expect(await readText(target)).toBe('original');
  });

  it('does not leave a temp file behind after a successful createFile', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'new.txt');
    const tx = new FsTransaction(backupDir);

    await tx.createFile(target, 'hello');

    const files = await fs.readdir(p.appDataDir);
    expect(files).toEqual(['new.txt']);
  });

  it('rethrows non-ENOENT stat errors from createFile instead of treating them as missing', async () => {
    const p = await tmpPaths();
    const backupDir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'blocked.txt');
    const tx = new FsTransaction(backupDir);
    const err = Object.assign(new Error('boom'), { code: 'EACCES' });
    const spy = vi.spyOn(fs, 'stat').mockRejectedValueOnce(err);

    await expect(tx.createFile(target, 'x')).rejects.toBe(err);

    spy.mockRestore();
  });

  describe('onRollback', () => {
    it('runs a compensating action on rollback and also undoes files created around it', async () => {
      const p = await tmpPaths();
      const backupDir = path.join(p.appDataDir, 'backups');
      const first = path.join(p.appDataDir, 'first.txt');
      const second = path.join(p.appDataDir, 'second.txt');
      const tx = new FsTransaction(backupDir);
      let compensated = false;

      await tx.createFile(first, 'a');
      tx.onRollback(() => { compensated = true; });
      await tx.createFile(second, 'b');

      await tx.rollback();

      expect(compensated).toBe(true);
      expect(await exists(first)).toBe(false);
      expect(await exists(second)).toBe(false);
    });

    it('runs compensating actions and file undo together, in reverse registration order', async () => {
      const p = await tmpPaths();
      const backupDir = path.join(p.appDataDir, 'backups');
      const tx = new FsTransaction(backupDir);
      const order: string[] = [];
      tx.onRollback(() => { order.push('one'); });
      await tx.createFile(path.join(p.appDataDir, 'mid.txt'), 'x');
      tx.onRollback(() => { order.push('three'); });

      await tx.rollback();

      expect(order).toEqual(['three', 'one']); // 파일 삭제(가운데)는 순서 배열에 안 남지만 등록 역순으로 실행된다
      expect(await exists(path.join(p.appDataDir, 'mid.txt'))).toBe(false);
    });

    it('awaits an async compensating action', async () => {
      const p = await tmpPaths();
      const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
      let ran = false;
      tx.onRollback(async () => {
        await new Promise((r) => setTimeout(r, 1));
        ran = true;
      });

      await tx.rollback();

      expect(ran).toBe(true);
    });

    it('keeps a failed compensating action for retry on a later rollback() call, like other entries', async () => {
      const p = await tmpPaths();
      const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
      let attempts = 0;
      tx.onRollback(() => {
        attempts++;
        if (attempts === 1) throw new Error('not ready yet');
      });

      await expect(tx.rollback()).rejects.toThrow('not ready yet');
      expect(attempts).toBe(1);

      await tx.rollback();
      expect(attempts).toBe(2);
    });

    it('is cleared by commit, like other entries', async () => {
      const p = await tmpPaths();
      const tx = new FsTransaction(path.join(p.appDataDir, 'backups'));
      let ran = false;
      tx.onRollback(() => { ran = true; });

      tx.commit();
      await tx.rollback();

      expect(ran).toBe(false);
    });
  });
});

describe('pruneBackups', () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

  it('keeps only the newest N transaction backup files and leaves other entries alone', async () => {
    const p = await tmpPaths();
    const dir = path.join(p.appDataDir, 'backups');
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `${uuid(i)}-a.jsonl`);
      await writeFile(f, `v${i}`);
      await fs.utimes(f, new Date(2026, 0, 1, 0, i), new Date(2026, 0, 1, 0, i));
    }
    await writeFile(path.join(dir, 'claude', '20260101-abc.bin'), 'x'); // BackupStore 하위 폴더
    await writeFile(path.join(dir, 'notes.txt'), 'x');

    await pruneBackups(dir, 2);

    const left = (await fs.readdir(dir)).sort();
    expect(left).toEqual([`${uuid(4)}-a.jsonl`, `${uuid(5)}-a.jsonl`, 'claude', 'notes.txt']);
    expect(await exists(path.join(dir, 'claude', '20260101-abc.bin'))).toBe(true);
  });

  it('does nothing when the directory does not exist', async () => {
    const p = await tmpPaths();
    await expect(pruneBackups(path.join(p.appDataDir, 'nope'), 5)).resolves.toBeUndefined();
  });

  it('never deletes the backup of a transaction that is still live, and frees it after commit', async () => {
    const p = await tmpPaths();
    const dir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'live.txt');
    await writeFile(target, 'orig');
    const tx = new FsTransaction(dir);
    await tx.backupThenModify(target, async () => { await fs.writeFile(target, 'new'); });
    const [backup] = await fs.readdir(dir);

    await pruneBackups(dir, 0);
    expect(await exists(path.join(dir, backup!))).toBe(true);
    await tx.rollback(); // 롤백이 백업 원본이 아닌 메모리 사본을 쓰더라도 파일은 유지되어야 한다
    expect(await readText(target)).toBe('orig');

    await pruneBackups(dir, 0);
    expect(await exists(path.join(dir, backup!))).toBe(false);
  });

  it('keeps the backup of a transaction whose rollback failed', async () => {
    const p = await tmpPaths();
    const dir = path.join(p.appDataDir, 'backups');
    const target = path.join(p.appDataDir, 'stuck.txt');
    await writeFile(target, 'orig');
    const tx = new FsTransaction(dir);
    await tx.backupThenModify(target, async () => {});
    const spy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('locked'));
    await expect(tx.rollback()).rejects.toThrow('rollback failed');
    spy.mockRestore();

    await pruneBackups(dir, 0);
    expect((await fs.readdir(dir)).length).toBe(1);
    await tx.rollback();
  });
});
