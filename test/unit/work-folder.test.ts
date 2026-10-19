import { describe, expect, it } from 'vitest';
import type { IrSession } from '../../src/main/core/ir.js';
import { claudeCopyOf, isCodexChatFolder, pickClaudeCwd, rebasePath, withCopiedFolder, withRebasedFolder } from '../../src/main/core/work-folder.js';

const FROM = 'C:\\Users\\u\\Documents\\Codex\\2026-06-29\\new-chat';
const TO = 'C:\\Users\\u\\Documents\\Claude\\2026-06-29\\new-chat';

describe('rebasePath', () => {
  it('rewrites the plain, JSON-escaped and forward-slash forms, case-insensitively', () => {
    expect(rebasePath('cd C:\\users\\U\\Documents\\codex\\2026-06-29\\NEW-CHAT\\work', FROM, TO)).toBe(`cd ${TO}\\work`);
    expect(rebasePath('{"workdir":"C:\\\\Users\\\\u\\\\Documents\\\\Codex\\\\2026-06-29\\\\new-chat"}', FROM, TO))
      .toBe('{"workdir":"C:\\\\Users\\\\u\\\\Documents\\\\Claude\\\\2026-06-29\\\\new-chat"}');
    expect(rebasePath('[보고서](C:/Users/u/Documents/Codex/2026-06-29/new-chat/outputs/a.md)', FROM, TO))
      .toBe('[보고서](C:/Users/u/Documents/Claude/2026-06-29/new-chat/outputs/a.md)');
    expect(rebasePath('\\\\?\\C:\\Users\\u\\Documents\\Codex\\2026-06-29\\new-chat', FROM, TO)).toBe(`\\\\?\\${TO}`);
  });

  it('only rewrites where the folder name ends — not a sibling like new-chat-2 or a file new-chat.zip', () => {
    const text = `${FROM}-2\\a.txt / ${FROM}.zip / ${FROM}에 만들었어요 / 폴더는 ${FROM}. / "${FROM}"`;
    expect(rebasePath(text, FROM, TO)).toBe(`${FROM}-2\\a.txt / ${FROM}.zip / ${TO}에 만들었어요 / 폴더는 ${TO}. / "${TO}"`);
  });
});

