import { describe, expect, it } from 'vitest';
import { basenameOf, normalizeWinPath, samePathOrInside, toExtendedPath } from '../../src/main/core/win-path.js';

describe('win-path', () => {
  it('strips the \\\\?\\ prefix and trailing separators', () => {
    expect(normalizeWinPath('\\\\?\\C:\\codex_home\\sessions\\')).toBe('C:\\codex_home\\sessions');
    expect(normalizeWinPath('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\srv\\share\\x');
    expect(normalizeWinPath('/home/me/x/')).toBe('/home/me/x');
  });
  it('writes the extended form: \\\\?\\ for drive paths, \\\\?\\UNC\\ for UNC paths, idempotent on prefixed input', () => {
    expect(toExtendedPath('C:\\work\\x')).toBe('\\\\?\\C:\\work\\x');
    expect(toExtendedPath('\\\\srv\\share\\x')).toBe('\\\\?\\UNC\\srv\\share\\x');
    expect(toExtendedPath('\\\\?\\UNC\\srv\\share\\x')).toBe('\\\\?\\UNC\\srv\\share\\x');
    expect(toExtendedPath('\\\\?\\C:\\work\\x')).toBe('\\\\?\\C:\\work\\x');
  });
  it('converts forward slashes and leaves relative or non-absolute paths unchanged', () => {
    expect(toExtendedPath('C:/x')).toBe('\\\\?\\C:\\x');
    expect(toExtendedPath('C:/work/sub/')).toBe('\\\\?\\C:\\work\\sub');
    expect(toExtendedPath('//srv/share/x')).toBe('\\\\?\\UNC\\srv\\share\\x');
    expect(toExtendedPath('rel\\x')).toBe('rel\\x');
    expect(toExtendedPath('rel/x')).toBe('rel/x');
    expect(toExtendedPath('/home/u/x')).toBe('/home/u/x');
    expect(toExtendedPath('')).toBe('');
  });
  it('matches a path equal to or inside a parent, case-insensitively, on a separator boundary', () => {
    expect(samePathOrInside('\\\\?\\C:\\Users\\A\\proj\\src', 'c:\\users\\a\\proj')).toBe(true);
    expect(samePathOrInside('C:\\Users\\A\\proj', 'C:\\Users\\A\\proj\\')).toBe(true);
    expect(samePathOrInside('C:\\Users\\A\\project2', 'C:\\Users\\A\\proj')).toBe(false);
  });
  it('returns the last path segment', () => {
    expect(basenameOf('\\\\?\\C:\\Users\\A\\multi-repo')).toBe('multi-repo');
    expect(basenameOf('/sessions/practical-laughing-shannon')).toBe('practical-laughing-shannon');
  });
});
