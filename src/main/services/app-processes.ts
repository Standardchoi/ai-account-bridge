import type { ProcInfo } from '../infra/process-controller.js';
import type { AppInfo } from '../providers/types.js';

// 마커 뒤가 경로 구분자/공백/따옴표/끝일 때만 일치 — '@openai/codex-sdk' 가 '@openai/codex' 로 잡히지 않게 한다.
function hasMarker(commandLine: string, marker: string): boolean {
  let from = 0;
  for (;;) {
    const i = commandLine.indexOf(marker, from);
    if (i < 0) return false;
    const next = commandLine[i + marker.length];
    if (next === undefined || next === '/' || /[\s"']/.test(next)) return true;
    from = i + 1;
  }
}

export function classifyProcesses(procs: ProcInfo[], app: AppInfo): { appProcs: ProcInfo[]; strayCli: ProcInfo[] } {
  const marker = app.packageDirMarker.toLowerCase();
  const managed = app.managedDirs.map((d) => d.toLowerCase().replace(/\\+$/, ''));
  const cliNames = app.cliNames.map((c) => c.toLowerCase());
  const appProcs = procs.filter((p) => {
    const lp = p.path.toLowerCase();
    return lp.includes(marker) || managed.some((d) => lp === d || lp.startsWith(d + '\\'));
  });
  const slashes = (s: string) => s.toLowerCase().split(String.fromCharCode(92)).join('/'); // 경로 구분자(역슬래시/슬래시)와 대소문자를 무시
  const markers = app.cliCommandMarkers.map(slashes);
  // npm 으로 설치한 CLI 는 node 프로세스로 뜨므로 명령줄에 패키지 이름이 있는지로 알아본다.
  const isNpmCli = (p: ProcInfo) =>
    p.name.toLowerCase() === 'node' && p.commandLine !== undefined && markers.some((m) => hasMarker(slashes(p.commandLine!), m));
  const strayCli = procs.filter((p) => !appProcs.includes(p) && (cliNames.includes(p.name.toLowerCase()) || isNpmCli(p)));
  return { appProcs, strayCli };
}
