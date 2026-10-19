import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPrompter, type PromptReadline } from '../../src/cli/prompter.js';

// question 은 사용자가 답할 때(answer) 또는 signal 이 abort 될 때 끝나는 가짜 readline.
function fakeRl() {
  const rl = new EventEmitter() as EventEmitter & PromptReadline & { answer(s: string): void };
  let resolve: ((s: string) => void) | undefined;
  rl.question = (_q, { signal }) =>
    new Promise<string>((res, rej) => {
      resolve = res;
      signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  rl.answer = (s) => resolve?.(s);
  return rl;
}

function setup() {
  const rl = fakeRl();
  const proc = new EventEmitter();
  const exit = vi.fn();
  const log = vi.fn();
  const prompter = createPrompter(rl, { proc, exit, log });
  return { rl, proc, exit, log, prompter };
}

describe('createPrompter', () => {
  it('returns the typed answer when not interrupted', async () => {
    const { rl, prompter } = setup();
    const p = prompter.ask('q? ');
    rl.answer('y');
    expect(await p).toBe('y');
  });

  it('resolves a pending prompt as null on SIGINT and prints the cancel notice', async () => {
    const { proc, log, exit, prompter } = setup();
    const p = prompter.ask('q? ');
    proc.emit('SIGINT');
    expect(await p).toBeNull();
    expect(log).toHaveBeenCalledWith('취소합니다…');
    expect(exit).not.toHaveBeenCalled();
  });

  it('also reacts to the readline SIGINT event (TTY raw mode)', async () => {
    const { rl, prompter } = setup();
    const p = prompter.ask('q? ');
    rl.emit('SIGINT');
    expect(await p).toBeNull();
  });

  it('exits with 130 on the second SIGINT', async () => {
    const { proc, exit, prompter } = setup();
    const p = prompter.ask('q? ');
    proc.emit('SIGINT');
    await p;
    expect(exit).not.toHaveBeenCalled();
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('answers later prompts as cancelled after an interrupt with no prompt pending', async () => {
    const { proc, log, prompter } = setup();
    proc.emit('SIGINT');
    expect(log).toHaveBeenCalledWith('작업이 끝나면 취소합니다 (Ctrl+C 를 한 번 더 누르면 즉시 종료)');
    expect(await prompter.ask('q? ')).toBeNull();
  });

  it('dispose removes the listeners', () => {
    const { rl, proc, prompter } = setup();
    prompter.dispose();
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(rl.listenerCount('SIGINT')).toBe(0);
  });
});