describe('withCopiedFolder', () => {
  it('rewrites text, tool input/output and summaries, and adds a leading note naming both folders', () => {
    const ir: IrSession = {
      tool: 'codex', sessionId: 's', cwd: FROM,
      stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 1 },
      messages: [
        { role: 'user', blocks: [{ kind: 'text', text: `${FROM}\\outputs 정리해 줘` }, { kind: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        { role: 'assistant', blocks: [{ kind: 'tool', name: 'shell', input: JSON.stringify({ workdir: FROM }), output: `${FROM}\\outputs\\a.md` }, { kind: 'compactSummary', text: `폴더 ${FROM}` }] },
      ],
    };
    const out = withCopiedFolder(ir, FROM, TO);
    expect(out.cwd).toBe(TO);
    expect(out.messages[0]!.blocks[0]).toMatchObject({ kind: 'text' });
    const note = (out.messages[0]!.blocks[0] as { text: string }).text;
    expect(note).toContain(FROM);
    expect(note).toContain(TO);
    expect(JSON.stringify(out.messages.slice(1))).not.toContain('Codex');
    expect(out.messages[1]!.blocks[1]).toEqual({ kind: 'image', mediaType: 'image/png', data: 'AAAA' });
    expect(ir.messages[0]!.blocks[0]).toEqual({ kind: 'text', text: `${FROM}\\outputs 정리해 줘` }); // 입력은 그대로
  });
});

// 같은 폴더의 다른 표기: C:\Users\olduser 은 C:\Users\me 로 가는 링크, Z: 는 네트워크 드라이브(다른 루트로 풀림)
const HUB = 'C:\\Users\\me\\Documents\\work\\multi-repo';
const HUB_ALIAS = 'C:\\Users\\olduser\\Documents\\work\\multi-repo';
const fakeReal = (p: string) => p.replace(/^C:\\Users\\olduser/i, 'C:\\Users\\me').replace(/^Z:\\/i, '\\\\nas\\share\\');

describe('withRebasedFolder', () => {
  it('rewrites the folder in text and tool blocks and the cwd, without adding a note', () => {
    const ir: IrSession = {
      tool: 'codex', sessionId: 's', cwd: HUB_ALIAS,
      stats: { droppedReasoning: 0, droppedSystem: 0, droppedSidechain: 0, unknownLines: 0, toolCalls: 1 },
      messages: [
        { role: 'user', blocks: [{ kind: 'text', text: `${HUB_ALIAS}\\app-backend 봐 줘` }] },
        { role: 'assistant', blocks: [{ kind: 'tool', name: 'shell', input: JSON.stringify({ workdir: HUB_ALIAS }), output: 'ok' }] },
      ],
    };
    const out = withRebasedFolder(ir, HUB_ALIAS, HUB);
    expect(out.cwd).toBe(HUB);
    expect(out.messages).toEqual([
      { role: 'user', blocks: [{ kind: 'text', text: `${HUB}\\app-backend 봐 줘` }] },
      { role: 'assistant', blocks: [{ kind: 'tool', name: 'shell', input: JSON.stringify({ workdir: HUB }), output: 'ok' }] },
    ]);
  });
});

describe('pickClaudeCwd', () => {
  it('uses the real path when Claude has no session in that folder yet', () => {
    expect(pickClaudeCwd(HUB_ALIAS, [], fakeReal)).toBe(HUB);
    expect(pickClaudeCwd(`${HUB}\\`, [], fakeReal)).toBe(HUB);
  });

  it('reuses the spelling of the most recent Claude session in the same folder', () => {
    const known = [{ cwd: HUB, updatedAt: 1 }, { cwd: HUB_ALIAS, updatedAt: 5 }, { cwd: 'C:\\other', updatedAt: 9 }, { cwd: '/sessions/x', updatedAt: 9 }];
    expect(pickClaudeCwd(HUB, known, fakeReal)).toBe(HUB_ALIAS);
    expect(pickClaudeCwd(HUB_ALIAS.toUpperCase(), known, fakeReal)).toBe(HUB_ALIAS);
  });

  it('keeps the recorded path when it would resolve onto another drive or is not a full path', () => {
    expect(pickClaudeCwd('Z:\\proj', [], fakeReal)).toBe('Z:\\proj');
    expect(pickClaudeCwd('C:proj', [], fakeReal)).toBe('C:proj');
    expect(pickClaudeCwd('/sessions/x', [], fakeReal)).toBe('/sessions/x');
  });
});

describe('GPT conversation folders', () => {
  it('recognises <Documents>\\Codex\\<date>\\<name> exactly (any Documents location, \\\\?\\ prefix allowed)', () => {
    expect(isCodexChatFolder('C:\\Users\\u\\Documents\\Codex\\2026-07-20\\ctx-bridge')).toBe(true);
    expect(isCodexChatFolder('\\\\?\\C:\\Users\\u\\OneDrive\\문서\\Codex\\2026-09-30\\new-chat-2')).toBe(true);
    expect(isCodexChatFolder('C:\\Users\\u\\Documents\\Codex\\2026-07-20\\ctx-bridge\\work')).toBe(false); // 안쪽 폴더
    expect(isCodexChatFolder('C:\\Users\\u\\Documents\\Codex\\2026-07-20')).toBe(false);
    expect(isCodexChatFolder('C:\\work\\ai-account-bridge')).toBe(false);
    expect(isCodexChatFolder('C:\\Users\\u\\.codex\\worktrees\\ab12\\repo')).toBe(false);
  });

  it('maps the copy next to it under Claude, keeping the date and name', () => {
    expect(claudeCopyOf('C:\\Users\\u\\Documents\\Codex\\2026-07-20\\ctx-bridge')).toBe('C:\\Users\\u\\Documents\\Claude\\2026-07-20\\ctx-bridge');
    expect(claudeCopyOf('\\\\?\\C:\\Users\\u\\Documents\\Codex\\2026-07-20\\a')).toBe('C:\\Users\\u\\Documents\\Claude\\2026-07-20\\a');
    expect(claudeCopyOf('C:\\work\\proj')).toBeUndefined();
  });
});
