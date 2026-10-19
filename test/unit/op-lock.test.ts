import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { acquireOpLock } from '../../src/main/infra/op-lock.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oplock-'));
});

describe('acquireOpLock', () => {
  it('rejects a second acquire while held, naming op and pid', async () => {
    const release = await acquireOpLock(dir, 'switch');
    await expect(acquireOpLock(dir, 'save')).rejects.toThrow(`다른 창(또는 CLI)에서 작업이 진행 중입니다 (switch, pid ${process.pid})`);
    await release();
  });

  it('removes the file on release and can be re-acquired', async () => {
    const release = await acquireOpLock(dir, 'save');
    await release();
    await expect(fs.access(path.join(dir, 'op.lock'))).rejects.toThrow();
    await (await acquireOpLock(dir, 'save'))();
  });

  it('replaces a stale lock whose pid is dead', async () => {
    await fs.writeFile(path.join(dir, 'op.lock'), JSON.stringify({ pid: 2147483646, startedAt: Date.now(), op: 'old' }));
    const release = await acquireOpLock(dir, 'new');
    const info = JSON.parse(await fs.readFile(path.join(dir, 'op.lock'), 'utf8'));
    expect(info.op).toBe('new');
    expect(info.pid).toBe(process.pid);
    await release();
  });

  it('replaces a lock older than 12 hours even if the pid is alive', async () => {
    await fs.writeFile(path.join(dir, 'op.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now() - 13 * 3600_000, op: 'old' }));
    await (await acquireOpLock(dir, 'new'))();
  });

  it('treats a fresh unreadable lock as busy', async () => {
    await fs.writeFile(path.join(dir, 'op.lock'), 'garbage');
    await expect(acquireOpLock(dir, 'x')).rejects.toThrow('작업이 진행 중입니다');
  });

  it('lets exactly one of two racing acquires take over a stale lock', async () => {
    await fs.writeFile(path.join(dir, 'op.lock'), JSON.stringify({ pid: 2147483646, startedAt: Date.now(), op: 'old', token: 't' }));
    const results = await Promise.allSettled([acquireOpLock(dir, 'a'), acquireOpLock(dir, 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(fs.access(path.join(dir, 'op.lock.reclaim'))).rejects.toThrow();
  });

  it('release does not delete a lock with a different token', async () => {
    const release = await acquireOpLock(dir, 'save');
    const other = JSON.stringify({ pid: process.pid, startedAt: Date.now(), op: 'other', token: 'not-ours' });
    await fs.writeFile(path.join(dir, 'op.lock'), other);
    await release();
    expect(await fs.readFile(path.join(dir, 'op.lock'), 'utf8')).toBe(other);
  });

  it('reclaims an empty lock file older than 10s but not a fresh one', async () => {
    const f = path.join(dir, 'op.lock');
    await fs.writeFile(f, '');
    await expect(acquireOpLock(dir, 'x')).rejects.toThrow('작업이 진행 중입니다');
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(f, old, old);
    await (await acquireOpLock(dir, 'x'))();
  });

  it('reclaims a lock with an invalid pid', async () => {
    await fs.writeFile(path.join(dir, 'op.lock'), JSON.stringify({ pid: 0, startedAt: Date.now(), op: 'old', token: 't' }));
    await (await acquireOpLock(dir, 'x'))();
  });

  it('removes a reclaim file older than 30s and proceeds', async () => {
    await fs.writeFile(path.join(dir, 'op.lock'), JSON.stringify({ pid: 2147483646, startedAt: Date.now(), op: 'old', token: 't' }));
    const rf = path.join(dir, 'op.lock.reclaim');
    await fs.writeFile(rf, '');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(rf, old, old);
    await (await acquireOpLock(dir, 'x'))();
  });
});
