import { describe, expect, it } from 'vitest';
import type { ProcInfo } from '../../src/main/infra/process-controller.js';
import type { AppInfo } from '../../src/main/providers/types.js';
import { classifyProcesses } from '../../src/main/services/app-processes.js';

const claudeApp: AppInfo = {
  aumid: 'Claude_pzs8sxrjxfjjc!Claude',
  packageDirMarker: '\\WindowsApps\\Claude_',
  managedDirs: ['C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code'],
  cliNames: ['claude'],
  cliCommandMarkers: ['@anthropic-ai/claude-code'],
};

const procs: ProcInfo[] = [
  { pid: 1, name: 'claude', path: 'C:\\Program Files\\WindowsApps\\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc\\app\\claude.exe' },
  { pid: 2, name: 'claude', path: 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.280\\claude.exe' },
  { pid: 3, name: 'claude', path: 'C:\\Users\\u\\.local\\bin\\claude.exe' },
  { pid: 4, name: 'notepad', path: 'C:\\Windows\\notepad.exe' },
];

describe('classifyProcesses', () => {
  it('separates app (incl. app-managed children) from standalone CLI processes', () => {
    const { appProcs, strayCli } = classifyProcesses(procs, claudeApp);
    expect(appProcs.map((p) => p.pid)).toEqual([1, 2]);
    expect(strayCli.map((p) => p.pid)).toEqual([3]);
  });

  it('matches paths case-insensitively', () => {
    const upper = [{ pid: 9, name: 'CLAUDE', path: 'C:\\PROGRAM FILES\\WINDOWSAPPS\\CLAUDE_2\\APP\\CLAUDE.EXE' }];
    expect(classifyProcesses(upper, claudeApp).appProcs).toHaveLength(1);
  });

  it('does not treat a sibling dir sharing a managed-dir prefix as managed', () => {
    const sibling = [
      { pid: 10, name: 'x', path: 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code-vm\\x.exe' },
    ];
    const { appProcs, strayCli } = classifyProcesses(sibling, claudeApp);
    expect(appProcs.map((p) => p.pid)).toEqual([]);
    expect(strayCli.map((p) => p.pid)).toEqual([]);
  });

  it('treats a node process whose command line names the tool package as a stray CLI', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules';
    const list: ProcInfo[] = [
      { pid: 20, name: 'node', path: node, commandLine: `"${node}" ${npm}\\@anthropic-ai\\claude-code\\cli.js` },
      { pid: 21, name: 'node', path: node, commandLine: `node ${npm}\\@openai\\codex\\bin\\codex.js` }, // 다른 도구
      { pid: 22, name: 'node', path: node, commandLine: 'node server.js' },
      { pid: 23, name: 'node', path: node }, // 명령줄을 읽지 못함
      { pid: 24, name: 'Node', path: node, commandLine: `node --x ${npm}\\@ANTHROPIC-AI\\Claude-Code\\cli.js` }, // 대소문자 무관
    ];
    expect(classifyProcesses(list, claudeApp).strayCli.map((p) => p.pid)).toEqual([20, 24]);
  });

  it('requires a boundary after the marker (claude-code-router / codex-sdk do not match; quote and end do)', () => {
    const node = 'C:\\Program Files\\nodejs\\node.exe';
    const cmd = (commandLine: string, pid: number): ProcInfo => ({ pid, name: 'node', path: node, commandLine });
    const list = [
      cmd('node C:\\n\\node_modules\\@anthropic-ai\\claude-code-router\\x.js', 1),
      cmd('node C:\\n\\node_modules\\@anthropic-ai\\claude-code\\cli.js', 2),
      cmd('node "@anthropic-ai/claude-code"', 3),
      cmd('node @anthropic-ai/claude-code', 4),
      cmd('node @anthropic-ai/claude-code-sdk x', 5),
    ];
    expect(classifyProcesses(list, claudeApp).strayCli.map((p) => p.pid)).toEqual([2, 3, 4]);
  });

  it('does not report a node process under the app managed dirs as a stray CLI', () => {
    const managedNode: ProcInfo = {
      pid: 30,
      name: 'node',
      path: 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.280\\node.exe',
      commandLine: 'node @anthropic-ai/claude-code/cli.js',
    };
    const { appProcs, strayCli } = classifyProcesses([managedNode], claudeApp);
    expect(appProcs.map((p) => p.pid)).toEqual([30]);
    expect(strayCli).toEqual([]);
  });

  it('matches cliNames case-insensitively', () => {
    const appWithUpperCliNames: AppInfo = { ...claudeApp, cliNames: ['Claude'] };
    const stray = [{ pid: 11, name: 'claude', path: 'C:\\Users\\u\\.local\\bin\\claude.exe' }];
    expect(classifyProcesses(stray, appWithUpperCliNames).strayCli.map((p) => p.pid)).toEqual([11]);
  });
});
