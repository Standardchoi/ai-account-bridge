import { describe, expect, it } from 'vitest';
import type { IrSession } from '../../src/main/core/ir.js';
import { blockToText, prepareForImport, TOOL_LINE_MAX, toolLine } from '../../src/main/core/render.js';

describe('toolLine', () => {
  it('picks what was done: shell command, file path, query, URL or task description', () => {
    expect(toolLine(JSON.stringify({ command: 'npm test', description: '테스트' }))).toBe('npm test');
    expect(toolLine(JSON.stringify({ command: ['git', 'status'] }))).toBe('git status');
    expect(toolLine(JSON.stringify({ file_path: 'C:\\w\\a.ts', old_string: 'x', new_string: 'y' }))).toBe('C:\\w\\a.ts');
    expect(toolLine(JSON.stringify({ type: 'search', query: 'tauri sidecar' }))).toBe('tauri sidecar');
    expect(toolLine(JSON.stringify({ type: 'open_page', url: 'https://x.dev' }))).toBe('https://x.dev');
    expect(toolLine(JSON.stringify({ description: '코드 조사', prompt: '긴 지시…', subagent_type: 'Explore' }))).toBe('코드 조사');
  });
  it('reads the cmd of a Codex exec code string and the files of an apply_patch', () => {
    expect(toolLine('text(await tools.exec_command({cmd:"rg -n \\"x\\" src", workdir:"C:\\\\w"}))')).toBe('rg -n "x" src');
    expect(toolLine('*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch')).toBe('patch: Update src/a.ts, Add src/b.ts');
  });
  it('falls back to the input with whitespace folded, clipped to the limit', () => {
    expect(toolLine('first\n  second')).toBe('first second');
    const long = toolLine('a'.repeat(500));
    expect(long).toHaveLength(TOOL_LINE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

const ir = (messages: IrSession['messages']): IrSession => ({
  tool: 'codex', sessionId: 's1', title: '버그 수정', cwd: 'C:\\w', messages,
  stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 0 },
});

describe('blockToText', () => {
  it('renders tool blocks as a readable summary', () => {
    expect(blockToText({ kind: 'tool', name: 'shell', input: '{"cmd":"ls"}', output: 'a.txt', isError: false }, 'codex'))
      .toBe('🔧 [Codex: shell] {"cmd":"ls"}\n→ a.txt');
    expect(blockToText({ kind: 'tool', name: 'Read', input: '{}', output: 'boom', isError: true }, 'claude'))
      .toBe('🔧 [Claude: Read] {}\n→ (오류) boom');
    expect(blockToText({ kind: 'tool', name: 'x', input: 'i' }, 'codex')).toBe('🔧 [Codex: x] i\n→ (결과 없음)');
  });
  it('renders compact summaries and import notices', () => {
    expect(blockToText({ kind: 'compactSummary', text: '요약' }, 'codex')).toBe('[이전 대화 요약]\n요약');
    expect(blockToText({ kind: 'importNotice', fromTool: 'codex', title: 't', sessionId: 'id1', createdAt: '2026-09-01T00:00:00.000Z' }, 'codex'))
      .toBe("이 세션은 Codex 의 't' 에서 가져왔습니다 (원본 ID id1, 2026-09-01T00:00:00.000Z)");
  });
});

describe('prepareForImport', () => {
  it('starts with a user message containing the import notice, merged with a leading user message', () => {
    const out = prepareForImport(ir([
      { role: 'user', timestamp: '2026-09-01T00:00:01.000Z', blocks: [{ kind: 'text', text: '고쳐줘' }] },
      { role: 'assistant', timestamp: '2026-09-01T00:00:02.000Z', blocks: [{ kind: 'text', text: 'ok' }] },
    ]), '2026-09-01T00:00:00.000Z');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(out[0]!.text).toBe("이 세션은 Codex 의 '버그 수정' 에서 가져왔습니다 (원본 ID s1, 2026-09-01T00:00:00.000Z)\n\n고쳐줘");
    // 안내 메시지 자체는 타임스탬프가 없으므로 병합된 첫 메시지의 타임스탬프를 물려받는다.
    expect(out[0]!.timestamp).toBe('2026-09-01T00:00:01.000Z');
    expect(out[1]!.timestamp).toBe('2026-09-01T00:00:02.000Z');
  });
  it('inserts the notice as its own user message when the transcript starts with the assistant', () => {
    const out = prepareForImport(ir([{ role: 'assistant', timestamp: '2026-09-01T00:00:05.000Z', blocks: [{ kind: 'text', text: 'hi' }] }]), 'T');
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant']);
    // 서로 다른 role 이라 병합되지 않지만, 안내 메시지는 여전히 첫 실제 메시지의 타임스탬프를 물려받는다.
    expect(out[0]!.timestamp).toBe('2026-09-01T00:00:05.000Z');
    expect(out[1]!.timestamp).toBe('2026-09-01T00:00:05.000Z');
  });
  it('joins blocks of one message with blank lines and drops empty messages (full tool log)', () => {
    const out = prepareForImport(ir([
      { role: 'user', blocks: [{ kind: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'a' }, { kind: 'tool', name: 'n', input: 'i', output: 'o' }] },
      { role: 'user', blocks: [{ kind: 'text', text: '   ' }] },
    ]), 'T', 'full');
    expect(out).toHaveLength(2);
    expect(out[1]!.text).toBe('a\n\n🔧 [Codex: n] i\n→ o');
    expect(out[0]!.text).not.toContain('도구 실행 기록'); // 전부 옮기면 요약 안내를 붙이지 않는다
  });
  it('summarises tool calls by default: one line each, output only for failures (clipped), with a note in the notice', () => {
    const out = prepareForImport(ir([
      { role: 'user', blocks: [{ kind: 'text', text: 'q' }] },
      { role: 'assistant', blocks: [
        { kind: 'text', text: '확인할게요' },
        { kind: 'tool', name: 'exec', input: 'text(await tools.exec_command({cmd:"git status --short", workdir:"C:\\\\w"}))', output: '긴 결과', isError: false },
        { kind: 'tool', name: 'shell_command', input: JSON.stringify({ command: 'npm test', workdir: 'C:\\w' }), output: `Exit code: 1\n${'x'.repeat(500)}`, isError: true },
        { kind: 'text', text: '실패를 고칠게요' },
      ] },
    ]), 'T');
    expect(out[0]!.text).toContain('(도구 실행 기록은 실행한 명령·파일만 한 줄씩, 실패한 경우에만 결과 앞부분을 옮겼습니다)');
    const lines = out[1]!.text.split('\n');
    expect(lines[0]).toBe('확인할게요');
    expect(lines[2]).toBe('🔧 [Codex: exec] git status --short'); // 앞 글과는 빈 줄, 도구 줄끼리는 바로 이어진다
    expect(lines[3]).toBe('🔧 [Codex: shell_command] npm test');
    expect(lines[4]!.startsWith('→ (오류) Exit code: 1')).toBe(true);
    expect(lines[4]!.length).toBeLessThanOrEqual('→ (오류) '.length + 300);
    expect(out[1]!.text).not.toContain('긴 결과');
    expect(out[1]!.text.endsWith('\n\n실패를 고칠게요')).toBe(true);
  });
  it('adds no summary note when the session has no tool calls', () => {
    const out = prepareForImport(ir([{ role: 'user', blocks: [{ kind: 'text', text: 'q' }] }]), 'T');
    expect(out[0]!.text).not.toContain('도구 실행 기록');
  });
  it('keeps the earliest timestamp when merging consecutive same-role messages', () => {
    const out = prepareForImport(ir([
      { role: 'user', blocks: [{ kind: 'text', text: 'q1' }] },
      { role: 'assistant', timestamp: '2026-09-01T00:00:10.000Z', blocks: [{ kind: 'text', text: 'a1' }] },
      { role: 'assistant', timestamp: '2026-09-01T00:00:05.000Z', blocks: [{ kind: 'text', text: 'a2' }] },
    ]), 'T');
    expect(out).toHaveLength(2);
    expect(out[1]!.text).toBe('a1\n\na2');
    // 병합 시 더 이른 타임스탬프를 유지한다.
    expect(out[1]!.timestamp).toBe('2026-09-01T00:00:05.000Z');
  });
  it('carries user images next to the text, merges them with the notice, keeps image-only messages, and marks assistant images', () => {
    const img = (d: string) => ({ kind: 'image' as const, mediaType: 'image/png', data: d });
    const out = prepareForImport(ir([
      { role: 'user', blocks: [{ kind: 'text', text: '이거 봐' }, img('A1')] },
      { role: 'assistant', blocks: [{ kind: 'text', text: '봤어요' }, img('X')] },
      { role: 'user', blocks: [img('B1'), img('B2')] },
    ]), 'T');
    expect(out).toHaveLength(3);
    expect(out[0]!.text.endsWith('\n\n이거 봐')).toBe(true);
    expect(out[0]!.images).toEqual([{ mediaType: 'image/png', data: 'A1' }]);
    expect(out[1]).toEqual({ role: 'assistant', text: '봤어요\n\n[이미지]', timestamp: undefined });
    expect(out[2]).toEqual({ role: 'user', text: '', images: [{ mediaType: 'image/png', data: 'B1' }, { mediaType: 'image/png', data: 'B2' }], timestamp: undefined });
    expect(blockToText(img('Z'), 'codex')).toBe('[이미지]');
  });
});
