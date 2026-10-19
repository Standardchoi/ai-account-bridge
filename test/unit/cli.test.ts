import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatAccountRow, formatInstructions, formatPathLines, formatSessionRow, parseImportArgs } from '../../src/cli/index.js';
import type { AccountRow } from '../../src/main/infra/app-db.js';

// 이 모듈을 import 해도 main() 이 돌지 않는다 (index.ts 의 entrypoint 가드) — 그래서 실제 머신을
// 건드리지 않고 안전하게 CLI 의 순수 포맷팅 로직만 테스트할 수 있다.
const row: AccountRow = {
  id: 1,
  tool: 'codex',
  accountId: 'acct-A',
  orgId: '',
  email: 'a@x.com',
  displayName: 'a@x.com',
  label: 'work',
  snapshotPath: 'C:\\snap\\codex\\abc123.bin',
  snapshotAt: '2026-01-01T00:00:00.000Z',
  status: 'ok',
  scope: 'auth',
};

describe('formatAccountRow', () => {
  it('includes the snapshot path as the last column, so .prev.bin can be matched to a label', () => {
    expect(formatAccountRow(row)).toBe('codex\twork\ta@x.com\tok\tauth\t2026-01-01T00:00:00.000Z\tC:\\snap\\codex\\abc123.bin');
  });
});

describe('formatAccountRow scope', () => {
  it('shows the scope column', () => {
    expect(formatAccountRow({ ...row, scope: 'auth+app-profile' }).split('	')[4]).toBe('auth+app-profile');
  });
});

describe('formatPathLines', () => {
  it('shows the app data dir and Claude Desktop dir with home shortened to ~', () => {
    const paths = {
      home: path.join('C:\U'),
      appData: path.join('C:\U', 'AppData', 'Roaming'),
      localAppData: path.join('C:\U', 'AppData', 'Local'),
      claudeDesktop: path.join('C:\U', 'AppData', 'Local', 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude'),
      appDataDir: path.join('C:\U', '.ai-account-bridge'),
    };
    expect(formatPathLines(paths)).toEqual([
      `# 앱 데이터: ${path.join('~', '.ai-account-bridge')}`,
      `# Claude Desktop: ${path.join('~', 'AppData', 'Local', 'Packages', 'Claude_x', 'LocalCache', 'Roaming', 'Claude')}`,
    ]);
  });
});

describe('formatSessionRow', () => {
  it('formats key, title, updatedAt (ISO) and hasTranscript, tab-separated', () => {
    const line = formatSessionRow({ key: 'codex:t1', title: '제목', updatedAt: Date.parse('2026-09-29T00:00:00.000Z'), hasTranscript: true });
    expect(line).toBe('codex:t1\t제목\t2026-09-29T00:00:00.000Z\ttrue');
  });

  it('truncates the title to the first 40 characters', () => {
    const longTitle = 'x'.repeat(50);
    const line = formatSessionRow({ key: 'codex:t2', title: longTitle, updatedAt: 0, hasTranscript: false });
    const [, title] = line.split('\t');
    expect(title).toBe('x'.repeat(40));
  });

  it('collapses embedded newlines/tabs in the title so one session stays on one output line', () => {
    const line = formatSessionRow({ key: 'codex:t3', title: '# Files mentioned\n\n## codex\t세부', updatedAt: 0, hasTranscript: true });
    expect(line.split('\n')).toHaveLength(1);
    expect(line.split('\t')).toHaveLength(4);
  });
});

describe('parseImportArgs', () => {
  it('parses keys up to the first --option, plus --to/--account/--copy', () => {
    const r = parseImportArgs(['codex', 'codex:1', 'codex:2', '--to', 'claude', '--account', 'work', '--copy']);
    expect(r).toEqual({ srcTool: 'codex', keys: ['codex:1', 'codex:2'], to: 'claude', account: 'work', copy: true, copyInstructions: false, copyWorkFolder: false, fullToolLog: false });
  });

  it('defaults account to undefined and copy to false when omitted', () => {
    const r = parseImportArgs(['codex', 'codex:1', '--to', 'codex']);
    expect(r).toEqual({ srcTool: 'codex', keys: ['codex:1'], to: 'codex', account: undefined, copy: false, copyInstructions: false, copyWorkFolder: false, fullToolLog: false });
  });

  it('parses --copy-instructions', () => {
    const r = parseImportArgs(['claude', 'claude:code:x', '--to', 'codex', '--copy-instructions']);
    expect(r.copyInstructions).toBe(true);
  });

  it('parses --copy-folder', () => {
    const r = parseImportArgs(['codex', 'codex:1', '--to', 'claude', '--copy-folder']);
    expect(r.copyWorkFolder).toBe(true);
  });

  it('parses --full-tool-log', () => {
    const r = parseImportArgs(['codex', 'codex:1', '--to', 'claude', '--full-tool-log']);
    expect(r.fullToolLog).toBe(true);
  });

  it('formats instruction results as 생성 / 이미 있음 / 건너뜀', () => {
    expect(formatInstructions({ path: 'C:\\p\\CLAUDE.md', status: 'created' })).toBe('C:\\p\\CLAUDE.md 생성');
    expect(formatInstructions({ path: 'C:\\p\\CLAUDE.md', status: 'exists' })).toBe('C:\\p\\CLAUDE.md 이미 있음');
    expect(formatInstructions({ path: 'C:\\p\\CLAUDE.md', status: 'skipped', reason: 'AGENTS.md 없음' })).toBe('C:\\p\\CLAUDE.md 건너뜀 (AGENTS.md 없음)');
  });

  it('rejects --to with no value at the end of the argument list', () => {
    expect(() => parseImportArgs(['codex', 'codex:1', '--to'])).toThrow('--to 뒤에 값이 필요합니다');
  });

  it('rejects --to immediately followed by another option (missing value)', () => {
    expect(() => parseImportArgs(['codex', 'codex:1', '--to', '--copy'])).toThrow('--to 뒤에 값이 필요합니다');
  });

  it('rejects --account with no value at the end of the argument list', () => {
    expect(() => parseImportArgs(['codex', 'codex:1', '--to', 'claude', '--account'])).toThrow('--account 뒤에 값이 필요합니다');
  });

  it('rejects --account immediately followed by another option (missing value)', () => {
    expect(() => parseImportArgs(['codex', 'codex:1', '--to', 'claude', '--account', '--copy'])).toThrow('--account 뒤에 값이 필요합니다');
  });

  it('rejects an unknown option', () => {
    expect(() => parseImportArgs(['codex', 'codex:1', '--bogus'])).toThrow('알 수 없는 옵션: --bogus');
  });

  it('rejects a missing --to', () => {
    expect(() => parseImportArgs(['codex', 'codex:1'])).toThrow('--to 는 codex 또는 claude 이어야 합니다');
  });

  it('rejects when no keys are given', () => {
    expect(() => parseImportArgs(['codex', '--to', 'claude'])).toThrow('가져올 세션 키가 최소 1개 필요합니다');
  });
});
