import { spawn } from 'node:child_process';

// Windows PowerShell 5.1 실행. 출력은 UTF-8 로 강제(한글 경로 깨짐 방지).
export function runPowerShell(script: string, stdin = '', timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ps.kill();
      reject(new Error(`powershell timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let out = '';
    let err = '';
    ps.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    ps.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    ps.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    ps.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`powershell exit ${code}: ${err.trim()}`));
    });
    ps.stdin.end(stdin);
  });
}
