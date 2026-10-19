import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const LOCK_FILE = 'op.lock';
const RECLAIM_FILE = 'op.lock.reclaim';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 살아 있는 pid 라도 이보다 오래된 잠금은 오래된 것으로 본다 (pid 재사용 대비 최후 수단)
const UNPARSEABLE_GRACE_MS = 10_000; // 만들어지는 중인 잠금 파일을 오래된 것으로 오판하지 않기 위한 유예
const RECLAIM_STALE_MS = 30_000;
const RECLAIM_RETRY_MS = 20;
const MAX_ATTEMPTS = 100;

interface LockInfo {
  pid: number;
  startedAt: number;
  op: string;
  token: string;
  procStart: number; // 이 프로세스의 시작 시각(초 단위). 기록만 한다 — 아래 isAlive 참고
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = 프로세스 없음. EPERM 등은 살아 있지만 권한이 없는 경우이므로 살아 있는 것으로 본다.
    // pid 재사용으로 다른 프로세스가 같은 pid 를 쓰는 경우는 무거운 Windows 조회 없이는 확인할 수 없어
    // 살아 있는 것으로 유지한다 — 그 경우 12시간 기준(MAX_AGE_MS)이 최후 수단이다.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseInfo(raw: string): LockInfo | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof v.startedAt === 'number' && typeof v.op === 'string') return v as LockInfo;
  } catch {
    /* 파싱 실패 */
  }
  return undefined;
}

const validPid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0;

async function readRaw(file: string): Promise<{ raw: string; mtimeMs: number } | undefined> {
  try {
    const [raw, st] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return { raw, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

function isStale(raw: string, mtimeMs: number): boolean {
  const info = parseInfo(raw);
  if (!info) return Date.now() - mtimeMs > UNPARSEABLE_GRACE_MS;
  if (!validPid(info.pid)) return true;
  return Date.now() - info.startedAt > MAX_AGE_MS || !isAlive(info.pid);
}

const busyError = (raw: string | undefined): Error => {
  const info = raw === undefined ? undefined : parseInfo(raw);
  return new Error(`다른 창(또는 CLI)에서 작업이 진행 중입니다 (${info?.op ?? '알 수 없음'}, pid ${info?.pid ?? '?'})`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 오래된 잠금을 걷어낸다. 여러 프로세스가 동시에 걷어내다 서로 새 잠금을 지우지 않도록 op.lock.reclaim 으로
// 직렬화하고, 그 안에서 op.lock 이 여전히 같은 오래된 잠금인지 다시 확인한 뒤에만 지운다.
async function reclaim(dir: string, lockFile: string, staleRaw: string): Promise<void> {
  const reclaimFile = path.join(dir, RECLAIM_FILE);
  try {
    await (await fs.open(reclaimFile, 'wx')).close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    try {
      if (Date.now() - (await fs.stat(reclaimFile)).mtimeMs > RECLAIM_STALE_MS) await fs.unlink(reclaimFile);
    } catch {
      /* 그 사이 사라짐 */
    }
    await sleep(RECLAIM_RETRY_MS);
    return; // 호출자가 처음부터 다시 판단한다
  }
  try {
    const now = await readRaw(lockFile);
    if (now && now.raw === staleRaw) await fs.unlink(lockFile).catch(() => {});
  } finally {
    await fs.unlink(reclaimFile).catch(() => {});
  }
}

// 프로세스 간 쓰기 작업 잠금 — 앱 데이터 폴더의 op.lock 을 'wx' 로 만들어 GUI/CLI 가 동시에 쓰지 못하게 한다.
// 반환값은 잠금을 푸는 함수(우리가 만든 잠금일 때만 지운다).
export async function acquireOpLock(dir: string, op: string): Promise<() => Promise<void>> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const token = crypto.randomUUID();
  const info: LockInfo = {
    pid: process.pid,
    startedAt: Date.now(),
    op,
    token,
    procStart: Math.round(Date.now() / 1000 - process.uptime()),
  };

  let lastRaw: string | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const fh = await fs.open(file, 'wx');
      try {
        await fh.writeFile(JSON.stringify(info));
      } finally {
        await fh.close();
      }
      return async () => {
        const cur = await readRaw(file);
        if (cur && parseInfo(cur.raw)?.token === token) await fs.unlink(file).catch(() => {});
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    const existing = await readRaw(file);
    if (!existing) continue; // 그 사이 사라짐
    lastRaw = existing.raw;
    if (!isStale(existing.raw, existing.mtimeMs)) throw busyError(existing.raw);
    await reclaim(dir, file, existing.raw);
  }
  throw busyError(lastRaw);
}
