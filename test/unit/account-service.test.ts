import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { deserializeBundle } from '../../src/main/core/auth-bundle.js';
import { AppDb } from '../../src/main/infra/app-db.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { claudeAuthProvider } from '../../src/main/providers/claude/auth.js';
import { codexAuthProvider } from '../../src/main/providers/codex/auth.js';
import { AccountService } from '../../src/main/services/account-service.js';
import { writeClaudeAuth, writeCodexAuth } from '../helpers/fake-auth.js';
import { fakeSecretStore } from '../helpers/fake-secrets.js';
import { tmpPaths } from '../helpers/tmp-paths.js';

let p: PathProvider;
let svc: AccountService;
let db: AppDb;

beforeEach(async () => {
  p = await tmpPaths();
  db = new AppDb(':memory:');
  svc = new AccountService({
    db,
    secrets: fakeSecretStore(),
    paths: p,
    providers: { codex: codexAuthProvider(p), claude: claudeAuthProvider(p) },
  });
});

describe('AccountService scope', () => {
  it('records scope auth for an auth-only snapshot', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const { row } = await svc.saveCurrent('codex', 'work');
    expect(row.scope).toBe('auth');
  });

  it.each([['codex' as const], ['claude' as const]])('records scope auth+app-profile when %s provider collects the app profile', async (tool) => {
    if (tool === 'codex') await writeCodexAuth(p, 'acct-A', 'a@x.com');
    else await writeClaudeAuth(p, 'u1', 'o1', 'a@x.com');
    const withProfile = new AccountService({
      db,
      secrets: fakeSecretStore(),
      paths: p,
      providers: { codex: codexAuthProvider(p, { withAppProfile: true }), claude: claudeAuthProvider(p, { withAppProfile: true }) },
    });
    const { row } = await withProfile.saveCurrent(tool, 'prof');
    expect(row.scope).toBe('auth+app-profile');
  });

  it('a later auth-only save of the same identity resets scope to auth', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const withProfile = new AccountService({
      db, secrets: fakeSecretStore(), paths: p,
      providers: { codex: codexAuthProvider(p, { withAppProfile: true }), claude: claudeAuthProvider(p) },
    });
    await withProfile.saveCurrent('codex', 'work');
    expect((await svc.saveCurrent('codex', 'work')).row.scope).toBe('auth');
  });
});

