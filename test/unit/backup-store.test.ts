import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthBundle } from '../../src/main/core/auth-bundle.js';
import { BackupStore } from '../../src/main/infra/backup-store.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { exists, tmpPaths } from '../helpers/tmp-paths.js';

const bundle = (data: string): AuthBundle => ({
  tool: 'codex',
  files: [{ root: 'home', relPath: '.codex/auth.json', data: Buffer.from(data).toString('base64') }],
  replaceDirs: [],
  jsonKeys: [],
});

describe('BackupStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves an encrypted backup and loads it back', async () => {
    const p = await tmpPaths();
    const store = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore());
    const file = await store.save(bundle('A'));
    expect(file.startsWith(path.join(p.appDataDir, 'backups', 'codex'))).toBe(true);
    expect((await fs.readFile(file)).subarray(0, 5).toString()).toBe('FAKE:');
    expect(await store.load(file)).toEqual(bundle('A'));
  });

  it('keeps only the newest N backups per tool', async () => {
    const p = await tmpPaths();
    const store = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore(), 2);
    await store.save(bundle('1'));
    await store.save(bundle('2'));
    await store.save(bundle('3'));
    expect(await fs.readdir(path.join(p.appDataDir, 'backups', 'codex'))).toHaveLength(2);
  });

  it('excludes a protected file from pruning even beyond the keep count', async () => {
    const p = await tmpPaths();
    const store = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore(), 1);
    const protectedFile = await store.save(bundle('protect-me'));
    for (let i = 0; i < 5; i++) {
      await store.save(bundle(`${i}`), protectedFile);
    }
    expect(await exists(protectedFile)).toBe(true);
    expect(await store.load(protectedFile)).toEqual(bundle('protect-me'));
  });

  it('never prunes the backup that was just written', async () => {
    vi.useFakeTimers();
    const now = new Date('2025-01-01T12:00:00Z');
    vi.setSystemTime(now);

    const p = await tmpPaths();
    const store = new BackupStore(path.join(p.appDataDir, 'backups'), fakeSecretStore(), 1);
    const toolDir = path.join(p.appDataDir, 'backups', 'codex');

    for (let i = 0; i < 5; i++) {
      const file = await store.save(bundle(`${i}`));
      expect(await exists(file)).toBe(true);
      expect(await fs.readdir(toolDir)).toHaveLength(1);
    }
  });
});
