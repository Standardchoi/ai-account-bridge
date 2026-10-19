import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readAppIcon } from '../../src/main/infra/app-icons.js';
import { tmpPaths, writeFile } from '../helpers/tmp-paths.js';

let dir: string;
beforeEach(async () => {
  dir = path.join((await tmpPaths()).home, 'pkg');
});

const manifest = (logo: string) => `<Package><Applications><Application><uap:VisualElements Square44x44Logo="${logo}" /></Application></Applications></Package>`;
const dataUri = (s: string) => `data:image/png;base64,${Buffer.from(s).toString('base64')}`;

describe('readAppIcon', () => {
  it('prefers the 64px light-background variant of the Square44x44 logo', async () => {
    await writeFile(path.join(dir, 'AppxManifest.xml'), manifest('Assets\\Square44x44Logo.png'));
    await writeFile(path.join(dir, 'Assets', 'Square44x44Logo.png'), 'base');
    await writeFile(path.join(dir, 'Assets', 'Square44x44Logo.targetsize-64_altform-unplated.png'), 'dark');
    await writeFile(path.join(dir, 'Assets', 'Square44x44Logo.targetsize-64_altform-lightunplated.png'), 'light64');
    expect(await readAppIcon('Pkg_abc', async () => dir)).toBe(dataUri('light64'));
  });

  it('falls back to the plain logo file and accepts forward slashes in the manifest', async () => {
    await writeFile(path.join(dir, 'AppxManifest.xml'), manifest('assets/Square44x44Logo.png'));
    await writeFile(path.join(dir, 'assets', 'Square44x44Logo.png'), 'base');
    expect(await readAppIcon('Pkg_abc', async () => dir)).toBe(dataUri('base'));
  });

  it('returns null when the app is not installed or has no usable logo', async () => {
    expect(await readAppIcon('Pkg_abc', async () => null)).toBeNull();
    expect(await readAppIcon('Pkg_abc', async () => { throw new Error('powershell failed'); })).toBeNull();
    await writeFile(path.join(dir, 'AppxManifest.xml'), '<Package />');
    expect(await readAppIcon('Pkg_abc', async () => dir)).toBeNull();
  });
});