describe('AccountService', () => {
  it('saves the currently logged-in account with an encrypted snapshot', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const { row, created } = await svc.saveCurrent('codex', 'work');
    expect(created).toBe(true);
    expect(row).toMatchObject({ tool: 'codex', accountId: 'acct-A', orgId: '', email: 'a@x.com', label: 'work' });
    expect(row.snapshotPath.startsWith(p.appDataDir)).toBe(true);
    expect((await fs.readFile(row.snapshotPath)).subarray(0, 5).toString()).toBe('FAKE:');
  });

  it('records a saved event so later sessions can be attributed to this account', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    const { row } = await svc.saveCurrent('codex', 'work');
    expect(db.listSwitches('codex')).toEqual([expect.objectContaining({ accountRowId: row.id, result: 'saved' })]);
  });

  it('loads a snapshot that restores the same identity', async () => {
    await writeClaudeAuth(p, 'acc-A', 'org-A', 'a@x.com');
    const { row } = await svc.saveCurrent('claude', 'personal');
    const bundle = await svc.loadSnapshot(row);
    expect(claudeAuthProvider(p).identityOf(bundle)).toMatchObject({ accountId: 'acc-A', orgId: 'org-A' });
  });

  it('refreshes the snapshot when the same identity is saved again', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r1');
    await svc.saveCurrent('codex', 'work');
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r2');
    const { row, created } = await svc.saveCurrent('codex', 'work');
    expect(created).toBe(false);
    expect(row.label).toBe('work');
    const auth = (await svc.loadSnapshot(row)).files[0]!;
    expect(JSON.parse(Buffer.from(auth.data!, 'base64').toString()).tokens.refresh_token).toBe('r2');
  });

  it('refuses to save under a different label when the identity is already registered elsewhere, leaving the stored snapshot untouched', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r1');
    const { row } = await svc.saveCurrent('codex', 'work');
    const before = await fs.readFile(row.snapshotPath);
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r2');
    await expect(svc.saveCurrent('codex', 'other-label')).rejects.toThrow("'work'");
    expect(await fs.readFile(row.snapshotPath)).toEqual(before);
  });

  it('fails when the tool is not logged in', async () => {
    await expect(svc.saveCurrent('codex', 'x')).rejects.toThrow('로그인');
  });

  it('rejects a different identity under an existing label and leaves no extra file', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com');
    await svc.saveCurrent('codex', 'work');
    await writeCodexAuth(p, 'acct-B', 'b@x.com');
    await expect(svc.saveCurrent('codex', 'work')).rejects.toThrow("'work'");
    const files = await fs.readdir(path.join(p.appDataDir, 'profiles', 'codex'));
    expect(files).toHaveLength(1);
  });

  it('keeps the previous snapshot as .prev.bin after a refresh', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r1');
    const { row } = await svc.saveCurrent('codex', 'work');
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r2');
    await svc.saveCurrent('codex', 'work');

    const prevPath = row.snapshotPath.replace(/\.bin$/, '.prev.bin');
    const prevBundle = deserializeBundle(await fakeSecretStore().decrypt(await fs.readFile(prevPath)));
    const auth = prevBundle.files[0]!;
    expect(JSON.parse(Buffer.from(auth.data!, 'base64').toString()).tokens.refresh_token).toBe('r1');
  });

  it('leaves the .bin and its .prev.bin sibling, and no .tmp leftovers, after two saves of the same identity', async () => {
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r1');
    const { row } = await svc.saveCurrent('codex', 'work');
    await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r2');
    await svc.saveCurrent('codex', 'work');
    const files = await fs.readdir(path.join(p.appDataDir, 'profiles', 'codex'));
    const base = path.basename(row.snapshotPath, '.bin');
    expect(files.sort()).toEqual([`${base}.bin`, `${base}.prev.bin`]);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  describe('rename', () => {
    it('renames a registered account', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await svc.saveCurrent('codex', 'work');
      const updated = await svc.rename('codex', 'work', 'main');
      expect(updated.label).toBe('main');
      expect(db.findAccountByLabel('codex', 'main')?.accountId).toBe('acct-A');
    });

    it('rejects renaming to a label already used by another account', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await svc.saveCurrent('codex', 'work');
      await writeCodexAuth(p, 'acct-B', 'b@x.com');
      await svc.saveCurrent('codex', 'personal');
      await expect(svc.rename('codex', 'work', 'personal')).rejects.toThrow("'personal'");
    });

    it('rejects an empty new label', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await svc.saveCurrent('codex', 'work');
      await expect(svc.rename('codex', 'work', '')).rejects.toThrow();
    });

    it('rejects a new label longer than 64 characters', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await svc.saveCurrent('codex', 'work');
      await expect(svc.rename('codex', 'work', 'x'.repeat(65))).rejects.toThrow();
    });

    it('throws for an unknown label', async () => {
      await expect(svc.rename('codex', 'nope', 'new')).rejects.toThrow("'nope'");
    });
  });

  describe('remove', () => {
    it('deletes the account row and its snapshot files, keeping switch_events with account_id NULL', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      const { row } = await svc.saveCurrent('codex', 'work');
      db.recordSwitch('codex', row.id, 'ok');
      await svc.remove('codex', 'work');
      expect(db.findAccountByLabel('codex', 'work')).toBeUndefined();
      expect(db.listSwitches('codex')).toEqual([
        { accountRowId: null, switchedAt: expect.any(String), result: 'saved' },
        { accountRowId: null, switchedAt: expect.any(String), result: 'ok' },
      ]);
      await expect(fs.stat(row.snapshotPath)).rejects.toThrow();
    });

    it('also removes the .prev.bin snapshot if present', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r1');
      const { row } = await svc.saveCurrent('codex', 'work');
      await writeCodexAuth(p, 'acct-A', 'a@x.com', 'r2');
      await svc.saveCurrent('codex', 'work'); // .prev.bin 생성
      const prevPath = row.snapshotPath.replace(/\.bin$/, '.prev.bin');
      await expect(fs.stat(prevPath)).resolves.toBeDefined();
      await svc.remove('codex', 'work');
      await expect(fs.stat(row.snapshotPath)).rejects.toThrow();
      await expect(fs.stat(prevPath)).rejects.toThrow();
    });

    it('never touches the live auth file', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      await svc.saveCurrent('codex', 'work');
      await svc.remove('codex', 'work');
      await expect(fs.stat(path.join(p.home, '.codex', 'auth.json'))).resolves.toBeDefined();
    });

    it('throws for an unknown label', async () => {
      await expect(svc.remove('codex', 'nope')).rejects.toThrow("'nope'");
    });

    it('succeeds even when the snapshot files are already missing', async () => {
      await writeCodexAuth(p, 'acct-A', 'a@x.com');
      const { row } = await svc.saveCurrent('codex', 'work');
      await fs.rm(row.snapshotPath);
      await expect(svc.remove('codex', 'work')).resolves.toBeUndefined();
    });
  });
});
