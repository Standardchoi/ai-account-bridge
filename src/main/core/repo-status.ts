import type { IrSession } from './ir.js';

export interface RepoInfo { rel: string; branch?: string } // rel: 작업 폴더 기준 '/' 경로, 작업 폴더 자신은 ''
export interface WorkspaceScan { repos: RepoInfo[]; instructionFiles: string[] } // instructionFiles: 작업 폴더 기준 '/' 경로
export interface RepoStatus extends RepoInfo { changes?: string[] } // changes: git status --porcelain 줄, 읽지 못했으면 없음

export const STATUS_LINES_MAX = 20;

// 옮긴 대화 첫머리에 붙이는 '[작업 폴더 상태]'. 하위 저장소를 여럿 모은 폴더(예: multi-repo)는 상위 폴더가 git 저장소가
// 아니어서 한 번에 볼 수 없으므로 저장소마다 브랜치와 커밋하지 않은 변경을 적는다. 저장소가 없으면 undefined.
export function repoStatusNote(statuses: RepoStatus[]): string | undefined {
  if (statuses.length === 0) return undefined;
  const lines = statuses.map((s) => {
    const name = `${s.rel === '' ? '작업 폴더' : s.rel}${s.branch ? ` (${s.branch})` : ''}`;
    if (s.changes === undefined) return `- ${name}: 변경 목록을 읽지 못했습니다`;
    if (s.changes.length === 0) return `- ${name}: 커밋하지 않은 변경 없음`;
    const more = s.changes.length > STATUS_LINES_MAX ? ` 외 ${s.changes.length - STATUS_LINES_MAX}개` : '';
    return `- ${name}: ${s.changes.slice(0, STATUS_LINES_MAX).join(', ')}${more}`;
  });
  return ['[작업 폴더 상태] 가져올 때의 git 저장소 상태입니다(git status 기준). 이어서 작업하기 전에 참고하세요.', ...lines].join('\n');
}

export function withRepoStatus(ir: IrSession, statuses: RepoStatus[]): IrSession {
  const note = repoStatusNote(statuses);
  return note ? { ...ir, messages: [{ role: 'user', blocks: [{ kind: 'text', text: note }] }, ...ir.messages] } : ir;
}
