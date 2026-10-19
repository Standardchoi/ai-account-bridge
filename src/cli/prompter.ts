import type { EventEmitter } from 'node:events';

// readline/promises 의 Interface 중 여기서 쓰는 부분만 — 테스트에서 가짜로 갈아끼울 수 있게 좁혀 둔다.
export interface PromptReadline {
  question(query: string, opts: { signal: AbortSignal }): Promise<string>;
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface PrompterOptions {
  proc?: EventEmitter; // 기본 process — 비TTY 에서는 SIGINT 가 여기로 온다
  exit?: (code: number) => void;
  log?: (line: string) => void;
}

export interface Prompter {
  // 사용자가 입력한 문자열. Ctrl+C 로 취소됐으면 null.
  ask(query: string): Promise<string | null>;
  dispose(): void;
}

// 프롬프트 대기 중 첫 Ctrl+C 는 '취소' 응답으로 바꿔 서비스가 정상 aborted 경로(앱 재실행, 락 해제, DB 닫기)를
// 밟게 하고, 두 번째 Ctrl+C 는 즉시 종료(130)한다. 프롬프트가 없을 때 온 첫 Ctrl+C 도 기억해 두었다가 다음
// 프롬프트를 바로 취소로 처리한다. (TTY 에서는 readline 이 SIGINT 를 가로채 rl 에서, 아니면 process 에서 온다.)
export function createPrompter(rl: PromptReadline, opts: PrompterOptions = {}): Prompter {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  let sigints = 0;
  let pending: AbortController | null = null;

  const onSigint = (): void => {
    sigints++;
    if (sigints >= 2) {
      exit(130);
      return;
    }
    if (pending) {
      log('취소합니다…');
      pending.abort();
    } else {
      log('작업이 끝나면 취소합니다 (Ctrl+C 를 한 번 더 누르면 즉시 종료)');
    }
  };
  rl.on('SIGINT', onSigint);
  proc.on('SIGINT', onSigint);

  return {
    async ask(query) {
      if (sigints > 0) return null;
      const ctrl = new AbortController();
      pending = ctrl;
      try {
        return await rl.question(query, { signal: ctrl.signal });
      } catch (e) {
        if (ctrl.signal.aborted) return null;
        throw e;
      } finally {
        pending = null;
      }
    },
    dispose() {
      rl.off('SIGINT', onSigint);
      proc.off('SIGINT', onSigint);
    },
  };
}
