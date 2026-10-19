import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAuth, bundleScope, clearedBundle, collectAuth } from '../../src/main/infra/auth-fs.js';
import type { PathProvider } from '../../src/main/infra/path-provider.js';
import { exists, readText, tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let p: PathProvider;
beforeEach(async () => { p = await tmpPaths(); });

describe('collectAuth / applyAuth', () => {
  it('captures a file and restores it later', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    await writeFile(f, 'A');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    await writeFile(f, 'B');
    await applyAuth(p, snap);
    expect(await readText(f)).toBe('A');
  });

  it('records a missing file as null and deletes it on apply', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    expect(snap.files[0]?.data).toBeNull();
    await writeFile(f, 'B');
    await applyAuth(p, snap);
    expect(await exists(f)).toBe(false);
  });

  it('replaces a whole directory (no stale files left behind)', async () => {
    const dir = path.join(p.appData, 'Claude', 'Local Storage');
    await writeFile(path.join(dir, 'leveldb', '000001.log'), 'A1');
    const snap = await collectAuth(p, 'claude', [{ root: 'appData', relPath: 'Claude/Local Storage' }]);
    expect(snap.replaceDirs).toEqual([{ root: 'appData', relPath: 'Claude/Local Storage' }]);
    await writeFile(path.join(dir, 'leveldb', '000002.log'), 'B-extra');
    await applyAuth(p, snap);
    expect(await readText(path.join(dir, 'leveldb', '000001.log'))).toBe('A1');
    expect(await exists(path.join(dir, 'leveldb', '000002.log'))).toBe(false);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('removes its .aab-tmp file if the write fails, then rethrows', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    (snap.files[0] as { data: string | null }).data = Buffer.from('X').toString('base64');
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('EBUSY'));
    await expect(applyAuth(p, snap)).rejects.toThrow('EBUSY');
    renameSpy.mockRestore();
    expect(await exists(`${f}.aab-tmp`)).toBe(false);
  });

  it('skips stray .aab-tmp files left behind by a previous interrupted write', async () => {
    const dir = path.join(p.appData, 'Claude', 'Local Storage');
    await writeFile(path.join(dir, 'leveldb', '000001.log'), 'A1');
    await writeFile(path.join(dir, 'leveldb', '000002.log.aab-tmp'), 'stale-partial-write');
    const snap = await collectAuth(p, 'claude', [{ root: 'appData', relPath: 'Claude/Local Storage' }]);
    const relPaths = snap.files.map((f) => f.relPath);
    expect(relPaths).toContain('Claude/Local Storage/leveldb/000001.log');
    expect(relPaths.some((r) => r.endsWith('.aab-tmp'))).toBe(false);
  });

  it('swaps only one top-level JSON key and preserves the others', async () => {
    const f = path.join(p.home, '.claude.json');
    await writeFile(f, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: 'A' } }));
    const snap = await collectAuth(p, 'claude', [], [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount' }]);
    await writeFile(f, JSON.stringify({ numStartups: 9, oauthAccount: { accountUuid: 'B' } }));
    await applyAuth(p, snap);
    expect(JSON.parse(await readText(f))).toEqual({ numStartups: 9, oauthAccount: { accountUuid: 'A' } });
  });

  it('removes the JSON key when the snapshot had none', async () => {
    const f = path.join(p.home, '.claude.json');
    await writeFile(f, JSON.stringify({ numStartups: 1 }));
    const snap = await collectAuth(p, 'claude', [], [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount' }]);
    await writeFile(f, JSON.stringify({ numStartups: 1, oauthAccount: { accountUuid: 'B' } }));
    await applyAuth(p, snap);
    expect(JSON.parse(await readText(f))).toEqual({ numStartups: 1 });
  });

  it('does not create a JSON file just to delete a key that was never there', async () => {
    const f = path.join(p.home, '.claude.json');
    const snap = await collectAuth(p, 'claude', [], [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount' }]);
    expect(await exists(f)).toBe(false);
    await applyAuth(p, snap);
    expect(await exists(f)).toBe(false);
  });
});

describe('bundleScope', () => {
  const authSpec = { root: 'home', relPath: '.codex/auth.json' } as const;
  const profileSpec = { root: 'localAppData', relPath: 'OpenAI/Codex/Network' } as const;

  it('is the same whether a profile directory exists on disk or is missing', async () => {
    const withoutDir = await collectAuth(p, 'codex', [authSpec, profileSpec]);
    await writeFile(path.join(p.localAppData, 'OpenAI', 'Codex', 'Network', 'Cookies'), 'C');
    const withDir = await collectAuth(p, 'codex', [authSpec, profileSpec]);
    expect(bundleScope(withDir)).toEqual(bundleScope(withoutDir));
  });

  it('changes when a profile spec is added', async () => {
    const authOnly = await collectAuth(p, 'codex', [authSpec]);
    const withProfile = await collectAuth(p, 'codex', [authSpec, profileSpec]);
    expect(bundleScope(withProfile)).not.toEqual(bundleScope(authOnly));
  });
});

describe('clearedBundle', () => {
  it('nulls every file while preserving the bundle scope', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    await writeFile(f, 'A');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    const cleared = clearedBundle(snap);
    expect(cleared.tool).toBe('codex');
    expect(cleared.replaceDirs).toEqual(snap.replaceDirs);
    expect(cleared.files).toEqual([{ root: 'home', relPath: '.codex/auth.json', data: null }]);
    expect(bundleScope(cleared)).toEqual(bundleScope(snap));
  });

  it('nulls every json key value while preserving the bundle scope', async () => {
    const f = path.join(p.home, '.claude.json');
    await writeFile(f, JSON.stringify({ numStartups: 3, oauthAccount: { accountUuid: 'A' } }));
    const snap = await collectAuth(p, 'claude', [], [{ root: 'home', relPath: '.claude.json', key: 'oauthAccount' }]);
    const cleared = clearedBundle(snap);
    expect(cleared.jsonKeys).toEqual([{ root: 'home', relPath: '.claude.json', key: 'oauthAccount', value: null }]);
    expect(bundleScope(cleared)).toEqual(bundleScope(snap));
  });

  it('applying a cleared bundle removes the files it covers', async () => {
    const f = path.join(p.home, '.codex', 'auth.json');
    await writeFile(f, 'A');
    const snap = await collectAuth(p, 'codex', [{ root: 'home', relPath: '.codex/auth.json' }]);
    await applyAuth(p, clearedBundle(snap));
    expect(await exists(f)).toBe(false);
  });
});
