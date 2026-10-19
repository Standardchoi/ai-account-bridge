import { spawn } from 'node:child_process';
import { runPowerShell } from './powershell.js';

export interface ProcInfo {
  pid: number;
  name: string;
  path: string;
  commandLine?: string; // Win32_Process.CommandLine — 없거나 읽을 수 없으면 생략
}

export interface ProcessController {
  list(): Promise<ProcInfo[]>;
  alive(pids: number[]): Promise<number[]>; // 주어진 pid 중 아직 살아 있는 것 (list() 보다 훨씬 가볍다)
  closeGracefully(pids: number[]): Promise<void>; // 메인 창 닫기 요청 (트레이로 숨을 수 있음)
  kill(pids: number[]): Promise<void>;
  launch(aumid: string): Promise<void>;
}

// Get-CimInstance Win32_Process 의 JSON 출력을 ProcInfo[] 로 바꾼다. ExecutablePath 가 없는 프로세스는 건너뛴다.
export function parseProcessList(out: string): ProcInfo[] {
  if (!out.trim()) return [];
  const parsed = JSON.parse(out) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { pid?: unknown; name?: unknown; path?: unknown; commandLine?: unknown }[];
  const procs: ProcInfo[] = [];
  for (const r of rows) {
    if (typeof r.pid !== 'number' || typeof r.name !== 'string' || typeof r.path !== 'string' || r.path === '') continue;
    const proc: ProcInfo = { pid: r.pid, name: r.name, path: r.path };
    if (typeof r.commandLine === 'string' && r.commandLine !== '') proc.commandLine = r.commandLine;
    procs.push(proc);
  }
  return procs;
}

export function windowsProcessController(): ProcessController {
  return {
    async list() {
      // 한 번의 호출로 명령줄까지 가져온다. 이름은 Get-Process 처럼 확장자 없이 맞춘다.
      const out = await runPowerShell(
        'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ' +
          'Select-Object @{n="pid";e={[int]$_.ProcessId}},' +
          '@{n="name";e={[IO.Path]::GetFileNameWithoutExtension($_.Name)}},' +
          '@{n="path";e={$_.ExecutablePath}},@{n="commandLine";e={$_.CommandLine}} | ' +
          'ConvertTo-Json -Compress',
        '',
        60_000,
      );
      return parseProcessList(out);
    },
    async alive(pids) {
      if (pids.length === 0) return [];
      if (pids.some((p) => !Number.isInteger(p) || p <= 0)) throw new Error('invalid pid');
      const out = await runPowerShell(
        `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id; exit 0`,
      );
      return out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
    },
    async closeGracefully(pids) {
      if (pids.length === 0) return;
      if (pids.some((p) => !Number.isInteger(p) || p <= 0)) throw new Error('invalid pid');
      await runPowerShell(
        `foreach ($id in @(${pids.join(',')})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
          'if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }; exit 0',
      );
    },
    async kill(pids) {
      if (pids.length === 0) return;
      if (pids.some((p) => !Number.isInteger(p) || p <= 0)) throw new Error('invalid pid');
      await runPowerShell(`Stop-Process -Id ${pids.join(',')} -Force -ErrorAction SilentlyContinue; exit 0`);
    },
    async launch(aumid) {
      spawn('explorer.exe', [`shell:AppsFolder\\${aumid}`], { detached: true, stdio: 'ignore' }).unref();
    },
  };
}
