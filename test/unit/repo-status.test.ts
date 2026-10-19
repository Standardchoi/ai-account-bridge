import { describe, expect, it } from 'vitest';
import type { IrSession } from '../../src/main/core/ir.js';
import { STATUS_LINES_MAX, repoStatusNote, withRepoStatus } from '../../src/main/core/repo-status.js';

const HEAD = '[작업 폴더 상태] 가져올 때의 git 저장소 상태입니다(git status 기준). 이어서 작업하기 전에 참고하세요.';

describe('repoStatusNote', () => {
  it('lists each repo with its branch and uncommitted changes (multi-repo layout)', () => {
    expect(
      repoStatusNote([
        { rel: 'app-agent', branch: 'master', changes: [] },
        { rel: 'app-backend', branch: 'feat/new-api', changes: ['M app/api/router.py', '?? migrations/versions/x.py'] },
        { rel: 'app-docs', changes: undefined },
      ]),
    ).toBe(
      [
        HEAD,
        '- app-agent (master): 커밋하지 않은 변경 없음',
        '- app-backend (feat/new-api): M app/api/router.py, ?? migrations/versions/x.py',
        '- app-docs: 변경 목록을 읽지 못했습니다',
      ].join('\n'),
    );
  });

  it('calls the folder itself "작업 폴더" and caps long change lists', () => {
    const changes = Array.from({ length: STATUS_LINES_MAX + 3 }, (_, i) => `M f${i}.ts`);
    const note = repoStatusNote([{ rel: '', branch: 'main', changes }])!;
    expect(note.split('\n')[1]).toBe(`- 작업 폴더 (main): ${changes.slice(0, STATUS_LINES_MAX).join(', ')} 외 3개`);
  });

  it('returns undefined when there is no repo', () => {
    expect(repoStatusNote([])).toBeUndefined();
  });
});

describe('withRepoStatus', () => {
  const ir: IrSession = {
    tool: 'codex', sessionId: 's', cwd: 'C:\\w', messages: [{ role: 'user', blocks: [{ kind: 'text', text: '질문' }] }],
    stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 },
  };

  it('puts the note before the conversation as a user message', () => {
    const out = withRepoStatus(ir, [{ rel: '', branch: 'main', changes: [] }]);
    expect(out.messages).toEqual([
      { role: 'user', blocks: [{ kind: 'text', text: `${HEAD}\n- 작업 폴더 (main): 커밋하지 않은 변경 없음` }] },
      ...ir.messages,
    ]);
  });

  it('leaves the session as is when there is no repo', () => {
    expect(withRepoStatus(ir, [])).toBe(ir);
  });
});
