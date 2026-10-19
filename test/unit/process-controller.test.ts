import { describe, expect, it } from 'vitest';
import { parseProcessList, windowsProcessController } from '../../src/main/infra/process-controller.js';

describe('windowsProcessController pid validation', () => {
  it('kill rejects a non-integer pid before touching PowerShell', async () => {
    await expect(windowsProcessController().kill([1.5])).rejects.toThrow('invalid pid');
  });

  it('closeGracefully rejects a non-positive pid before touching PowerShell', async () => {
    await expect(windowsProcessController().closeGracefully([-1])).rejects.toThrow('invalid pid');
  });
});

describe('parseProcessList', () => {
  it('parses an array, skipping rows without ExecutablePath and keeping commandLine only when present', () => {
    const out = JSON.stringify([
      { pid: 1, name: 'node', path: 'C:/node.exe', commandLine: 'node a.js' },
      { pid: 2, name: 'System', path: null, commandLine: null },
      { pid: 3, name: 'x', path: 'C:/x.exe', commandLine: null },
      { pid: 4, name: 'y', path: '', commandLine: 'y' },
    ]);
    expect(parseProcessList(out)).toEqual([
      { pid: 1, name: 'node', path: 'C:/node.exe', commandLine: 'node a.js' },
      { pid: 3, name: 'x', path: 'C:/x.exe' },
    ]);
  });

  it('handles the single-object form PowerShell emits for one row, and empty output', () => {
    expect(parseProcessList('{"pid":5,"name":"a","path":"C:/a.exe","commandLine":"a -b"}')).toEqual([
      { pid: 5, name: 'a', path: 'C:/a.exe', commandLine: 'a -b' },
    ]);
    expect(parseProcessList('  ')).toEqual([]);
  });
});

describe('alive', () => {
  it('returns [] for no pids and rejects invalid pids before touching PowerShell', async () => {
    await expect(windowsProcessController().alive([])).resolves.toEqual([]);
    await expect(windowsProcessController().alive([0])).rejects.toThrow('invalid pid');
  });
});
