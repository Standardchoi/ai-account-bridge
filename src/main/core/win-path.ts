// Windows 경로 비교용 정규화. \\?\ 접두어(긴 경로 표기)와 끝 구분자를 제거한다.
export function normalizeWinPath(p: string): string {
  let s = p;
  if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
  else if (s.startsWith('\\\\?\\')) s = s.slice(4);
  const trimmed = s.replace(/[\\/]+$/, '');
  return trimmed === '' || /^[A-Za-z]:$/.test(trimmed) ? s : trimmed;
}

// Codex 가 저장하는 \\?\ 확장 경로 표기. UNC(\\server\share)는 \\?\UNC\server\share 로 바꾼다.
// '/' 는 '\' 로 바꾸고, 절대 경로(드라이브 X:\ 또는 UNC)만 접두어를 붙인다. 상대 경로는 그대로 돌려준다.
export function toExtendedPath(p: string): string {
  const n = normalizeWinPath(p.replace(/\//g, '\\'));
  if (/^\\\\[^\\]+\\[^\\]+/.test(n)) return `\\\\?\\UNC\\${n.slice(2)}`;
  if (/^[A-Za-z]:\\/.test(n)) return `\\\\?\\${n}`;
  return p;
}

export function samePathOrInside(child: string, parent: string): boolean {
  const c = normalizeWinPath(child).toLowerCase();
  const p = normalizeWinPath(parent).toLowerCase();
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

export function basenameOf(p: string): string {
  const parts = normalizeWinPath(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
