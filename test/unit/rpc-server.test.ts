import { describe, expect, it } from 'vitest';
import { parseMessage, progressCtx } from '../../src/rpc/server.js';

// server.ts 는 이 모듈을 import 해도 main() 이 돌지 않는다 (cli/index.ts 와 동일한 entrypoint 가드) —
// 그래서 실제 stdin/stdout 을 건드리지 않고 줄 파서만 테스트할 수 있다.
describe('parseMessage', () => {
  it('ignores blank lines', () => {
    expect(parseMessage('')).toBeUndefined();
    expect(parseMessage('   ')).toBeUndefined();
  });

  it('does not throw on malformed JSON, returning undefined instead', () => {
    expect(() => parseMessage('{not json')).not.toThrow();
    expect(parseMessage('{not json')).toBeUndefined();
  });

  it('parses a valid JSON line', () => {
    expect(parseMessage('{"type":"request","id":1,"method":"state"}')).toEqual({ type: 'request', id: 1, method: 'state' });
  });
});

// progressCtx 는 handlers.handle() 에 넘기는 진행 상황 콜백을 만든다 — 실제 프로세스를 띄우지 않고
// id/step 이 올바른 형태의 { type: 'progress', ... } 줄로 나가는지만 검증한다.
describe('progressCtx', () => {
  it('sends a progress message carrying the request id and step', () => {
    const sent: unknown[] = [];
    const ctx = progressCtx(42, (msg) => sent.push(msg));
    ctx.progress('스냅샷 확인');
    expect(sent).toEqual([{ type: 'progress', id: 42, step: '스냅샷 확인' }]);
  });

  it('keeps a string request id as-is', () => {
    const sent: unknown[] = [];
    const ctx = progressCtx('req-1', (msg) => sent.push(msg));
    ctx.progress('앱 실행');
    expect(sent).toEqual([{ type: 'progress', id: 'req-1', step: '앱 실행' }]);
  });
});
