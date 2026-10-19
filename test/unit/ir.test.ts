import { describe, expect, it } from 'vitest';
import { IrBuilder, truncate } from '../../src/main/core/ir.js';

describe('truncate', () => {
  it('keeps short text and marks cut text with the omitted length', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcde… (3자 생략)');
  });
});

describe('IrBuilder', () => {
  it('merges consecutive blocks of the same role into one message', () => {
    const b = new IrBuilder('codex', 's1');
    b.text('user', 'hi', 't1');
    b.text('assistant', 'a', 't2');
    b.text('assistant', 'b', 't3');
    const s = b.build();
    expect(s.messages.map((m) => [m.role, m.blocks.length])).toEqual([['user', 1], ['assistant', 2]]);
  });
  it('pairs tool calls with outputs by id and counts them', () => {
    const b = new IrBuilder('claude', 's1');
    b.toolCall('c1', 'shell', '{"cmd":"ls"}');
    b.toolOutput('c1', 'file.txt', false);
    b.toolOutput('missing', 'ignored', false);
    const s = b.build();
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: 'tool', name: 'shell', input: '{"cmd":"ls"}', output: 'file.txt', isError: false });
    expect(s.stats.toolCalls).toBe(1);
  });
  it('pairs a tool output that arrives before its call (out-of-order jsonl)', () => {
    const b = new IrBuilder('claude', 's1');
    b.toolOutput('c1', 'result', false);
    b.toolCall('c1', 'shell', '{"cmd":"ls"}');
    const s = b.build();
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: 'tool', name: 'shell', input: '{"cmd":"ls"}', output: 'result', isError: false });
    expect(s.stats.toolCalls).toBe(1);
  });
  it('truncates long tool input/output', () => {
    const b = new IrBuilder('codex', 's1');
    b.toolCall('c1', 'x', 'i'.repeat(3000));
    b.toolOutput('c1', 'o'.repeat(3000), false);
    const blk = b.build().messages[0]!.blocks[0] as { input: string; output: string };
    expect(blk.input.length).toBeLessThan(2100);
    expect(blk.output).toContain('자 생략');
  });
});
