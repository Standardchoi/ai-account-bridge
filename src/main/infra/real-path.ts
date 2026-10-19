import fs from 'node:fs';
import path from 'node:path';

// 심볼릭 링크·정션을 풀어 실제 경로로 만든다 (예: 사용자 폴더 이름을 바꾸고 남긴 C:\Users\olduser → C:\Users\me).
// 없는 경로는 존재하는 상위 폴더까지만 풀고 나머지를 이어 붙인다. 풀 수 없으면 그대로 돌려준다.
export function canonicalPath(p: string): string {
  if (!p) return p;
  let head = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.push(path.basename(head));
      head = parent;
    }
  }
  return p;
}
