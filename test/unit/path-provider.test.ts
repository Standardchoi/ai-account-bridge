import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { displayPath, resolveRoot, systemPaths } from '../../src/main/infra/path-provider.js';

describe('systemPaths', () => {
  it('uses USERPROFILE / APPDATA / LOCALAPPDATA', () => {
    const p = systemPaths({ USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\R', LOCALAPPDATA: 'C:\\U\\L' });
    expect(p).toEqual({
      home: 'C:\\U',
      appData: 'C:\\U\\R',
      localAppData: 'C:\\U\\L',
      claudeDesktop: path.join('C:\\U\\R', 'Claude'),
      appDataDir: path.join('C:\\U', '.ai-account-bridge'),
    });
  });

  it('derives AppData folders from home when env vars are missing', () => {
    const p = systemPaths({ USERPROFILE: 'C:\\U' });
    expect(p.appData).toBe(path.join('C:\\U', 'AppData', 'Roaming'));
    expect(p.localAppData).toBe(path.join('C:\\U', 'AppData', 'Local'));
  });
});

describe('resolveRoot', () => {
  it('joins a root with a slash-separated relative path', () => {
    const p = systemPaths({ USERPROFILE: 'C:\\U', APPDATA: 'C:\\U\\R', LOCALAPPDATA: 'C:\\U\\L' });
    expect(resolveRoot(p, 'home', '.codex/auth.json')).toBe(path.join('C:\\U', '.codex', 'auth.json'));
  });
});

describe('displayPath', () => {
  it('shortens paths under home to ~ and leaves others alone', () => {
    expect(displayPath(path.join('C:\\U', '.ai-account-bridge'), 'C:\\U')).toBe(path.join('~', '.ai-account-bridge'));
    expect(displayPath('C:\\U', 'C:\\U')).toBe('~');
    expect(displayPath('D:\\other', 'C:\\U')).toBe('D:\\other');
  });
});
