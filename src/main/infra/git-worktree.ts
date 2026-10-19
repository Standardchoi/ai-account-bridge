import fs from 'node:fs';
import path from 'node:path';

// git worktree 안의 폴더면 원본 저장소 루트를 돌려준다. worktree 의 .git 은 폴더가 아니라
// 'gitdir: <원본>/.git/worktrees/<이름>' 한 줄짜리 파일이다. Codex 의 작업 트리 기능은 세션을
// C:\codex_home\worktrees\<id>\<저장소> 에서 돌리므로, 목록에서 원본 프로젝트와 묶을 때 쓴다.
export function mainWorktreeRoot(dir: string, maxUp = 3): string | null {
  if (!dir) return null;
  let cur = dir;
  for (let i = 0; i <= maxUp; i++) {
    const dotGit = path.join(cur, '.git');
    let text: string | undefined;
    try {
      text = fs.readFileSync(dotGit, 'utf8');
    } catch {
      if (fs.existsSync(dotGit)) return null; // .git 폴더 — 보통 저장소다
    }
    if (text !== undefined) {
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
      if (!gitdir) return null;
      const abs = path.resolve(cur, gitdir);
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      const at = abs.toLowerCase().lastIndexOf(marker);
      return at > 0 ? abs.slice(0, at) : null; // 서브모듈(.git/modules/…) 등은 작업 트리가 아니다
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}
